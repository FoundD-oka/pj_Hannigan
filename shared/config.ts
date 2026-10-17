// Config loading, validation and migration. See docs/design/01-config-schema.md.
// Every user-specific value lives in $HANNIGAN_HOME/{hub,worker}.json; this file only holds defaults.
// hub.json is version 8 (01 §3) and worker.json version 2 (01 §4). Older files are migrated in memory,
// backed up to `<file>.bak-v<old>-<timestamp>` and rewritten (01 §10).
import { z } from 'zod'
import { copyFileSync, existsSync, readFileSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, join, resolve, sep } from 'path'
import { writeJsonAtomic } from './util.ts'

export const HUB_CONFIG_VERSION = 8
export const WORKER_CONFIG_VERSION = 2

export const ID_RE = /^[A-Za-z0-9_-]{1,32}$/
const id = z.string().regex(ID_RE, 'letters, digits, - and _ only (1-32 chars)')

export function hanniganHome(): string {
  return expandHome(process.env.HANNIGAN_HOME ?? join(homedir(), '.hannigan'))
}

export function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

// path from the config: `~` and a leading `$HANNIGAN_HOME` are expanded, relative paths are taken from home
export function resolveHomePath(home: string, p: string): string {
  let x = p
  if (x === '$HANNIGAN_HOME' || x.startsWith('$HANNIGAN_HOME/')) x = home + x.slice('$HANNIGAN_HOME'.length)
  x = expandHome(x)
  return isAbsolute(x) ? resolve(x) : resolve(home, x)
}

const promptPolicy = z.enum(['relay', 'auto_accept'])

function sessionSpec(d: { builtin_tools: string | null; allowed_tools: string[] }) {
  return z
    .object({
      permission_mode: z.enum(['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']).default('manual'),
      model: z.string().nullable().default(null),
      builtin_tools: z.string().nullable().default(d.builtin_tools),
      allowed_tools: z.array(z.string()).default(d.allowed_tools),
      extra_args: z.array(z.string()).default([]),
      env: z.record(z.string(), z.string()).default({}),
      terminal_prompts: z
        .object({
          dev_channel_warning: promptPolicy.default('relay'),
          workspace_trust: promptPolicy.default('relay'),
          other: z.literal('relay').default('relay'),
        })
        .prefault({}),
    })
    .prefault({})
}
// worker task sessions (role=task): built-in tools as configured by Claude Code, reply tool pre-approved
export const SessionSpecSchema = sessionSpec({ builtin_tools: null, allowed_tools: ['mcp__hannigan__reply'] })
// secretary: routing only, no built-in tools, hub tools pre-approved
export const SecretarySpecSchema = sessionSpec({ builtin_tools: '', allowed_tools: ['mcp__hannigan'] })
// project PM (role=pm, 01 §4.2): built-in tools kept, PM local tools pre-approved
export const PM_ALLOWED_TOOLS = [
  'mcp__hannigan__reply',
  'mcp__hannigan__task_list',
  'mcp__hannigan__task_create',
  'mcp__hannigan__task_resume',
  'mcp__hannigan__task_send',
  'mcp__hannigan__task_interrupt',
  'mcp__hannigan__task_stop',
  'mcp__hannigan__work_item_create',
  'mcp__hannigan__work_item_update',
]
export const PmSessionSpecSchema = sessionSpec({ builtin_tools: null, allowed_tools: PM_ALLOWED_TOOLS })
export type SessionSpec = z.infer<typeof SessionSpecSchema>

const tmuxSchema = z
  .object({
    prefix: id.default('hn'),
    width: z.number().int().min(80).max(400).default(160),
    height: z.number().int().min(24).max(200).default(48),
  })
  .prefault({})

const posInt = (name: string) =>
  z.number({ error: `${name} must be a positive integer` }).int(`${name} must be a positive integer`).positive(`${name} must be a positive integer`)

