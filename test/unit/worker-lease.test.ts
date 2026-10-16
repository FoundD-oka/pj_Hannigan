import { expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { WorkerEvent } from '../../shared/protocol.ts'
import { classifyPath, decide, physicalPath } from '../../worker/lease-guard.ts'
import {
  BaselineStore,
  LeaseManager,
  STALE_INFLIGHT_MS,
  baselineOf,
  descendants,
  guardLaunch,
  inflightOpen,
  osVerifier,
  type LeaseRecord,
  type OwnerStatus,
  type Proc,
  type VerifyResult,
} from '../../worker/lease.ts'

type LeaseEv = Extract<WorkerEvent, { kind: 'resource_lease_state' }>

function setup(o: { verify?: () => VerifyResult; owners?: Record<string, OwnerStatus>; dir?: string } = {}) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'hn-lease-'))
  const ws = join(dir, 'ws')
  mkdirSync(ws, { recursive: true })
  const events: LeaseEv[] = []
  let clock = 1_000_000
  const owners = o.owners ?? { A: 'live', B: 'live' }
  let verify = o.verify ?? ((): VerifyResult => ({ ok: true }))
  const lm = new LeaseManager({
    stateDir: join(dir, 'state'),
    emit: e => e.kind === 'resource_lease_state' && events.push(e),
    verify: () => verify(),
    ownerStatus: k => owners[k] ?? 'missing',
    now: () => clock,
    unknownAfterMs: 60000,
    reverifyUnknownMs: 10000,
  })
  return {
    dir,
    ws,
    lm,
    events,
    owners,
    tick: (ms: number) => (clock += ms),
    setVerify: (f: () => VerifyResult) => (verify = f),
    proj: (id: string) => JSON.parse(readFileSync(lm.leaseFile(id), 'utf8')),
  }
}

test('grant, busy for others, release after verification, next grant with a higher epoch', () => {
  const t = setup()
  const l = t.lm.ensure(t.ws)
  expect(t.proj(l.resource_id).state).toBe('released') // the guard can read a free lease from the start
  expect(t.lm.check(l.resource_id, 'A')).toBe('free')
  expect(t.lm.acquire(l.resource_id, 'A', 'op1')).toBe(true)
  expect(t.proj(l.resource_id)).toMatchObject({ state: 'held', owner_session_key: 'A', lease_epoch: 1 })
  expect(t.lm.check(l.resource_id, 'B')).toBe('busy')
  expect(t.lm.acquire(l.resource_id, 'B', 'op2')).toBe(false)
  expect(t.lm.check(l.resource_id, 'A')).toBe('own')
  expect(t.lm.releaseOwned('A', 'owner_idle')).toBe(true)
  expect(t.events.map(e => e.state)).toEqual(['held', 'release_pending', 'released'])
  expect(t.events[2]!.recovery_status).toBe('verified')
  expect(t.events[2]!.session).toBe('A')
  expect(t.proj(l.resource_id)).toMatchObject({ state: 'released', owner_session_key: null })
  expect(t.lm.acquire(l.resource_id, 'B', 'op2')).toBe(true)
  expect(t.lm.get(l.resource_id)!.lease_epoch).toBe(2)
  // no local path in the events
  expect(JSON.stringify(t.events)).not.toContain(t.ws)
})

test('symlinked folders are the same resource', () => {
  const t = setup()
  const link = join(t.dir, 'link')
  symlinkSync(t.ws, link)
  expect(t.lm.resourceFor(link).resource_id).toBe(t.lm.resourceFor(t.ws).resource_id)
})

test('unverifiable release stays pending, then becomes resource_unknown; re-verification clears it later', () => {
  const t = setup({ verify: () => ({ ok: false, reason: 'processes_running' }) })
  const l = t.lm.ensure(t.ws)
  t.lm.acquire(l.resource_id, 'A', 'op1')
  t.lm.releaseOwned('A', 'owner_idle')
  expect(t.lm.get(l.resource_id)!.state).toBe('release_pending')
  t.tick(30000)
  t.lm.tick()
  expect(t.lm.get(l.resource_id)!.state).toBe('release_pending')
  t.tick(31000)
  t.lm.tick()
  const u = t.events.at(-1)!
  expect(u.state).toBe('resource_unknown')
  expect(u.recovery_status).toBe('manual_review_required')
  expect(u.reason).toBe('processes_running')
  expect(u.incident_id).toMatch(/^inc-/)
  expect(t.lm.check(l.resource_id, 'B')).toBe('unknown')
  expect(t.lm.acquire(l.resource_id, 'B', 'op2')).toBe(false)
  expect(t.proj(l.resource_id).state).toBe('resource_unknown') // the guard denies everyone
  // still failing: nothing changes
  t.tick(11000)
  t.lm.tick()
  expect(t.lm.get(l.resource_id)!.state).toBe('resource_unknown')
  // the leftover process ended: the next re-verification proves it and releases
  t.setVerify(() => ({ ok: true }))
  t.tick(11000)
  expect(t.lm.tick()).toBe(true)
  expect(t.events.at(-1)).toMatchObject({ state: 'released', reason: 'recovered_verified', recovery_status: 'verified' })
})

