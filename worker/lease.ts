// Workspace write lease (Q15/B single writer, Q16/A release after verification, Q17/B fail closed).
// docs/design/02-worker-daemon.md §18-20, 03 §17-19, docs/verification/phase3-spikes/S1-write-lease-enforcement.md
//
// The daemon is the only writer of lease state. Two files per resource:
// - <stateDir>/resource-leases.json: the durable ledger (all resources, daemon-only fields)
// - <stateDir>/leases/<resource_id>.json: the projection the PreToolUse guard (worker/lease-guard.ts) reads
// A session may write in the workspace only while the projection says state=held and owner=itself.
import { createHash } from 'crypto'
import { spawnSync } from 'child_process'
import { existsSync, readFileSync, realpathSync } from 'fs'
import { join, resolve } from 'path'
import type { LeaseState, RecoveryStatus, WorkerEvent } from '../shared/protocol.ts'
import { ensureDir, log, nowIso, readJson, rid, writeJsonAtomic } from '../shared/util.ts'

export type LeaseRecord = {
  resource_id: string
  workspace_real: string
  state: LeaseState // 'released' doubles as "free" (epoch 0 = never granted)
  owner_session_key: string | null
  operation_id: string | null
  lease_epoch: number
  updated_at: string
  // daemon-only fields (ledger, not projected)
  last_owner?: string | null
  baseline_pids?: number[] // MCP servers etc. of the owner's Claude Code, taken at the session's first grant
  pending_since?: number | null
  incident_id?: string | null
  recovery_status?: RecoveryStatus | null
  reason?: string | null
  recoverable?: boolean // resource_unknown that re-verification may clear
  verified_at?: string | null
  last_checked_at?: string | null
}

export type LeaseProjection = Pick<
  LeaseRecord,
  'resource_id' | 'workspace_real' | 'state' | 'owner_session_key' | 'operation_id' | 'lease_epoch' | 'updated_at'
>

export type VerifyResult = { ok: true } | { ok: false; reason: string }
export type OwnerStatus = 'live' | 'terminal' | 'missing'
export type LeaseCheck = 'free' | 'own' | 'busy' | 'unknown'

export type LeaseOptions = {
  stateDir: string
  emit: (e: WorkerEvent) => void
  // release verification of the current owner (inflight tools, processes, open files)
  verify: (l: LeaseRecord) => VerifyResult
  ownerStatus: (sessionKey: string) => OwnerStatus
  now?: () => number
  unknownAfterMs?: number // release_pending that cannot be verified for this long -> resource_unknown (default 60 s)
  reverifyUnknownMs?: number // re-verification interval of a recoverable resource_unknown (default 10 s)
}

export function canonicalWorkspace(cwd: string): string {
  try {
    return realpathSync(resolve(cwd))
  } catch {
    return resolve(cwd)
  }
}

export const resourceIdOf = (workspaceReal: string) => createHash('sha256').update(workspaceReal).digest('hex')

export class LeaseManager {
  private leases = new Map<string, LeaseRecord>()
  private ledgerFile: string
  private dir: string
  private lastReverify = new Map<string, number>()
  private now: () => number

  constructor(private o: LeaseOptions) {
    this.ledgerFile = join(o.stateDir, 'resource-leases.json')
    this.dir = ensureDir(join(o.stateDir, 'leases'))
    this.now = o.now ?? Date.now
  }

  leaseFile(resource_id: string): string {
    return join(this.dir, `${resource_id}.json`)
  }

  resourceFor(cwd: string): { resource_id: string; workspace_real: string } {
    const workspace_real = canonicalWorkspace(cwd)
    return { resource_id: resourceIdOf(workspace_real), workspace_real }
  }

  get(resource_id: string): LeaseRecord | undefined {
    return this.leases.get(resource_id)
  }

  list(): LeaseRecord[] {
    return [...this.leases.values()]
  }

  // the record for a workspace, created free (and projected for the guard) when new
  ensure(cwd: string): LeaseRecord {
    const { resource_id, workspace_real } = this.resourceFor(cwd)
    let l = this.leases.get(resource_id)
    if (!l) {
      l = {
        resource_id,
        workspace_real,
        state: 'released',
        owner_session_key: null,
        operation_id: null,
        lease_epoch: 0,
        updated_at: nowIso(),
      }
      this.leases.set(resource_id, l)
      this.save(l)
    } else if (!existsSync(this.leaseFile(resource_id)) && l.state === 'released') {
      this.project(l)
    }
    return l
  }