// ---------------------------------------------------------------- hub.json v8 (01 §3)
export const HubConfigSchema = z.object({
  version: z.literal(HUB_CONFIG_VERSION),
  listen: z
    .object({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().min(1).max(65535).default(8800),
    })
    .prefault({}),
  public_url: z.string().nullable().default(null),
  secretary: z
    .object({
      project_dir: z.string().nullable().default(null), // null -> $HANNIGAN_HOME/secretary
      autostart: z.boolean().default(false),
      session: SecretarySpecSchema,
      contexts: z
        .object({
          mode: z.enum(['per_conversation']).default('per_conversation'),
          root_dir: z.string().nullable().default(null), // null -> $HANNIGAN_HOME/secretary/contexts
          max_active: posInt('max_active').default(8),
          max_pending_per_context: posInt('max_pending_per_context').default(100),
          idle_minutes: posInt('idle_minutes').default(30),
        })
        .prefault({}),
      shared_ledger: z
        .object({
          enabled: z.boolean().default(true),
          events_path: z.string().nullable().default(null), // null -> $HANNIGAN_HOME/hub/work-items.jsonl
        })
        .prefault({}),
      // 01 §3.1: who the secretary is for the person. Added 2026-10-17 (Phase 5 brought forward); all keys default,
      // so a v8 file without `persona` keeps loading unchanged.
      persona: z
        .object({
          name: z.string().trim().min(1).max(40).default('Hannigan'),
          character: z.string().max(4000).default(''),
          user_name: z.string().trim().max(40).nullable().default(null),
          language: z.string().trim().max(40).default(''), // '' -> the language the person uses
          verbosity: z.enum(['short', 'normal', 'detailed']).default('short'),
        })
        .prefault({}),
      routing_notes: z.string().max(4000).default(''), // how to pick a worker / project (Phase 5 「振り分けの判断基準」)
      extra_instructions: z.string().default(''),
    })
    .prefault({}),
  workers: z
    .array(
      z.object({
        id,
        display_name: z.string().nullable().default(null),
        role: z.string().default(''),
      }),
    )
    .default([]),
  offline_queue: z
    .object({
      enabled: z.boolean().default(false),
      // Q13/C: omitted -> 1440; explicit null / 0 / negative / non-integer is an error (never an unlimited queue)
      ttl_minutes: posInt('offline_queue.ttl_minutes').default(1440),
      max_pending_per_worker: posInt('max_pending_per_worker').default(100),
      events_path: z.string().nullable().default(null), // null -> $HANNIGAN_HOME/hub/offline-requests.jsonl
    })
    .prefault({}),
  log: z
    .object({
      max_events_replay: z.number().int().min(10).default(2000),
      max_thread_history_page: posInt('max_thread_history_page').default(200),
    })
    .prefault({}),
  webchat: z
    .object({
      conversation_scope: z.enum(['conversation']).default('conversation'),
      threads: z
        .object({
          enabled: z.boolean().default(true),
          direct_send_enabled: z.boolean().default(true),
        })
        .prefault({}),
    })
    .prefault({}),
  // parsed and validated now; enabling it is refused until Phase 7
  discord: z
    .object({
      enabled: z.boolean().default(false),
      bot_token_file: z.string().nullable().default(null), // null -> $HANNIGAN_HOME/secrets/discord-bot-token
      allowed_user_ids: z.array(z.string().min(1).max(64)).default([]), // Discord ids stay strings
      allowed_channel_ids: z.array(z.string().min(1).max(64)).default([]), // Discord ids stay strings
      shared_ledger_visibility: z.enum(['none', 'all_allowed_channels']).default('none'),
      channel_trigger: z.enum(['mention_or_bot_reply', 'mention_only', 'disabled']).default('mention_or_bot_reply'),
      work_request_policy: z.enum(['disabled', 'allowed_users_via_secretary']).default('disabled'),
    })
    .prefault({}),
  tmux: tmuxSchema,
  claude_bin: z.string().default('claude'),
  bun_bin: z.string().default('bun'),
})
export type HubConfig = z.infer<typeof HubConfigSchema>