test('the same owner can take the lease back while release is pending (new epoch)', () => {
  const t = setup({ verify: () => ({ ok: false, reason: 'tool_in_flight' }) })
  const l = t.lm.ensure(t.ws)
  t.lm.acquire(l.resource_id, 'A', 'op1')
  t.lm.releaseOwned('A', 'owner_idle')
  expect(t.lm.acquire(l.resource_id, 'B', 'op2')).toBe(false)
  expect(t.lm.acquire(l.resource_id, 'A', 'op3')).toBe(true)
  expect(t.lm.get(l.resource_id)).toMatchObject({ state: 'held', lease_epoch: 2, operation_id: 'op3' })
  // a further instruction for the holder: same epoch, audited as an operation
  t.lm.acquire(l.resource_id, 'A', 'op4')
  expect(t.events.at(-1)).toMatchObject({ state: 'held', lease_epoch: 2, operation_id: 'op4', reason: 'operation_added' })
})

test('a corrupt or missing projection fails closed (resource_unknown, not recoverable)', () => {
  const t = setup()
  const l = t.lm.ensure(t.ws)
  t.lm.acquire(l.resource_id, 'A', 'op1')
  writeFileSync(t.lm.leaseFile(l.resource_id), '{broken')
  t.lm.tick()
  expect(t.events.at(-1)).toMatchObject({ state: 'resource_unknown', reason: 'lease_mismatch' })
  t.tick(20000)
  t.lm.tick()
  expect(t.lm.get(l.resource_id)!.state).toBe('resource_unknown')
})

test('restart: live owner keeps the lease, a stopped owner is re-verified, an unknown owner fails closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hn-lease-'))
  const a = setup({ dir })
  const w2 = join(dir, 'ws2')
  const w3 = join(dir, 'ws3')
  mkdirSync(w2)
  mkdirSync(w3)
  const r1 = a.lm.ensure(a.ws).resource_id
  const r2 = a.lm.ensure(w2).resource_id
  const r3 = a.lm.ensure(w3).resource_id
  a.lm.acquire(r1, 'A', 'op1')
  a.lm.acquire(r2, 'B', 'op2')
  a.lm.acquire(r3, 'C', 'op3')
  // daemon restart: A still runs, B stopped, C has no session record any more
  const b = setup({ dir, owners: { A: 'live', B: 'terminal' } })
  b.lm.restore()
  expect(b.lm.get(r1)).toMatchObject({ state: 'held', owner_session_key: 'A', reason: 'restart_restored', recovery_status: 'verified' })
  expect(b.lm.get(r2)!.state).toBe('release_pending')
  b.lm.tick()
  expect(b.lm.get(r2)!.state).toBe('released')
  expect(b.lm.get(r3)).toMatchObject({ state: 'resource_unknown', reason: 'owner_unknown', recovery_status: 'manual_review_required' })
  // a projection deleted while the daemon was down
  const c = setup({ dir, owners: { A: 'live' } })
  rmSync(c.lm.leaseFile(r1))
  c.lm.restore()
  expect(c.lm.get(r1)).toMatchObject({ state: 'resource_unknown', reason: 'lease_mismatch' })
})

