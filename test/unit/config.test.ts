import { expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ConfigError,
  loadHubConfig,
  loadWorkerConfig,
  migrateHubConfig,
  migrateWorkerConfig,
  PM_ALLOWED_TOOLS,
} from '../../shared/config.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'hn-cfg-'))
const writeHub = (d: string, c: unknown) => writeFileSync(join(d, 'hub.json'), JSON.stringify(c))
const writeWorker = (d: string, c: unknown) => writeFileSync(join(d, 'worker.json'), JSON.stringify(c))
const readBack = (f: string) => JSON.parse(readFileSync(f, 'utf8'))
const errOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError)
    return (e as Error).message
  }
  throw new Error('expected a ConfigError')
}

// ---------------------------------------------------------------- hub v8
test('hub v8 defaults and resolved paths', () => {
  const d = tmp()
  writeHub(d, { version: 8 })
  const c = loadHubConfig(d)
  expect(c.migration).toBeNull()
  expect(c.listen).toEqual({ host: '127.0.0.1', port: 8800 })
  expect(c.public_url).toBeNull()
  expect(c.secretary.autostart).toBe(false)
  expect(c.secretary.session.builtin_tools).toBe('')
  expect(c.secretary.session.allowed_tools).toEqual(['mcp__hannigan'])
  expect(c.secretary.session.terminal_prompts.dev_channel_warning).toBe('relay')
  expect(c.secretary.contexts).toMatchObject({ mode: 'per_conversation', max_active: 8, max_pending_per_context: 100, idle_minutes: 30 })
  expect(c.secretary.shared_ledger.enabled).toBe(true)
  expect(c.secretary.extra_instructions).toBe('')
  // persona (01 §3.1): a file without it loads with the Hannigan defaults
  expect(c.secretary.persona).toEqual({ name: 'Hannigan', character: '', user_name: null, language: '', verbosity: 'short' })
  expect(c.secretary.routing_notes).toBe('')
  expect(c.offline_queue).toMatchObject({ enabled: false, ttl_minutes: 1440, max_pending_per_worker: 100 })
  expect(c.log).toEqual({ max_events_replay: 2000, max_thread_history_page: 200 })
  expect(c.webchat).toEqual({ conversation_scope: 'conversation', threads: { enabled: true, direct_send_enabled: true } })
  expect(c.discord).toMatchObject({
    enabled: false,
    allowed_user_ids: [],
    allowed_channel_ids: [],
    shared_ledger_visibility: 'none',
    channel_trigger: 'mention_or_bot_reply',
    work_request_policy: 'disabled',
  })
  expect(c.secretaryDir.endsWith('secretary')).toBe(true)
  expect(c.stateDir).toBe(join(d, 'hub'))
  expect(c.contextsDir).toBe(join(d, 'secretary', 'contexts'))
  expect(c.ledgerPath).toBe(join(d, 'hub', 'work-items.jsonl'))
  expect(c.offlineQueuePath).toBe(join(d, 'hub', 'offline-requests.jsonl'))
  expect(c.discordTokenFile).toBe(join(d, 'secrets', 'discord-bot-token'))
  expect(c.offline_queue.events_path).toBe(c.offlineQueuePath)
})

test('hub paths: $HANNIGAN_HOME, relative and ~ are resolved', () => {
  const d = tmp()
  writeHub(d, {
    version: 8,
    secretary: { contexts: { root_dir: 'ctx' }, shared_ledger: { events_path: '$HANNIGAN_HOME/x/ledger.jsonl' } },
    offline_queue: { events_path: '~/q.jsonl' },
  })
  const c = loadHubConfig(d)
  expect(c.contextsDir).toBe(join(d, 'ctx'))
  expect(c.ledgerPath).toBe(join(d, 'x', 'ledger.jsonl'))
  expect(c.offlineQueuePath.startsWith('/')).toBe(true)
  expect(c.offlineQueuePath.endsWith('/q.jsonl')).toBe(true)
})

test('secretary keeps its defaults when only part of session is given', () => {
  const d = tmp()
  writeHub(d, { version: 8, secretary: { session: { model: 'sonnet' } } })
  const c = loadHubConfig(d)
  expect(c.secretary.session.model).toBe('sonnet')
  expect(c.secretary.session.builtin_tools).toBe('')
})