// ---------------------------------------------------------------- worker.json v2 (01 §4)
export const ExecutionPolicySchema = z.enum(['delegate_only', 'hybrid', 'direct_first'])
export type ExecutionPolicy = z.infer<typeof ExecutionPolicySchema>

export const ProjectPmSchema = z
  .object({
    enabled: z.boolean().default(true),
    autostart: z.boolean().default(false),
    execution_policy: ExecutionPolicySchema.default('hybrid'),
    extra_instructions: z.string().default(''),
  })
  .prefault({})

export const WorkerConfigSchema = z.object({
  version: z.literal(WORKER_CONFIG_VERSION),
  worker_id: id,
  hub_url: z.string().default('ws://127.0.0.1:8800/ws/worker'),
  local: z
    .object({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().min(1).max(65535).default(8801),
    })
    .prefault({}),
  projects: z
    .array(z.object({ id, path: z.string().min(1), description: z.string().default(''), pm: ProjectPmSchema }))
    .default([]),
  pm_session: PmSessionSpecSchema,
  session: SessionSpecSchema,
  max_sessions: z.number().int().min(1).max(32).default(4),
  tmux: tmuxSchema,
  claude_bin: z.string().default('claude'),
  bun_bin: z.string().default('bun'),
  outbox: z.object({ max_events: z.number().int().min(100).default(5000) }).prefault({}),
  thread_observation: z
    .object({
      mode: z.enum(['transcript', 'reports_only']).default('transcript'),
      redact_sensitive: z.boolean().default(true),
    })
    .prefault({}),
})
export type WorkerConfig = z.infer<typeof WorkerConfigSchema>
export type ProjectConfig = WorkerConfig['projects'][number]

export class ConfigError extends Error {}

// absolute path with symlinks resolved when it exists (macOS: /var -> /private/var), so that
// folder comparisons match what Claude Code reports as its working directory
export function canonical(p: string): string {
  const abs = resolve(expandHome(p))
  try {
    return realpathSync(abs)
  } catch {
    return abs
  }
}