  check(resource_id: string, session: string): LeaseCheck {
    const l = this.leases.get(resource_id)
    if (!l || l.state === 'released') return 'free'
    if (l.state === 'resource_unknown') return 'unknown'
    return l.owner_session_key === session ? 'own' : 'busy'
  }

  // grant (or keep) the lease for `session`; false when another session holds it or it is unknown
  acquire(resource_id: string, session: string, operation_id: string | null, baseline: number[] = []): boolean {
    const l = this.leases.get(resource_id)
    if (!l) return false
    const c = this.check(resource_id, session)
    if (c === 'busy' || c === 'unknown') return false
    if (c === 'own' && l.state === 'held') {
      if (operation_id && l.operation_id !== operation_id) {
        // another instruction for the current owner: same generation, audited as a new operation
        l.operation_id = operation_id
        l.reason = 'operation_added'
        this.transition(l)
      }
      return true
    }
    // free, or own while release_pending: a new ownership generation (Q16/A 4: re-acquire before writing again).
    // The same owner keeps its baseline: whatever runs now may be a leftover of its previous turn.
    const sameOwner = c === 'own' && l.owner_session_key === session
    l.state = 'held'
    l.owner_session_key = session
    l.last_owner = session
    l.operation_id = operation_id
    l.lease_epoch += 1
    if (!sameOwner) l.baseline_pids = baseline
    l.pending_since = null
    l.incident_id = null
    l.recovery_status = null
    l.reason = c === 'own' ? 'reacquired' : 'granted'
    l.verified_at = null
    this.transition(l)
    return true
  }

  // the owner went idle / stopped: revoke writes now (guard denies from the next tool call), then verify
  releaseOwned(session: string, why: string): boolean {
    let changed = false
    for (const l of this.leases.values()) {
      if (l.state !== 'held' || l.owner_session_key !== session) continue
      l.state = 'release_pending'
      l.pending_since = this.now()
      l.recovery_status = 'checking'
      l.reason = why
      this.transition(l)
      changed = this.tryRelease(l) || changed
    }
    return changed
  }

  // periodic: projection integrity, release verification, re-verification of recoverable unknowns.
  // returns true when a resource became free (the dispatcher should pump).
  tick(): boolean {
    let freed = false
    for (const l of this.leases.values()) {
      if (l.state === 'held' || l.state === 'release_pending') {
        if (!this.projectionMatches(l)) {
          this.unknown(l, 'lease_mismatch', false)
          continue
        }
      }
      if (
        (l.state === 'held' || l.state === 'release_pending') &&
        (!l.owner_session_key || this.o.ownerStatus(l.owner_session_key) === 'missing')
      ) {
        // no session record: nothing can prove the old writer is gone (02 §20.4)
        this.unknown(l, 'owner_unknown', false)
        continue
      }
      if (l.state === 'release_pending') freed = this.tryRelease(l) || freed
      else if (l.state === 'resource_unknown' && l.recoverable) {
        const last = this.lastReverify.get(l.resource_id) ?? 0
        if (this.now() - last >= (this.o.reverifyUnknownMs ?? 10000)) {
          this.lastReverify.set(l.resource_id, this.now())
          freed = this.reverifyUnknown(l) || freed
        }
      }
    }
    return freed
  }

  // all project folders the guard protects, for writes that leave the session's own folder (lease-guard.ts):
  // <stateDir>/workspaces.json = [{ workspace_real, lease_file }]
  writeWorkspaces(cwds: string[]): void {
    const list = cwds.map(c => this.ensure(c)).map(l => ({ workspace_real: l.workspace_real, lease_file: this.leaseFile(l.resource_id) }))
    writeJsonAtomic(join(this.o.stateDir, 'workspaces.json'), list)
  }