test('offline_queue.ttl_minutes: omitted -> 1440, explicit invalid values are errors', () => {
  const d = tmp()
  writeHub(d, { version: 8, offline_queue: { enabled: true } })
  expect(loadHubConfig(d).offline_queue.ttl_minutes).toBe(1440)
  writeHub(d, { version: 8, offline_queue: { enabled: true, ttl_minutes: 60 } })
  expect(loadHubConfig(d).offline_queue.ttl_minutes).toBe(60)
  for (const bad of [null, 0, -5, 1.5, '1440']) {
    writeHub(d, { version: 8, offline_queue: { enabled: false, ttl_minutes: bad } })
    expect(errOf(() => loadHubConfig(d))).toContain('offline_queue.ttl_minutes')
  }
})

test('discord: enabled is refused until Phase 7, allow_dm is refused, other keys validated', () => {
  const d = tmp()
  writeHub(d, { version: 8, discord: { enabled: true, allowed_user_ids: ['1'], allowed_channel_ids: ['2'] } })
  expect(errOf(() => loadHubConfig(d))).toContain('discord is implemented in Phase 7')
  writeHub(d, { version: 8, discord: { enabled: false, allow_dm: false } })
  expect(errOf(() => loadHubConfig(d))).toContain('allow_dm')
  writeHub(d, { version: 8, discord: { channel_trigger: 'everything' } })
  expect(errOf(() => loadHubConfig(d))).toContain('discord.channel_trigger')
  writeHub(d, { version: 8, discord: { enabled: false, shared_ledger_visibility: 'all_allowed_channels', work_request_policy: 'allowed_users_via_secretary' } })
  expect(loadHubConfig(d).discord.work_request_policy).toBe('allowed_users_via_secretary')
})

test('duplicate worker ids are rejected', () => {
  const d = tmp()
  writeHub(d, { version: 8, workers: [{ id: 'a' }, { id: 'a' }] })
  expect(() => loadHubConfig(d)).toThrow('duplicate')
})

test('missing file and unsupported versions', () => {
  expect(() => loadHubConfig(tmp())).toThrow('config not found')
  const d = tmp()
  writeHub(d, { version: 9 })
  expect(errOf(() => loadHubConfig(d))).toContain('newer')
  writeWorker(d, { version: 3, worker_id: 'w' })
  expect(errOf(() => loadWorkerConfig(d))).toContain('newer')
  writeHub(d, { listen: {} })
  expect(errOf(() => loadHubConfig(d))).toContain('version')
})

// ---------------------------------------------------------------- hub migration
test('hub v1 -> v8: backup written, file rewritten, autostart off, queue disabled', () => {
  const d = tmp()
  const v1 = { version: 1, listen: { port: 8900 }, secretary: { autostart: true, extra_instructions: 'hi' }, workers: [{ id: 'home' }] }
  writeHub(d, v1)
  const c = loadHubConfig(d)
  expect(c.version).toBe(8)
  expect(c.migration?.from).toBe(1)
  expect(c.migration?.to).toBe(8)
  expect(c.secretary.autostart).toBe(false)
  expect(c.secretary.extra_instructions).toBe('hi')
  expect(c.listen.port).toBe(8900)
  expect(c.offline_queue).toMatchObject({ enabled: false, ttl_minutes: 1440 })
  // backup holds the original bytes, the file holds the migrated config
  const backups = readdirSync(d).filter(f => f.startsWith('hub.json.bak-v1-'))
  expect(backups.length).toBe(1)
  expect(readBack(join(d, backups[0]!))).toEqual(v1)
  expect(c.migration!.backup).toBe(join(d, backups[0]!))
  const now = readBack(join(d, 'hub.json'))
  expect(now.version).toBe(8)
  expect(now.secretary.autostart).toBe(false)
  expect(now.offline_queue).toEqual({ enabled: false, ttl_minutes: 1440 })
  // second load: already current, no new backup
  expect(loadHubConfig(d).migration).toBeNull()
  expect(readdirSync(d).filter(f => f.includes('.bak-')).length).toBe(1)
})