// ---------------------------------------------------------------- guard decision (worker/lease-guard.ts)
test('guard: only the holder writes in the workspace; fail closed on errors', () => {
  const env = { HANNIGAN_SESSION_KEY: 'A', HANNIGAN_WORKSPACE: '/w/p', HANNIGAN_LEASE_FILE: '/s/leases/x.json', HANNIGAN_STATE_DIR: '/s' }
  const held = (owner: string, state = 'held') => () => ({ state, owner_session_key: owner, lease_epoch: 3 })
  const bash = { tool_name: 'Bash', tool_input: { command: 'echo hi > a.txt' }, cwd: '/w/p' }
  expect(decide(bash, env, held('A'))).toEqual({ allow: true, record: true, epoch: 3 })
  expect(decide(bash, env, held('B')).allow).toBe(false)
  expect(decide(bash, env, held('A', 'release_pending')).allow).toBe(false)
  expect(decide(bash, env, held('A', 'resource_unknown')).allow).toBe(false)
  expect(
    decide(bash, env, () => {
      throw new Error('ENOENT')
    }),
  ).toEqual({ allow: false, reason: 'guard error: ENOENT' })
  expect(decide(bash, { ...env, HANNIGAN_LEASE_FILE: undefined }, held('A')).allow).toBe(false)
  // file tools: outside the workspace is not the lease's business; the state folder is always refused
  const write = (p: string) => ({ tool_name: 'Write', tool_input: { file_path: p, content: 'x' }, cwd: '/w/p' })
  expect(decide(write('/tmp/elsewhere.txt'), env, held('B'))).toEqual({ allow: true, record: false })
  expect(decide(write('/w/p/a.txt'), env, held('B')).allow).toBe(false)
  expect(decide(write('sub/a.txt'), env, held('B')).allow).toBe(false) // relative to cwd inside the workspace
  expect(decide(write('/w/pother/a.txt'), env, held('B')).allow).toBe(true) // prefix is not containment
  expect(decide(write('/s/leases/x.json'), env, held('A')).allow).toBe(false)
  expect(decide({ tool_name: 'mcp__hannigan__reply', tool_input: {} }, env, held('B'))).toEqual({ allow: true, record: false })
})

test('guard script end to end: exit 2 when not held, inflight start/end recorded when held', async () => {
  const t = setup()
  const l = t.lm.ensure(t.ws)
  const stateDir = join(t.dir, 'state')
  const g = guardLaunch(stateDir, 'bun', 'A', l.workspace_real, t.lm.leaseFile(l.resource_id))
  expect(g.args[0]).toBe('--settings')
  const settings = JSON.parse(readFileSync(g.args[1]!, 'utf8'))
  expect(settings.hooks.PreToolUse[0].matcher).toBe('Edit|Write|NotebookEdit|Bash|Monitor|PowerShell|EnterWorktree|ExitWorktree')
  expect(settings.hooks.PreToolUse[0].hooks[0].onFailure).toBe('block')
  const run = async (mode: string, input: unknown) => {
    const p = Bun.spawn(['bun', join(import.meta.dir, '..', '..', 'worker', 'lease-guard.ts'), mode], {
      env: { ...process.env, ...g.env },
      stdin: new Blob([JSON.stringify(input)]),
      stderr: 'pipe',
    })
    return { code: await p.exited, err: await new Response(p.stderr).text() }
  }
  const call = { tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'touch x' }, cwd: l.workspace_real }
  const denied = await run('pre', call)
  expect(denied.code).toBe(2)
  expect(denied.err).toContain('write lease not held')
  t.lm.acquire(l.resource_id, 'A', 'op1')
  expect((await run('pre', call)).code).toBe(0)
  expect(inflightOpen(stateDir, 'A')).toEqual(['toolu_1'])
  expect((await run('post', { tool_use_id: 'toolu_1' })).code).toBe(0)
  expect(inflightOpen(stateDir, 'A')).toEqual([])
})

test('descendants skip the Hannigan bridge subtree', () => {
  const table = [
    { pid: 10, ppid: 1, command: 'claude' },
    { pid: 11, ppid: 10, command: 'bun /x/shared/bridge.ts' },
    { pid: 12, ppid: 11, command: 'child of bridge' },
    { pid: 13, ppid: 10, command: 'bash -c sleep 100' },
    { pid: 14, ppid: 13, command: 'sleep 100' },
  ]
  expect(descendants(10, table)!.map(p => p.pid).sort()).toEqual([13, 14])
})

// ---------------------------------------------------------------- review fixes (Phase 3 WP5)
test('guard path classification: real path against every project folder (symlink, nested, sibling)', () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'hn-guard-')))
  const a = join(d, 'proj')
  const b = join(d, 'proj-other')
  mkdirSync(join(a, 'src'), { recursive: true })
  mkdirSync(b, { recursive: true })
  symlinkSync(b, join(a, 'link-to-other'))
  symlinkSync(a, join(d, 'alias'))
  // a new file under a symlinked folder resolves to where it is really written
  expect(physicalPath(join(a, 'link-to-other', 'new', 'x.ts'))).toBe(join(b, 'new', 'x.ts'))
  expect(physicalPath(join(d, 'alias', 'src', 'y.ts'))).toBe(join(a, 'src', 'y.ts'))
  const ws = [a, b]
  expect(classifyPath(join(a, 'src', 'y.ts'), ws)).toBe(a) // nested path
  expect(classifyPath(join(b, 'z'), ws)).toBe(b) // sibling whose name extends the other's
  expect(classifyPath(join(d, 'proj-third', 'z'), ws)).toBe(null)
  expect(classifyPath('/tmp/x', ws)).toBe(null)
  expect(classifyPath(join(a, 'inner', 'f'), [a, join(a, 'inner')])).toBe(join(a, 'inner')) // the deepest wins
})