  // daemon start (02 §20.1: release_pending during a restart is re-verified; unknown owners fail closed)
  restore(): void {
    const saved = readJson<LeaseRecord[]>(this.ledgerFile, [])
    for (const l of saved) this.leases.set(l.resource_id, l)
    for (const l of this.leases.values()) {
      if (l.state === 'released') {
        this.project(l)
        continue
      }
      if (l.state === 'resource_unknown') {
        this.emitState(l)
        continue
      }
      if (!this.projectionMatches(l)) {
        this.unknown(l, 'lease_mismatch', false)
        continue
      }
      const st = l.owner_session_key ? this.o.ownerStatus(l.owner_session_key) : 'missing'
      if (st === 'missing') {
        this.unknown(l, 'owner_unknown', false)
      } else if (l.state === 'held' && st === 'live') {
        l.recovery_status = 'verified'
        l.reason = 'restart_restored'
        l.last_checked_at = nowIso()
        this.transition(l)
      } else {
        // held by a stopped owner, or release_pending: verify before anyone else may write
        l.state = 'release_pending'
        l.pending_since = this.now()
        l.recovery_status = 'checking'
        l.reason = st === 'terminal' ? 'owner_stopped' : 'restart_reverify'
        this.transition(l)
      }
    }
    this.saveLedger()
  }

  // ------------------------------------------------------------ internals
  private tryRelease(l: LeaseRecord): boolean {
    let r: VerifyResult
    try {
      r = this.o.verify(l)
    } catch (e) {
      r = { ok: false, reason: 'cannot_inspect' }
      log('lease', 'verify error', { resource: l.resource_id, err: String(e) })
    }
    l.last_checked_at = nowIso()
    if (r.ok) {
      this.markReleased(l, 'verified_idle')
      return true
    }
    if (this.now() - (l.pending_since ?? this.now()) > (this.o.unknownAfterMs ?? 60000)) {
      this.unknown(l, r.reason, true)
    } else if (l.reason !== r.reason) {
      l.reason = r.reason
      this.saveLedger()
    }
    return false
  }

  private reverifyUnknown(l: LeaseRecord): boolean {
    const owner = l.owner_session_key
    if (!owner || this.o.ownerStatus(owner) === 'missing') return false
    let r: VerifyResult
    try {
      r = this.o.verify(l)
    } catch {
      r = { ok: false, reason: 'cannot_inspect' }
    }
    l.last_checked_at = nowIso()
    if (!r.ok) {
      this.saveLedger()
      return false
    }
    this.markReleased(l, 'recovered_verified')
    return true
  }

  private markReleased(l: LeaseRecord, reason: string): void {
    l.state = 'released'
    l.last_owner = l.owner_session_key ?? l.last_owner ?? null
    l.owner_session_key = null
    l.pending_since = null
    l.recovery_status = 'verified'
    l.reason = reason
    l.verified_at = nowIso()
    l.recoverable = false
    this.transition(l)
  }

  private unknown(l: LeaseRecord, reason: string, recoverable: boolean): void {
    if (l.state === 'resource_unknown' && l.reason === reason) return
    l.state = 'resource_unknown'
    l.reason = reason
    l.recoverable = recoverable && !!l.owner_session_key
    l.recovery_status = 'manual_review_required'
    l.incident_id = l.incident_id ?? rid('inc', 6)
    l.last_checked_at = nowIso()
    this.lastReverify.set(l.resource_id, this.now())
    log('lease', 'resource_unknown (manual review required; no automatic kill or release)', { resource: l.resource_id, reason })
    this.transition(l)
  }

  private projectionMatches(l: LeaseRecord): boolean {
    const f = this.leaseFile(l.resource_id)
    if (!existsSync(f)) return false
    let p: LeaseProjection
    try {
      p = JSON.parse(readFileSync(f, 'utf8')) as LeaseProjection
    } catch {
      return false
    }
    return p.state === l.state && p.owner_session_key === l.owner_session_key && p.lease_epoch === l.lease_epoch
  }

  private transition(l: LeaseRecord): void {
    l.updated_at = nowIso()
    this.save(l)
    this.emitState(l)
  }

  private emitState(l: LeaseRecord): void {
    this.o.emit({
      kind: 'resource_lease_state',
      resource_id: l.resource_id,
      session: l.owner_session_key ?? l.last_owner ?? null,
      operation_id: l.operation_id,
      lease_epoch: l.lease_epoch,
      state: l.state,
      reason: l.reason ?? null,
      verified_at: l.verified_at ?? null,
      incident_id: l.incident_id ?? null,
      recovery_status: l.recovery_status ?? null,
      last_checked_at: l.last_checked_at ?? null,
    })
  }

  // ledger first, then the projection the guard reads (both atomic renames)
  private save(l: LeaseRecord): void {
    this.saveLedger()
    this.project(l)
  }