// ---------------------------------------------------------------- migration (01 §10)
export type Migration<T = Record<string, unknown>> = {
  from: number // version found in the file
  to: number
  changed: boolean // false when the file was already current
  config: T // migrated raw config (not yet validated / defaulted)
  warnings: string[]
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

function versionOf(file: string, raw: unknown): number {
  if (!isObj(raw)) throw new ConfigError(`${file}: the top level must be a JSON object`)
  const v = raw.version
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new ConfigError(`${file}: version must be a positive integer`)
  return v
}

// hub v1..v7 -> v8. Pure: returns the migrated raw object or throws ConfigError.
// v2..v7 were never implemented (design drafts); they are read like v1 plus the draft keys below.
export function migrateHubConfig(raw: unknown): Migration {
  const from = versionOf('hub.json', raw)
  if (from > HUB_CONFIG_VERSION)
    throw new ConfigError(`hub.json: version ${from} is newer than this Hannigan supports (${HUB_CONFIG_VERSION})`)
  const c = clone(raw as Obj)
  const warnings: string[] = []
  if (from === HUB_CONFIG_VERSION) return { from, to: from, changed: false, config: c, warnings }
  if (from > 1) warnings.push(`hub.json: version ${from} is an unimplemented draft; migrated as v1-compatible`)

  // conversation state (01 §10 "会話状態の移行"): the single always-on secretary becomes per-conversation
  if (c.secretary !== undefined && !isObj(c.secretary)) throw new ConfigError('hub.json: secretary must be an object')
  const sec = (c.secretary ?? {}) as Obj
  if (sec.autostart === true) warnings.push('hub.json: secretary.autostart true -> false (secretaries now start per conversation)')
  sec.autostart = false
  c.secretary = sec

  // v7 -> v8: the offline queue is added disabled; a Q12 draft's ttl null is normalized only when disabled
  if (c.offline_queue !== undefined && !isObj(c.offline_queue)) throw new ConfigError('hub.json: offline_queue must be an object')
  const oq = (c.offline_queue ?? {}) as Obj
  if (oq.enabled === undefined) oq.enabled = false
  if (oq.ttl_minutes === null) {
    if (oq.enabled === true)
      throw new ConfigError('hub.json: offline_queue.enabled is true but ttl_minutes is null. Set a positive number of minutes (default 1440).')
    warnings.push('hub.json: offline_queue.ttl_minutes null -> 1440 (no unlimited queue)')
    oq.ttl_minutes = 1440
  } else if (oq.ttl_minutes === undefined) oq.ttl_minutes = 1440
  c.offline_queue = oq

  if (c.discord !== undefined) {
    if (!isObj(c.discord)) throw new ConfigError('hub.json: discord must be an object')
    const d = c.discord
    // v6 -> v7: DM support is removed; an enabled DM setting needs the administrator
    if (d.allow_dm === true)
      throw new ConfigError('hub.json: discord.allow_dm=true is no longer supported (DMs are refused, Q10/A). Remove it after reviewing DM routes.')
    if ('allow_dm' in d) {
      delete d.allow_dm
      warnings.push('hub.json: removed discord.allow_dm=false (DMs are always refused)')
    }
    if ('context_scope' in d) {
      delete d.context_scope
      warnings.push('hub.json: removed discord.context_scope (server channels only)')
    }
    // v4 -> v5: require_mention_in_channels is replaced by channel_trigger
    if ('require_mention_in_channels' in d) {
      if (d.require_mention_in_channels !== true)
        throw new ConfigError(
          'hub.json: discord.require_mention_in_channels=false cannot be migrated automatically. Remove it and set discord.channel_trigger explicitly.',
        )
      delete d.require_mention_in_channels
      if (d.channel_trigger === undefined) d.channel_trigger = 'mention_or_bot_reply'
      warnings.push('hub.json: discord.require_mention_in_channels=true -> channel_trigger "mention_or_bot_reply"')
    }
    // v3 -> v4 / v5 -> v6: safe defaults (shared_ledger_visibility none, work_request_policy disabled) come from the schema
  }
  c.version = HUB_CONFIG_VERSION
  return { from, to: HUB_CONFIG_VERSION, changed: true, config: c, warnings }
}

// worker v1 -> v2. Pure.
export function migrateWorkerConfig(raw: unknown): Migration {
  const from = versionOf('worker.json', raw)
  if (from > WORKER_CONFIG_VERSION)
    throw new ConfigError(`worker.json: version ${from} is newer than this Hannigan supports (${WORKER_CONFIG_VERSION})`)
  const c = clone(raw as Obj)
  const warnings: string[] = []
  if (from === WORKER_CONFIG_VERSION) return { from, to: from, changed: false, config: c, warnings }
  if (c.projects !== undefined && !Array.isArray(c.projects)) throw new ConfigError('worker.json: projects must be an array')
  for (const p of (c.projects ?? []) as unknown[]) {
    if (!isObj(p)) continue // reported by validation
    const pm = isObj(p.pm) ? p.pm : {}
    pm.enabled ??= true
    pm.autostart ??= false
    pm.execution_policy ??= 'hybrid'
    pm.extra_instructions ??= ''
    p.pm = pm
  }
  if (c.pm_session === undefined) c.pm_session = { permission_mode: 'manual' }
  if (c.thread_observation === undefined) c.thread_observation = { mode: 'transcript', redact_sensitive: true }
  c.version = WORKER_CONFIG_VERSION
  warnings.push('worker.json: v1 -> v2 (project PM enabled with execution_policy "hybrid"; existing sessions become role=task)')
  return { from, to: WORKER_CONFIG_VERSION, changed: true, config: c, warnings }
}

// ---------------------------------------------------------------- loading
// unknown keys are ignored (forward compatibility) but reported, also inside nested objects
function shapeOf(schema: unknown): Record<string, unknown> | null {
  let s = schema as { _zod?: { def?: { innerType?: unknown } } } | undefined
  for (let i = 0; i < 8 && s; i++) {
    if (s instanceof z.ZodObject) return s.shape as Record<string, unknown>
    s = s._zod?.def?.innerType as typeof s
  }
  return null
}
function elementOf(schema: unknown): unknown {
  let s = schema as { _zod?: { def?: { innerType?: unknown } } } | undefined
  for (let i = 0; i < 8 && s; i++) {
    if (s instanceof z.ZodArray) return s.element
    s = s._zod?.def?.innerType as typeof s
  }
  return null
}
function unknownKeys(raw: unknown, schema: unknown, path: string, out: string[]): void {
  const shape = shapeOf(schema)
  if (shape && isObj(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      const p = path ? `${path}.${k}` : k
      if (!(k in shape)) out.push(p)
      else unknownKeys(v, shape[k], p, out)
    }
    return
  }
  const el = elementOf(schema)
  if (el && Array.isArray(raw)) raw.forEach((v, i) => unknownKeys(v, el, `${path}[${i}]`, out))
}

function readRaw(file: string): unknown {
  if (!existsSync(file)) throw new ConfigError(`config not found: ${file}`)
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    throw new ConfigError(`${file}: invalid JSON: ${(e as Error).message}`)
  }
}