test('guard: a write that resolves into another project folder needs that folder\'s lease', () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'hn-guard-')))
  const a = join(d, 'a')
  const b = join(d, 'b')
  mkdirSync(a)
  mkdirSync(b)
  symlinkSync(b, join(a, 'to-b'))
  const env = { HANNIGAN_SESSION_KEY: 'A', HANNIGAN_WORKSPACE: a, HANNIGAN_LEASE_FILE: '/s/la.json', HANNIGAN_STATE_DIR: join(d, 'state') }
  const leases: Record<string, any> = {
    '/s/la.json': { state: 'held', owner_session_key: 'A', lease_epoch: 2 },
    '/s/lb.json': { state: 'held', owner_session_key: 'B', lease_epoch: 5 },
  }
  const ctx = { realpath: (p: string) => physicalPath(p), workspaces: () => [{ workspace_real: a, lease_file: '/s/la.json' }, { workspace_real: b, lease_file: '/s/lb.json' }] }
  const write = (p: string) => ({ tool_name: 'Write', tool_input: { file_path: p, content: 'x' }, cwd: a })
  const read = (f: string) => leases[f]
  expect(decide(write(join(a, 'ok.txt')), env, read, ctx)).toEqual({ allow: true, record: true, epoch: 2 })
  const viaLink = decide(write(join(a, 'to-b', 'evil.txt')), env, read, ctx)
  expect(viaLink.allow).toBe(false)
  expect((viaLink as any).reason).toContain('another project folder')
  expect(decide(write(join(b, 'direct.txt')), env, read, ctx).allow).toBe(false)
  expect(decide(write(join(d, 'elsewhere.txt')), env, read, ctx)).toEqual({ allow: true, record: false })
  // the other folder's lease held by this session: allowed, not tracked against its own release
  leases['/s/lb.json'] = { state: 'held', owner_session_key: 'A', lease_epoch: 6 }
  expect(decide(write(join(b, 'direct.txt')), env, read, ctx)).toEqual({ allow: true, record: false })
  // the folder list cannot be read: file tools fail closed
  const broken = { ...ctx, workspaces: () => { throw new Error('ENOENT workspaces.json') } }
  expect(decide(write(join(d, 'elsewhere.txt')), env, read, broken).allow).toBe(false)
})

test('writeWorkspaces lists every project folder with its lease file for the guard', () => {
  const t = setup()
  const w2 = join(t.dir, 'ws2')
  mkdirSync(w2)
  t.lm.writeWorkspaces([t.ws, w2])
  const list = JSON.parse(readFileSync(join(t.dir, 'state', 'workspaces.json'), 'utf8'))
  expect(list.map((x: any) => x.workspace_real)).toEqual([realpathSync(t.ws), realpathSync(w2)])
  expect(t.proj(t.lm.resourceFor(w2).resource_id).state).toBe('released')
})

function verifyRig(o: { pid: number | null; table?: Proc[] | null; lsof?: boolean | null; now?: number }) {
  const dir = mkdtempSync(join(tmpdir(), 'hn-ver-'))
  const calls: (Set<number> | null)[] = []
  const v = osVerifier(dir, () => o.pid, {
    descendants: pid => (o.table === null ? null : descendants(pid, o.table ?? [])),
    openForWrite: (_w, pids) => {
      calls.push(pids)
      return o.lsof === undefined ? false : o.lsof
    },
    now: () => o.now ?? Date.now(),
  })
  const lease = (x: Partial<LeaseRecord> = {}): LeaseRecord => ({
    resource_id: 'r',
    workspace_real: '/w',
    state: 'release_pending',
    owner_session_key: 'A',
    operation_id: null,
    lease_epoch: 3,
    updated_at: '',
    ...x,
  })
  const inflight = (rec: Record<string, unknown>) => {
    mkdirSync(join(dir, 'inflight'), { recursive: true })
    appendFileSync(join(dir, 'inflight', 'A.jsonl'), JSON.stringify(rec) + '\n')
  }
  return { v, lease, calls, inflight }
}

