// Worker-side Phase 3 paths with the fake Claude Code and a fake hub (no hub process, no API usage):
// project PM uniqueness, pm_send + request_id, delegation to a task, direct posts + PM notice,
// dedup, expiry, scope, workspace write lease (resource_wait -> delivery after release), daemon restart.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { realpathSync } from 'fs'
import { FakeHub, type RecordedEvent } from '../fake-hub.ts'
import { Harness } from '../harness.ts'

const T = 60000
let hub: FakeHub
let h: Harness
let pm1 = ''
let task1 = ''
let orphan = ''
const prompts = { terminal_prompts: { dev_channel_warning: 'auto_accept', workspace_trust: 'auto_accept' } }
const report = (pred: (e: RecordedEvent) => boolean) => (e: RecordedEvent) => e.kind === 'session_report' && pred(e)
const past = () => new Date(Date.now() - 60000).toISOString()
const future = () => new Date(Date.now() + 3600000).toISOString()
// latest lease event of the p1 workspace (the resource the p1 PM holds)
let p1Resource = ''
const p1Lease = () => [...hub.events].reverse().find(e => e.kind === 'resource_lease_state' && e.resource_id === p1Resource)
async function p1Free(): Promise<void> {
  const t0 = Date.now()
  while (p1Lease()?.state !== 'released') {
    if (Date.now() - t0 > T) throw new Error(`p1 lease not released: ${JSON.stringify(p1Lease())}`)
    await Bun.sleep(200)
  }
}

beforeAll(async () => {
  hub = new FakeHub()
  h = new Harness({
    workerProjects: [{ id: 'p1' }, { id: 'p2' }],
    workerSession: prompts,
    pmSession: prompts,
    workerExtra: { hub_url: hub.url, max_sessions: 8 },
  })
  h.startWorker()
  await hub.waitConnected()
})
afterAll(async () => {
  await h?.cleanup()
  hub?.stop()
})