test('hub migration rules (pure)', () => {
  // draft versions 2-7 are read as v1-compatible with a warning
  const m = migrateHubConfig({ version: 5, offline_queue: { enabled: false, ttl_minutes: null } })
  expect(m.changed).toBe(true)
  expect(m.config.version).toBe(8)
  expect(m.config.offline_queue).toEqual({ enabled: false, ttl_minutes: 1440 })
  expect(m.warnings.some(w => w.includes('v1-compatible'))).toBe(true)
  expect(m.warnings.some(w => w.includes('ttl_minutes null'))).toBe(true)
  // ttl null with the queue enabled stops
  expect(() => migrateHubConfig({ version: 7, offline_queue: { enabled: true, ttl_minutes: null } })).toThrow(ConfigError)
  // allow_dm=true stops, false is dropped, context_scope is dropped
  expect(() => migrateHubConfig({ version: 6, discord: { allow_dm: true } })).toThrow('allow_dm')
  const dm = migrateHubConfig({ version: 6, discord: { allow_dm: false, context_scope: 'channel_or_dm' } })
  expect(dm.config.discord).toEqual({})
  // require_mention_in_channels: true -> channel_trigger, false needs the administrator
  expect(migrateHubConfig({ version: 4, discord: { require_mention_in_channels: true } }).config.discord).toEqual({
    channel_trigger: 'mention_or_bot_reply',
  })
  expect(() => migrateHubConfig({ version: 4, discord: { require_mention_in_channels: false } })).toThrow(ConfigError)
  // current version is untouched
  const cur = migrateHubConfig({ version: 8, secretary: { autostart: true } })
  expect(cur.changed).toBe(false)
  expect((cur.config.secretary as { autostart: boolean }).autostart).toBe(true)
  // input is not mutated
  const raw = { version: 1, secretary: { autostart: true } }
  migrateHubConfig(raw)
  expect(raw.secretary.autostart).toBe(true)
})

test('hub migration that fails validation does not rewrite the file', () => {
  const d = tmp()
  writeHub(d, { version: 1, discord: { enabled: true } })
  expect(errOf(() => loadHubConfig(d))).toContain('Phase 7')
  expect(readBack(join(d, 'hub.json')).version).toBe(1)
  expect(readdirSync(d).filter(f => f.includes('.bak-')).length).toBe(0)
  writeHub(d, { version: 3, discord: { allow_dm: true } })
  expect(errOf(() => loadHubConfig(d))).toContain('allow_dm')
  expect(readBack(join(d, 'hub.json')).version).toBe(3)
})

// ---------------------------------------------------------------- worker v2
test('worker v2 defaults, pm defaults and path expansion', () => {
  const d = tmp()
  writeWorker(d, { version: 2, worker_id: 'w1', projects: [{ id: 'a', path: '~/x' }] })
  const c = loadWorkerConfig(d)
  expect(c.migration).toBeNull()
  expect(c.stateDir).toBe(join(d, 'worker'))
  expect(c.session.allowed_tools).toEqual(['mcp__hannigan__reply'])
  expect(c.session.builtin_tools).toBeNull()
  expect(c.pm_session.permission_mode).toBe('manual')
  expect(c.pm_session.builtin_tools).toBeNull()
  expect(c.pm_session.allowed_tools).toEqual(PM_ALLOWED_TOOLS)
  expect(c.projects[0]!.path.startsWith('/')).toBe(true)
  expect(c.projects[0]!.pm).toEqual({ enabled: true, autostart: false, execution_policy: 'hybrid', extra_instructions: '' })
  expect(c.thread_observation).toEqual({ mode: 'transcript', redact_sensitive: true })
  expect(c.max_sessions).toBe(4)
})

test('worker pm_session is independent of session', () => {
  const d = tmp()
  writeWorker(d, { version: 2, worker_id: 'w1', session: { model: 'haiku', env: { A: '1' } }, pm_session: { env: { B: '2' } } })
  const c = loadWorkerConfig(d)
  expect(c.session.model).toBe('haiku')
  expect(c.pm_session.model).toBeNull()
  expect(c.pm_session.env).toEqual({ B: '2' })
})