test('verify: Claude Code gone still checks open files (any process); lsof failure fails closed', () => {
  const gone = verifyRig({ pid: null })
  expect(gone.v(gone.lease())).toEqual({ ok: true })
  expect(gone.calls).toEqual([null]) // every process, not "nothing to check"
  const writing = verifyRig({ pid: null, lsof: true })
  expect(writing.v(writing.lease())).toEqual({ ok: false, reason: 'files_open_for_write' })
  const noLsof = verifyRig({ pid: null, lsof: null })
  expect(noLsof.v(noLsof.lease())).toEqual({ ok: false, reason: 'cannot_inspect' })
  const live = verifyRig({ pid: 10, table: [{ pid: 10, ppid: 1, command: 'claude' }], lsof: null })
  expect(live.v(live.lease())).toEqual({ ok: false, reason: 'cannot_inspect' })
  const noPs = verifyRig({ pid: 10, table: null })
  expect(noPs.v(noPs.lease())).toEqual({ ok: false, reason: 'cannot_inspect' })
})

test('verify: in-flight starts count only for the current epoch; a stale start (10 min, no process) is dropped', () => {
  const T0 = 5_000_000_000
  const r = verifyRig({ pid: 10, table: [{ pid: 10, ppid: 1, command: 'claude' }], now: T0 })
  r.inflight({ start: 'old', epoch: 2, at: T0 - 1000 }) // previous generation, never ended
  expect(r.v(r.lease())).toEqual({ ok: true })
  r.inflight({ start: 'cur', epoch: 3, at: T0 - 1000 })
  expect(r.v(r.lease())).toEqual({ ok: false, reason: 'tool_in_flight' })
  // 10 minutes later, nothing of it runs any more: stale
  const late = verifyRig({ pid: 10, table: [{ pid: 10, ppid: 1, command: 'claude' }], now: T0 + STALE_INFLIGHT_MS + 1 })
  late.inflight({ start: 'cur', epoch: 3, at: T0 })
  expect(late.v(late.lease())).toEqual({ ok: true })
  // ... but not while a process of it is still alive
  const busy = verifyRig({
    pid: 10,
    table: [
      { pid: 10, ppid: 1, command: 'claude' },
      { pid: 20, ppid: 10, command: '/bin/zsh -c sleep 999' },
    ],
    now: T0 + STALE_INFLIGHT_MS + 1,
  })
  busy.inflight({ start: 'cur', epoch: 3, at: T0 })
  expect(busy.v(busy.lease())).toEqual({ ok: false, reason: 'tool_in_flight' })
})

test('baseline: taken once per launch (MCP servers, no shell subtrees) and kept on re-grant', () => {
  const table: Proc[] = [
    { pid: 10, ppid: 1, command: 'claude' },
    { pid: 11, ppid: 10, command: 'node /mcp/server.js' },
    { pid: 12, ppid: 10, command: '/bin/zsh -c npm test' },
    { pid: 13, ppid: 12, command: 'node jest' },
    { pid: 14, ppid: 10, command: 'bun /x/shared/bridge.ts' },
  ]
  expect(baselineOf(10, table)).toEqual([11])
  const dir = mkdtempSync(join(tmpdir(), 'hn-base-'))
  let takes = 0
  const store = new BaselineStore(dir, () => (++takes, [11]))
  expect(store.for('A', 10)).toEqual([11])
  expect(store.for('A', 10)).toEqual([11])
  expect(takes).toBe(1) // never re-taken for the same launch (would bless running tools)
  expect(new BaselineStore(dir, () => (++takes, [99])).for('A', 10)).toEqual([11]) // survives a daemon restart
  expect(store.for('A', 77)).toEqual([11]) // a new launch (new pid) takes it again
  expect(takes).toBe(2)
  // LeaseManager: the same owner re-acquiring from release_pending keeps its first baseline
  const t = setup({ verify: () => ({ ok: false, reason: 'processes_running' }) })
  const l = t.lm.ensure(t.ws)
  t.lm.acquire(l.resource_id, 'A', 'op1', [11])
  t.lm.releaseOwned('A', 'owner_idle')
  t.lm.acquire(l.resource_id, 'A', 'op2', [11, 12, 13])
  expect(t.lm.get(l.resource_id)!.baseline_pids).toEqual([11])
})

test('release_pending whose owner record is gone becomes resource_unknown (owner_unknown)', () => {
  const t = setup({ verify: () => ({ ok: false, reason: 'tool_in_flight' }) })
  const l = t.lm.ensure(t.ws)
  t.lm.acquire(l.resource_id, 'A', 'op1')
  t.lm.releaseOwned('A', 'owner_idle')
  expect(t.lm.get(l.resource_id)!.state).toBe('release_pending')
  delete t.owners.A
  t.lm.tick()
  expect(t.lm.get(l.resource_id)).toMatchObject({ state: 'resource_unknown', reason: 'owner_unknown', recoverable: false })
})