  private saveLedger(): void {
    writeJsonAtomic(this.ledgerFile, [...this.leases.values()])
  }

  private project(l: LeaseRecord): void {
    const p: LeaseProjection = {
      resource_id: l.resource_id,
      workspace_real: l.workspace_real,
      state: l.state,
      owner_session_key: l.owner_session_key,
      operation_id: l.operation_id,
      lease_epoch: l.lease_epoch,
      updated_at: l.updated_at,
    }
    writeJsonAtomic(this.leaseFile(l.resource_id), p)
  }
}

// ---------------------------------------------------------------- OS-level release verification (S1)
export type Proc = { pid: number; ppid: number; command: string }

function processTable(): Proc[] | null {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 5000 })
  if (r.status !== 0) return null
  const out: Proc[] = []
  for (const line of r.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! })
  }
  return out
}

// descendants of root (not root itself); the Hannigan bridge and everything below it are excluded
export function descendants(root: number, table: Proc[] | null = processTable()): Proc[] | null {
  if (!table) return null
  const kids = new Map<number, Proc[]>()
  for (const p of table) {
    const a = kids.get(p.ppid) ?? []
    a.push(p)
    kids.set(p.ppid, a)
  }
  const out: Proc[] = []
  const stack = [...(kids.get(root) ?? [])]
  while (stack.length) {
    const p = stack.pop()!
    if (/\/shared\/bridge\.ts\b/.test(p.command)) continue
    out.push(p)
    stack.push(...(kids.get(p.pid) ?? []))
  }
  return out
}

// tool calls the guard allowed (pre) that have not finished (post) yet. With `epoch`, only starts recorded
// under that lease generation count: a start of an older generation without an end (Claude Code crashed,
// PostToolUse never came) does not block later releases forever; its processes are still checked separately.
export type InflightStart = { id: string; at: number; epoch: number | null }
export function inflightStarts(stateDir: string, sessionKey: string, epoch?: number): InflightStart[] {
  const f = join(stateDir, 'inflight', `${sessionKey}.jsonl`)
  if (!existsSync(f)) return []
  const open = new Map<string, InflightStart>()
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line) as { start?: string; end?: string; epoch?: number; at?: number }
      if (r.start) open.set(r.start, { id: r.start, at: r.at ?? 0, epoch: typeof r.epoch === 'number' ? r.epoch : null })
      if (r.end) open.delete(r.end)
    } catch {}
  }
  return [...open.values()].filter(x => epoch === undefined || x.epoch === epoch)
}
export function inflightOpen(stateDir: string, sessionKey: string, epoch?: number): string[] {
  return inflightStarts(stateDir, sessionKey, epoch).map(x => x.id)
}

// files under the workspace open for writing, by one of `pids` or by any process when `pids` is null.
// null = could not inspect (lsof missing, failed to start, timed out): the caller fails closed.
export function openForWrite(workspace: string, pids: Set<number> | null): boolean | null {
  if (pids && !pids.size) return false
  const r = spawnSync('lsof', ['-n', '-P', '-F', 'pa', '+D', workspace], { encoding: 'utf8', timeout: 15000 })
  if (r.error || r.signal) return null
  let pid = 0
  for (const line of String(r.stdout ?? '').split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('a') && (!pids || pids.has(pid)) && /[wu]/.test(line.slice(1))) return true
  }
  return false
}

export const STALE_INFLIGHT_MS = 10 * 60 * 1000

export type VerifierDeps = {
  descendants?: (pid: number) => Proc[] | null
  openForWrite?: (workspace: string, pids: Set<number> | null) => boolean | null
  now?: () => number
}

