#!/usr/bin/env bun
// Write-lease guard: a Claude Code PreToolUse / PostToolUse hook injected with `--settings` into every worker
// session (docs/verification/phase3-spikes/S1-write-lease-enforcement.md "推奨する実装").
//   bun worker/lease-guard.ts pre   -> exit 0 (no decision: normal permission flow) or exit 2 (block)
//   bun worker/lease-guard.ts post  -> records the end of an allowed tool call in the inflight ledger
// Fail closed: any error, a missing env or a missing / corrupt lease file blocks the call.
// The guard only reads lease files; the daemon is their only writer.
// File tools are judged by the real path (links resolved) against every project folder the daemon protects
// (<state>/workspaces.json): a write into any of them needs that folder's lease.
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'path'

export type GuardEnv = {
  HANNIGAN_SESSION_KEY?: string
  HANNIGAN_WORKSPACE?: string
  HANNIGAN_LEASE_FILE?: string
  HANNIGAN_STATE_DIR?: string
}
export type GuardDecision = { allow: true; record: boolean; epoch?: number } | { allow: false; reason: string }
export type Workspace = { workspace_real: string; lease_file: string }
export type GuardContext = {
  // every protected project folder (canonical); throws when the list cannot be read (-> fail closed)
  workspaces?: () => Workspace[]
  // physical path of a (possibly not yet existing) absolute path
  realpath?: (abs: string) => string
}

const FILE_TOOLS = ['Edit', 'Write', 'NotebookEdit']
const inside = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep)

// realpath of the deepest existing ancestor + the rest: a new file under a symlinked folder resolves to
// where it will really be written
export function physicalPath(abs: string, real: (p: string) => string = realpathSync, exists: (p: string) => boolean = existsSync): string {
  const rest: string[] = []
  let cur = resolve(abs)
  for (;;) {
    if (exists(cur)) {
      try {
        return join(real(cur), ...rest.reverse())
      } catch {
        return join(cur, ...rest.reverse())
      }
    }
    const up = dirname(cur)
    if (up === cur) return join(cur, ...rest.reverse())
    rest.push(basename(cur))
    cur = up
  }
}

// the protected folder a physical path lies in (the deepest one), or null when it is outside all of them
export function classifyPath(physical: string, workspaces: string[]): string | null {
  let best: string | null = null
  for (const w of workspaces) if (inside(physical, w) && (!best || w.length > best.length)) best = w
  return best
}

// pure decision (unit tested); readLease returns the parsed lease file or throws
export function decide(input: Record<string, any>, env: GuardEnv, readLease: (f: string) => any, ctx: GuardContext = {}): GuardDecision {
  const self = env.HANNIGAN_SESSION_KEY
  const ws = env.HANNIGAN_WORKSPACE
  const leaseFile = env.HANNIGAN_LEASE_FILE
  const stateDir = env.HANNIGAN_STATE_DIR
  if (!self || !ws || !leaseFile || !stateDir) return { allow: false, reason: 'guard env missing' }
  const tool = String(input.tool_name ?? '')
  if (tool.startsWith('mcp__hannigan__')) return { allow: true, record: false } // Hannigan's own bridge tools
  let target: Workspace = { workspace_real: ws, lease_file: leaseFile }
  if (FILE_TOOLS.includes(tool)) {
    const p = input.tool_input?.file_path ?? input.tool_input?.notebook_path
    if (typeof p !== 'string' || !p) return { allow: false, reason: 'no path' }
    const real = ctx.realpath ?? ((x: string) => x)
    let abs: string
    let others: Workspace[]
    let stateReal: string
    try {
      abs = real(isAbsolute(p) ? resolve(p) : resolve(input.cwd ?? ws, p))
      stateReal = real(stateDir)
      others = ctx.workspaces ? ctx.workspaces() : []
    } catch (e) {
      return { allow: false, reason: `guard error: ${(e as Error).message}` }
    }
    if (inside(abs, stateDir) || inside(abs, stateReal)) return { allow: false, reason: 'the Hannigan state folder is read-only for sessions' }
    const all = [target, ...others.filter(o => o.workspace_real !== ws)]
    const hit = classifyPath(abs, all.map(w => w.workspace_real))
    if (!hit) return { allow: true, record: false } // outside every project folder: not the lease's business
    target = all.find(w => w.workspace_real === hit)!
  }
  let lease: { state?: string; owner_session_key?: string | null; lease_epoch?: number }
  try {
    lease = readLease(target.lease_file)
  } catch (e) {
    return { allow: false, reason: `guard error: ${(e as Error).message}` }
  }
  const other = target.workspace_real !== ws ? ' (another project folder)' : ''
  if (!lease || lease.state !== 'held' || lease.owner_session_key !== self)
    return { allow: false, reason: `state=${lease?.state ?? 'missing'} epoch=${lease?.lease_epoch ?? '?'}${other}` }
  // the inflight ledger belongs to the session's own lease: only those calls are tracked for its release
  return other ? { allow: true, record: false } : { allow: true, record: true, epoch: lease.lease_epoch }
}

function main(): void {
  const mode = process.argv[2]
  const env = process.env as GuardEnv
  const deny = (reason: string): never => {
    process.stderr.write(
      `[hannigan] write lease not held (${reason}). Another session may be writing in this folder. Do not retry; finish your turn and report. Hannigan delivers your next instruction when the folder is free.\n`,
    )
    process.exit(2)
  }
  let input: Record<string, any>
  try {
    input = JSON.parse(readFileSync(0, 'utf8'))
  } catch (e) {
    if (mode === 'post') process.exit(0)
    return deny(`guard error: bad hook input (${(e as Error).message})`)
  }
  const inflight = env.HANNIGAN_STATE_DIR && env.HANNIGAN_SESSION_KEY ? join(env.HANNIGAN_STATE_DIR, 'inflight', `${env.HANNIGAN_SESSION_KEY}.jsonl`) : null
  const note = (rec: Record<string, unknown>) => {
    if (!inflight) return
    mkdirSync(dirname(inflight), { recursive: true, mode: 0o700 })
    appendFileSync(inflight, JSON.stringify({ ...rec, at: Date.now() }) + '\n', { mode: 0o600 })
  }
  if (mode === 'post') {
    try {
      if (input.tool_use_id) note({ end: input.tool_use_id })
    } catch {}
    process.exit(0)
  }
  if (mode !== 'pre') return deny(`guard error: unknown mode ${mode}`)
  try {
    const ctx: GuardContext = {
      realpath: p => physicalPath(p),
      // missing or corrupt -> throws -> the file tool is refused (fail closed)
      workspaces: () => JSON.parse(readFileSync(join(env.HANNIGAN_STATE_DIR!, 'workspaces.json'), 'utf8')) as Workspace[],
    }
    const d = decide(input, env, f => JSON.parse(readFileSync(f, 'utf8')), ctx)
    if (!d.allow) return deny(d.reason)
    if (d.record && input.tool_use_id) note({ start: input.tool_use_id, tool: input.tool_name, epoch: d.epoch })
    process.exit(0)
  } catch (e) {
    deny(`guard error: ${(e as Error).message}`)
  }
}

if (import.meta.main) main()