test('invalid values stop with the field name', () => {
  const d = tmp()
  writeWorker(d, { version: 2, worker_id: 'bad id!', local: { port: 99999 }, projects: [{ id: 'a', path: '/x', pm: { execution_policy: 'yolo' } }] })
  const msg = errOf(() => loadWorkerConfig(d))
  expect(msg).toContain('worker_id')
  expect(msg).toContain('local.port')
  expect(msg).toContain('projects.0.pm.execution_policy')
})

test('duplicate project ids are rejected', () => {
  const d = tmp()
  writeWorker(d, { version: 2, worker_id: 'w', projects: [{ id: 'a', path: '/x' }, { id: 'a', path: '/y' }] })
  expect(() => loadWorkerConfig(d)).toThrow('duplicate')
})

test('nested or shared project folders are rejected (also through a symlink); siblings are fine', () => {
  const d = tmp()
  const root = join(d, 'w')
  mkdirSync(join(root, 'app', 'sub'), { recursive: true })
  mkdirSync(join(root, 'app-other'), { recursive: true })
  symlinkSync(join(root, 'app'), join(d, 'alias'))
  const projects = (paths: string[]) => paths.map((p, i) => ({ id: `p${i}`, path: p }))
  writeWorker(d, { version: 2, worker_id: 'w', projects: projects([join(root, 'app'), join(root, 'app', 'sub')]) })
  expect(errOf(() => loadWorkerConfig(d))).toContain('nested')
  writeWorker(d, { version: 2, worker_id: 'w', projects: projects([join(root, 'app'), join(d, 'alias')]) })
  expect(errOf(() => loadWorkerConfig(d))).toContain('"p0" and "p1"')
  writeWorker(d, { version: 2, worker_id: 'w', projects: projects([join(d, 'alias', 'sub'), join(root, 'app')]) })
  expect(errOf(() => loadWorkerConfig(d))).toContain('nested')
  writeWorker(d, { version: 2, worker_id: 'w', projects: projects([join(root, 'app'), join(root, 'app-other')]) })
  expect(loadWorkerConfig(d).projects.length).toBe(2)
})

test('a migration that cannot be saved warns and runs on the migrated config in memory', () => {
  const d = tmp()
  const v1 = { version: 1, worker_id: 'w1', projects: [{ id: 'a', path: '/x' }] }
  writeWorker(d, v1)
  chmodSync(d, 0o500) // no backup, no rewrite possible
  try {
    const c = loadWorkerConfig(d)
    expect(c.version).toBe(2)
    expect(c.migration?.backup).toBe('')
    expect(c.migration?.warnings.some(w => w.includes('could not save'))).toBe(true)
  } finally {
    chmodSync(d, 0o700)
  }
  expect(readBack(join(d, 'worker.json'))).toEqual(v1)
})

test('worker v1 -> v2: pm defaults added, backup written', () => {
  const d = tmp()
  const v1 = { version: 1, worker_id: 'w1', projects: [{ id: 'a', path: '/x' }, { id: 'b', path: '/y', pm: { enabled: false } }] }
  writeWorker(d, v1)
  const c = loadWorkerConfig(d)
  expect(c.version).toBe(2)
  expect(c.migration?.from).toBe(1)
  expect(c.projects[0]!.pm).toEqual({ enabled: true, autostart: false, execution_policy: 'hybrid', extra_instructions: '' })
  expect(c.projects[1]!.pm.enabled).toBe(false)
  const backups = readdirSync(d).filter(f => f.startsWith('worker.json.bak-v1-'))
  expect(backups.length).toBe(1)
  expect(readBack(join(d, backups[0]!))).toEqual(v1)
  const now = readBack(join(d, 'worker.json'))
  expect(now.version).toBe(2)
  expect(now.projects[0].pm.execution_policy).toBe('hybrid')
  expect(now.thread_observation).toEqual({ mode: 'transcript', redact_sensitive: true })
  expect(now.pm_session).toEqual({ permission_mode: 'manual' })
  // pure function leaves v2 alone
  expect(migrateWorkerConfig(now).changed).toBe(false)
})