function validate<T>(file: string, raw: unknown, schema: z.ZodType<T>): T {
  const unknown: string[] = []
  unknownKeys(raw, schema, '', unknown)
  for (const k of unknown) process.stderr.write(`hannigan: ${file}: unknown key "${k}" ignored\n`)
  const r = schema.safeParse(raw)
  if (!r.success) {
    const lines = r.error.issues.map(i => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
    throw new ConfigError(`${file}: invalid config\n${lines.join('\n')}`)
  }
  return r.data
}

export type MigrationInfo = { from: number; to: number; backup: string; warnings: string[] }

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')

// back up the original file, then write the migrated one atomically (only after it validated)
// A read-only or full disk must not stop the program: on failure it warns and runs on the migrated config in
// memory (the file stays at the old version and is migrated again on the next start).
function persistMigration(file: string, m: Migration): MigrationInfo {
  for (const w of m.warnings) process.stderr.write(`hannigan: ${w}\n`)
  let backup = `${file}.bak-v${m.from}-${stamp()}`
  try {
    for (let i = 1; existsSync(backup); i++) backup = `${file}.bak-v${m.from}-${stamp()}-${i}`
    copyFileSync(file, backup)
    writeJsonAtomic(file, m.config)
  } catch (e) {
    const warning = `could not save the migrated ${file} (${(e as Error).message}); running on the migrated settings in memory, the file is unchanged`
    process.stderr.write(`hannigan: warning: ${warning}\n`)
    return { from: m.from, to: m.to, backup: '', warnings: [...m.warnings, warning] }
  }
  process.stderr.write(`hannigan: migrated ${file} v${m.from} -> v${m.to} (backup: ${backup})\n`)
  return { from: m.from, to: m.to, backup, warnings: m.warnings }
}

// rules that are not expressible in the schema (01 §3, §10)
export function checkHubConfig(raw: unknown, c: HubConfig, file = 'hub.json'): void {
  const ids = new Set<string>()
  for (const w of c.workers) {
    if (ids.has(w.id)) throw new ConfigError(`${file}: duplicate worker id "${w.id}"`)
    ids.add(w.id)
  }
  const d = isObj(raw) && isObj(raw.discord) ? raw.discord : {}
  if ('allow_dm' in d) throw new ConfigError(`${file}: discord.allow_dm is not supported in version 8 (DMs are always refused). Remove it.`)
  if (c.discord.enabled) throw new ConfigError(`${file}: discord is implemented in Phase 7; set discord.enabled to false`)
}

export type LoadedHubConfig = HubConfig & {
  home: string
  stateDir: string // $HANNIGAN_HOME/hub
  secretaryDir: string // secretary.project_dir, canonical
  contextsDir: string // secretary.contexts.root_dir
  ledgerPath: string // secretary.shared_ledger.events_path
  offlineQueuePath: string // offline_queue.events_path
  discordTokenFile: string // discord.bot_token_file
  migration: MigrationInfo | null
}

export function loadHubConfig(home = hanniganHome()): LoadedHubConfig {
  const file = join(home, 'hub.json')
  const raw = readRaw(file)
  const m = migrateHubConfig(raw)
  const c = validate(file, m.config, HubConfigSchema)
  checkHubConfig(m.config, c, file)
  const migration = m.changed ? persistMigration(file, m) : null
  const secretaryDir = canonical(resolveHomePath(home, c.secretary.project_dir ?? '$HANNIGAN_HOME/secretary'))
  const contextsDir = resolveHomePath(home, c.secretary.contexts.root_dir ?? '$HANNIGAN_HOME/secretary/contexts')
  const ledgerPath = resolveHomePath(home, c.secretary.shared_ledger.events_path ?? '$HANNIGAN_HOME/hub/work-items.jsonl')
  const offlineQueuePath = resolveHomePath(home, c.offline_queue.events_path ?? '$HANNIGAN_HOME/hub/offline-requests.jsonl')
  const discordTokenFile = resolveHomePath(home, c.discord.bot_token_file ?? '$HANNIGAN_HOME/secrets/discord-bot-token')
  // keep the config fields consistent with the resolved values
  c.secretary.project_dir = secretaryDir
  c.secretary.contexts.root_dir = contextsDir
  c.secretary.shared_ledger.events_path = ledgerPath
  c.offline_queue.events_path = offlineQueuePath
  c.discord.bot_token_file = discordTokenFile
  return {
    ...c,
    home,
    stateDir: join(home, 'hub'),
    secretaryDir,
    contextsDir,
    ledgerPath,
    offlineQueuePath,
    discordTokenFile,
    migration,
  }
}

// One workspace = one write lease (02 §18): two projects must not share a folder or sit one inside the
// other, because a write in the inner folder would only be checked against one of the two leases.
// the first pair of projects whose (canonical) folders are the same or nested, or null
export function overlappingProjects<P extends { id: string; path: string }>(projects: P[]): [P, P] | null {
  const inside = (a: string, b: string) => a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)
  for (let i = 0; i < projects.length; i++)
    for (let j = i + 1; j < projects.length; j++) {
      const a = projects[i]!
      const b = projects[j]!
      if (inside(a.path, b.path) || inside(b.path, a.path)) return [a, b]
    }
  return null
}
export function checkProjectPaths(projects: { id: string; path: string }[], file = 'worker.json'): void {
  const hit = overlappingProjects(projects)
  if (hit)
    throw new ConfigError(
      `${file}: projects "${hit[0].id}" and "${hit[1].id}" use the same or nested folders (after resolving links). Give each project its own folder that is not inside another project's folder.`,
    )
}

export type LoadedWorkerConfig = WorkerConfig & {
  home: string
  stateDir: string // $HANNIGAN_HOME/worker
  migration: MigrationInfo | null
}

export function loadWorkerConfig(home = hanniganHome()): LoadedWorkerConfig {
  const file = join(home, 'worker.json')
  const raw = readRaw(file)
  const m = migrateWorkerConfig(raw)
  const c = validate(file, m.config, WorkerConfigSchema)
  const ids = new Set<string>()
  for (const p of c.projects) {
    if (ids.has(p.id)) throw new ConfigError(`${file}: duplicate project id "${p.id}"`)
    ids.add(p.id)
  }
  const migration = m.changed ? persistMigration(file, m) : null
  for (const p of c.projects) p.path = canonical(p.path)
  checkProjectPaths(c.projects, file)
  return { ...c, home, stateDir: join(home, 'worker'), migration }
}