describe('project PM on the worker (fake claude, fake hub)', () => {
  test('pm_ensure creates one PM per project and is idempotent', async () => {
    const a = await hub.ok('pm_ensure', { project: 'p1' })
    const b = await hub.ok('pm_ensure', { project: 'p1' })
    expect(a.session.role).toBe('pm')
    expect(b.session.key).toBe(a.session.key)
    pm1 = a.session.key
    const list = await hub.ok('list')
    expect(list.sessions.filter((s: any) => s.role === 'pm' && s.project === 'p1').length).toBe(1)
    await hub.waitEvent(e => e.kind === 'session_state' && e.session === pm1 && e.state === 'ready' && e.role === 'pm', 0, T, 'pm ready')
    const bad = await hub.command('pm_ensure', { project: 'nope' })
    expect(!bad.ok && bad.error.code).toBe('not_found')
  }, T)

  test('pm_send is delivered once; the PM reply carries the request_id', async () => {
    const s0 = hub.last()
    const r = await hub.ok('pm_send', { project: 'p1', text: 'direct:hello', request_id: 'rq-1', expires_at: future() })
    expect(r.pm_session).toBe(pm1)
    expect(['delivered', 'worker_queued']).toContain(r.status)
    const rep = await hub.waitEvent(report(e => e.text === 'pm did: hello'), s0, T, 'pm direct report')
    expect(rep.role).toBe('pm')
    expect(rep.request_id).toBe('rq-1')
    expect(rep.origin).toBe('request')
    // the PM held the write lease while working and gives it back when idle
    const held = await hub.waitEvent(e => e.kind === 'resource_lease_state' && e.state === 'held' && e.session === pm1, s0, T, 'lease held')
    p1Resource = held.resource_id
    await hub.waitEvent(e => e.kind === 'resource_lease_state' && e.state === 'released' && e.session === pm1, s0, T, 'lease released')
  }, T)

  test('the same request_id again is answered from the ledger and not delivered twice', async () => {
    const s0 = hub.last()
    const again = await hub.ok('pm_send', { project: 'p1', text: 'direct:hello', request_id: 'rq-1', expires_at: future() })
    expect(again.pm_session).toBe(pm1)
    expect(again.status).toBe('delivered')
    const clash = await hub.command('pm_send', { project: 'p1', text: 'direct:other', request_id: 'rq-1' })
    expect(!clash.ok && clash.error.code).toBe('bad_args')
    await Bun.sleep(6000)
    expect(hub.events.filter(e => e.seq > s0 && e.kind === 'session_report' && e.text === 'pm did: hello').length).toBe(0)
  }, T)

  test('an expired pm_send is refused with deadline_expired', async () => {
    const s0 = hub.last()
    const r = await hub.command('pm_send', { project: 'p1', text: 'direct:late', request_id: 'rq-late', expires_at: past() })
    expect(!r.ok && r.error.code).toBe('deadline_expired')
    await hub.waitEvent(e => e.kind === 'delivery' && e.request_id === 'rq-late' && e.status === 'expired', s0, T, 'expired event')
  })

  test('delegation: task created and instructed, its report reaches the PM, the PM report keeps the request_id', async () => {
    const s0 = hub.last()
    await hub.ok('pm_send', { project: 'p1', text: 'delegate:build it', request_id: 'rq-2' })
    const created = await hub.waitEvent(e => e.kind === 'task_event' && e.action === 'created', s0, T, 'task created')
    task1 = created.task_session
    expect(created.pm_session).toBe(pm1)
    await hub.waitEvent(e => e.kind === 'task_event' && e.action === 'sent' && e.task_session === task1, s0, T, 'task sent')
    const tr = await hub.waitEvent(report(e => e.session === task1), s0, T, 'task report')
    expect(tr.text).toBe('echo: build it')
    expect(tr.role).toBe('task')
    expect(tr.pm_session).toBe(pm1)
    expect(tr.origin).toBe('task_report')
    await hub.waitEvent(e => e.kind === 'task_event' && e.action === 'reported' && e.task_session === task1, s0, T, 'task reported')
    const pr = await hub.waitEvent(report(e => e.session === pm1 && String(e.text).startsWith('pm report:')), s0, T, 'pm report')
    expect(pr.text).toBe('pm report: echo: build it')
    expect(pr.request_id).toBe('rq-2')
    expect(pr.origin).toBe('request')
    const list = await hub.ok('list')
    const t = list.sessions.find((s: any) => s.key === task1)
    expect(t.role).toBe('task')
    expect(t.pm_session).toBe(pm1)
    // the PM held the lease while it delegated; the task waited for it (same folder, single writer)
    const waits = hub.events.filter(e => e.seq > s0 && e.kind === 'resource_wait' && e.session === task1)
    const grants = hub.events.filter(e => e.seq > s0 && e.kind === 'resource_lease_state' && e.state === 'held')
    expect(grants.some(e => e.session === task1)).toBe(true)
    expect(waits.every(e => e.reason === 'workspace_busy' && /^[0-9a-f]{64}$/.test(e.resource_id))).toBe(true)
  }, T)

  test('direct post to the PM', async () => {
    const s0 = hub.last()
    const r = await hub.ok('thread_direct_send', { session: pm1, text: 'hi pm', message_id: 'm-1', target_role: 'pm' })
    expect(r.pm_notice_delivery).toBe('not_applicable')
    expect(['delivered', 'queued', 'resource_wait']).toContain(r.target_delivery)
    const rep = await hub.waitEvent(report(e => e.text === 'pm direct: hi pm'), s0, T, 'pm direct reply')
    expect(rep.in_reply_to).toBe('m-1')
    expect(rep.origin).toBe('user_direct')
    expect(rep.request_id ?? null).toBe(null)
    await hub.waitEvent(e => e.kind === 'direct_delivery_state' && e.message_id === 'm-1' && e.target_delivery === 'delivered', s0, T, 'm-1 delivered')
  }, T)

  test('direct post to a task: the task gets it once, its PM gets a notice', async () => {
    const s0 = hub.last()
    const r = await hub.ok('thread_direct_send', { session: task1, text: 'hello task', message_id: 'm-2' })
    expect(r.pm_session).toBe(pm1)
    expect(r.pm_notice_delivery).not.toBe('not_applicable')
    const n = await hub.waitEvent(e => e.kind === 'user_direct_notice' && e.message_id === 'm-2', s0, T, 'notice event')
    expect(n.session).toBe(task1)
    expect(n.pm_session).toBe(pm1)
    const tr = await hub.waitEvent(report(e => e.session === task1 && e.text === 'task direct: hello task'), s0, T, 'task direct reply')
    expect(tr.in_reply_to).toBe('m-2')
    await hub.waitEvent(report(e => e.session === pm1 && e.text === 'noticed m-2'), s0, T, 'pm noticed')
    // the task's answer to the post reaches the PM without the old request: the PM's follow-up is not
    // attributed to rq-2 (no double answer to the secretary, 02 §3.6)
    const fwd = await hub.waitEvent(report(e => e.session === pm1 && e.text === 'pm report: task direct: hello task'), s0, T, 'pm saw the task answer')
    expect(fwd.request_id ?? null).toBe(null)
    expect(fwd.origin ?? null).not.toBe('request')
    await hub.waitEvent(
      e => e.kind === 'direct_delivery_state' && e.message_id === 'm-2' && e.target_delivery === 'delivered' && e.pm_notice_delivery === 'delivered',
      s0,
      T,
      'both delivered',
    )
    // the same message again: previous state, no second delivery
    const s1 = hub.last()
    const again = await hub.ok('thread_direct_send', { session: task1, text: 'hello task', message_id: 'm-2' })
    expect(again.target_delivery).toBe('delivered')
    expect(again.pm_notice_delivery).toBe('delivered')
    await Bun.sleep(6000)
    expect(hub.events.some(e => e.seq > s1 && e.kind === 'session_report' && e.text === 'task direct: hello task')).toBe(false)
  }, T)

  test('a Phase 2 task without a PM refuses direct posts (orphan_task); an expired direct post is refused', async () => {
    const c = await hub.ok('session_create', { project: 'p1', name: 'old style' })
    orphan = c.session.key
    expect(c.session.pm_session).toBe(null)
    const r = await hub.command('thread_direct_send', { session: orphan, text: 'x', message_id: 'm-o' })
    expect(!r.ok && r.error.code).toBe('orphan_task')
    const e = await hub.command('thread_direct_send', { session: pm1, text: 'late', message_id: 'm-late', expires_at: past() })
    expect(!e.ok && e.error.code).toBe('deadline_expired')
    const u = await hub.command('thread_direct_send', { session: 'no-such', text: 'x', message_id: 'm-x' })
    expect(!u.ok && u.error.code).toBe('not_found')
  }, T)

  test("a PM cannot touch another project's or a foreign session (forbidden_scope)", async () => {
    let s0 = hub.last()
    const p2 = await hub.ok('pm_ensure', { project: 'p2' })
    await hub.waitEvent(e => e.kind === 'session_state' && e.session === p2.session.key && e.state === 'ready', s0, T, 'p2 pm ready')
    s0 = hub.last()
    await hub.ok('pm_send', { project: 'p2', text: `call:task_send {"session":"${task1}","text":"x"}`, request_id: 'rq-scope' })
    const rep = await hub.waitEvent(report(e => e.request_id === 'rq-scope'), s0, T, 'scope reply')
    expect(rep.text).toContain('call task_send: error forbidden_scope')
    s0 = hub.last()
    await hub.ok('pm_send', { project: 'p1', text: `call:task_stop {"session":"${orphan}"}`, request_id: 'rq-scope2' })
    const rep2 = await hub.waitEvent(report(e => e.request_id === 'rq-scope2'), s0, T, 'scope reply 2')
    expect(rep2.text).toContain('call task_stop: error forbidden_scope')
  }, T)

  test('work items: the PM registers one with the request it belongs to', async () => {
    const s0 = hub.last()
    await hub.ok('pm_send', { project: 'p1', text: 'item:Fix login', request_id: 'rq-item' })
    const w = await hub.waitEvent(e => e.kind === 'work_item_created', s0, T, 'work item')
    expect(w.title).toBe('Fix login')
    expect(w.pm_session).toBe(pm1)
    expect(w.project).toBe('p1')
    expect(w.request_id).toBe('rq-item')
    expect(w.status).toBe('open')
    await hub.waitEvent(report(e => e.request_id === 'rq-item' && e.text === `item ${w.work_item_id}`), s0, T, 'item reply')
  }, T)

  test('write lease: a post to the task waits while the PM writes, and is delivered after release', async () => {
    await p1Free()
    const s0 = hub.last()
    await hub.ok('pm_send', { project: 'p1', text: 'slow:6', request_id: 'rq-slow' })
    await hub.waitEvent(e => e.kind === 'resource_lease_state' && e.state === 'held' && e.session === pm1, s0, T, 'pm holds')
    const r = await hub.ok('thread_direct_send', { session: task1, text: 'after the pm', message_id: 'm-3' })
    expect(r.target_delivery).toBe('resource_wait')
    const w = await hub.waitEvent(e => e.kind === 'resource_wait' && e.message_id === 'm-3', s0, T, 'resource_wait')
    expect(w.reason).toBe('workspace_busy')
    expect(w.session).toBe(task1)
    await hub.waitEvent(report(e => e.request_id === 'rq-slow' && e.text === 'slow done 6'), s0, T, 'pm done')
    const rel = await hub.waitEvent(e => e.kind === 'resource_lease_state' && e.state === 'released' && e.session === pm1, s0, T, 'released')
    const got = await hub.waitEvent(e => e.kind === 'resource_lease_state' && e.state === 'held' && e.session === task1, rel.seq - 1, T, 'task holds')
    expect(got.lease_epoch).toBeGreaterThan(rel.lease_epoch)
    const del = await hub.waitEvent(e => e.kind === 'direct_delivery_state' && e.message_id === 'm-3' && e.target_delivery === 'delivered', s0, T, 'm-3 delivered')
    expect(del.seq).toBeGreaterThan(rel.seq)
    await hub.waitEvent(report(e => e.session === task1 && e.text === 'task direct: after the pm'), s0, T, 'task got it')
  }, T)

  test('daemon restart keeps the lease owner and the waiting post', async () => {
    await p1Free()
    const s0 = hub.last()
    await hub.ok('pm_send', { project: 'p1', text: 'slow:12', request_id: 'rq-restart' })
    await hub.waitEvent(e => e.kind === 'resource_lease_state' && e.state === 'held' && e.session === pm1, s0, T, 'pm holds')
    const r = await hub.ok('thread_direct_send', { session: task1, text: 'survive restart', message_id: 'm-4' })
    expect(r.target_delivery).toBe('resource_wait')
    await h.stopWorker()
    const s1 = hub.last()
    h.startWorker()
    await hub.waitConnected()
    const restored = await hub.waitEvent(e => e.kind === 'resource_lease_state' && e.reason === 'restart_restored', s1, T, 'restored')
    expect(restored.state).toBe('held')
    expect(restored.session).toBe(pm1)
    expect(hub.events.some(e => e.seq > s1 && e.kind === 'session_report' && e.text === 'task direct: survive restart')).toBe(false)
    await hub.waitEvent(report(e => e.request_id === 'rq-restart' && e.text === 'slow done 12'), s0, T, 'pm done after restart')
    await hub.waitEvent(e => e.kind === 'direct_delivery_state' && e.message_id === 'm-4' && e.target_delivery === 'delivered', s1, T, 'm-4 delivered')
    await hub.waitEvent(report(e => e.session === task1 && e.text === 'task direct: survive restart'), s1, T, 'task got it')
  }, T)

  test('PM reply without request_id: one open request is attributed, two open are not guessed', async () => {
    await p1Free()
    let s0 = hub.last()
    await hub.ok('pm_send', { project: 'p1', text: 'noid:only', request_id: 'rq-only' })
    const one = await hub.waitEvent(report(e => e.session === pm1 && e.text === 'noid: only'), s0, T, 'single open request')
    expect(one).toMatchObject({ origin: 'request', request_id: 'rq-only' })
    await p1Free()
    s0 = hub.last()
    await hub.ok('pm_send', { project: 'p1', text: 'silent:', request_id: 'rq-open' })
    await hub.ok('pm_send', { project: 'p1', text: 'noid:two', request_id: 'rq-two' })
    const two = await hub.waitEvent(report(e => e.session === pm1 && e.text === 'noid: two'), s0, T, 'two open requests')
    expect(two.origin ?? null).toBe(null)
    expect(two.request_id ?? null).toBe(null)
    expect(two.reason).toBe('ambiguous_request')
    // an unknown in_reply_to with a valid request_id still answers that request
    await p1Free()
    s0 = hub.last()
    await hub.ok('pm_send', { project: 'p1', text: 'call:reply {"text":"both ids","request_id":"rq-open","in_reply_to":"m-nope"}', request_id: 'rq-call' })
    const both = await hub.waitEvent(report(e => e.session === pm1 && e.text === 'both ids'), s0, T, 'reply with both ids')
    expect(both).toMatchObject({ origin: 'request', request_id: 'rq-open' })
  }, T)

  test('session_send is only for tasks without a PM; a PM resume is pm_ensure', async () => {
    const toPm = await hub.command('session_send', { session: pm1, text: 'x' })
    expect(!toPm.ok && toPm.error.code).toBe('invalid_state')
    expect(!toPm.ok && toPm.error.message).toContain('pm_send')
    const toTask = await hub.command('session_send', { session: task1, text: 'x' })
    expect(!toTask.ok && toTask.error.code).toBe('invalid_state')
    const r = await hub.ok('session_resume', { session: pm1 })
    expect(r.session.key).toBe(pm1)
    expect(r.session.role).toBe('pm')
    // the orphan Phase 2 task still takes session_send, through the dispatcher and the write lease
    const s0 = hub.last()
    await p1Free()
    const o = await hub.ok('session_send', { session: orphan, text: 'via lease' })
    expect(['delivered', 'queued', 'resource_wait']).toContain(o.status)
    await hub.waitEvent(report(e => e.session === orphan && e.text === 'echo: via lease'), s0, T, 'orphan answered')
    await hub.waitEvent(e => e.kind === 'resource_lease_state' && e.state === 'held' && e.session === orphan, s0, T, 'orphan held the lease')
  }, T)

  test('no local paths in the events sent to the hub', () => {
    const all = JSON.stringify(hub.events)
    for (const d of [h.dir, realpathSync(h.dir)]) expect(all.includes(d)).toBe(false)
  })
})