export function osVerifier(
  stateDir: string,
  panePid: (sessionKey: string) => number | null,
  deps: VerifierDeps = {},
): (l: LeaseRecord) => VerifyResult {
  const desc = deps.descendants ?? ((pid: number) => descendants(pid))
  const ofw = deps.openForWrite ?? openForWrite
  const now = deps.now ?? Date.now
  return l => {
    const owner = l.owner_session_key
    if (!owner) return { ok: false, reason: 'owner_unknown' }
    // Claude Code gone (pid null): its descendants cannot be listed any more, but a detached child may still
    // write. The open-file check below then looks at every process; nothing is assumed safe.
    const pid = panePid(owner)
    const all = pid == null ? [] : desc(pid)
    if (!all) return { ok: false, reason: 'cannot_inspect' }
    const baseline = new Set(l.baseline_pids ?? [])
    const extra = all.filter(p => !baseline.has(p.pid))
    const open = inflightStarts(stateDir, owner, l.lease_epoch)
    if (open.length) {
      const stale = extra.length === 0 && open.every(x => now() - x.at > STALE_INFLIGHT_MS)
      if (!stale) return { ok: false, reason: 'tool_in_flight' }
      log('lease', 'in-flight tool start without an end treated as stale (older than 10 min, no live process)', {
        resource: l.resource_id,
        epoch: l.lease_epoch,
        tools: open.map(x => x.id),
      })
    }
    if (extra.length) return { ok: false, reason: 'processes_running' }
    const w = ofw(l.workspace_real, pid == null ? null : new Set([pid, ...all.map(p => p.pid)]))
    if (w === null) return { ok: false, reason: 'cannot_inspect' }
    if (w) return { ok: false, reason: 'files_open_for_write' }
    return { ok: true }
  }
}

// processes known at the session's first grant: MCP servers and their children (the Hannigan bridge is
// skipped by descendants()). Shell subtrees are tool runs, never baseline.
const SHELL = /^(?:\S*\/)?-?(?:ba|z|k|da|fi|tc|c)?sh(?:\s|$)/
export function baselineOf(root: number, table: Proc[] | null = processTable()): number[] {
  const all = descendants(root, table)
  if (!all) return []
  const byPid = new Map(all.map(p => [p.pid, p]))
  const inShell = (p: Proc): boolean => {
    for (let cur: Proc | undefined = p; cur; cur = byPid.get(cur.ppid)) if (SHELL.test(cur.command)) return true
    return false
  }
  return all.filter(p => !inShell(p)).map(p => p.pid)
}

// baseline per session launch, taken once (at the first grant after a launch) and kept for later grants:
// re-taking it while a tool runs would make that tool's processes look like MCP servers.
export class BaselineStore {
  private map: Record<string, { pid: number; pids: number[] }>
  private file: string
  constructor(
    stateDir: string,
    private take: (pid: number) => number[] = pid => baselineOf(pid),
  ) {
    this.file = join(stateDir, 'lease-baselines.json')
    this.map = readJson<Record<string, { pid: number; pids: number[] }>>(this.file, {})
  }
  for(sessionKey: string, pid: number | null): number[] {
    if (pid == null) return []
    const cur = this.map[sessionKey]
    if (cur && cur.pid === pid) return cur.pids
    const pids = this.take(pid)
    this.map[sessionKey] = { pid, pids }
    writeJsonAtomic(this.file, this.map)
    return pids
  }
}

// ---------------------------------------------------------------- guard injection (S1)
const GUARD_SCRIPT = join(import.meta.dir, 'lease-guard.ts')
export const GUARD_MATCHER = 'Edit|Write|NotebookEdit|Bash|Monitor|PowerShell|EnterWorktree|ExitWorktree'

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

// <stateDir>/guard-<session_key>.json, passed to Claude Code with --settings; returns argv + env for the launch
export function guardLaunch(
  stateDir: string,
  bunBin: string,
  sessionKey: string,
  workspaceReal: string,
  leaseFile: string,
): { args: string[]; env: Record<string, string> } {
  const file = join(stateDir, `guard-${sessionKey}.json`)
  const cmd = (mode: string) => `${shq(bunBin)} ${shq(GUARD_SCRIPT)} ${mode}`
  writeJsonAtomic(file, {
    disableAllHooks: false,
    hooks: {
      PreToolUse: [{ matcher: GUARD_MATCHER, hooks: [{ type: 'command', command: cmd('pre'), timeout: 10, onFailure: 'block' }] }],
      PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: cmd('post'), timeout: 10 }] }],
      PostToolUseFailure: [{ matcher: '*', hooks: [{ type: 'command', command: cmd('post'), timeout: 10 }] }],
    },
  })
  ensureDir(join(stateDir, 'inflight'))
  return {
    args: ['--settings', file],
    env: {
      HANNIGAN_SESSION_KEY: sessionKey,
      HANNIGAN_WORKSPACE: workspaceReal,
      HANNIGAN_LEASE_FILE: leaseFile,
      HANNIGAN_STATE_DIR: stateDir,
    },
  }
}
