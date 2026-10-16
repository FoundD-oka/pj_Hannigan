// Phase 3 end to end: the real hub + the real worker daemon + the fake Claude Code in all three roles
// (per-conversation secretaries, project PM, task), driven only through the WebChat HTTP API.
// Covers the Phase 3 exit conditions of docs/ROADMAP.md (all but the 7-day daily-use one):
// PM delegation round trip, direct thread posts + PM notice, conversation isolation, offline hold / FIFO / expiry,
// single writer per workspace, hub restart, thread history and the work-item ledger.
// The other e2e files cover the halves separately (hub-routing: scripted worker, pm: fake hub); this one joins them.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { Harness, type Ev } from '../harness.ts'

const T = 60000
const W = 'local'
let h: Harness
let pmKey = '' // the one PM of p1
let taskKey = '' // the task created by the first delegation
let p1Resource = '' // write-lease resource of the p1 folder
const rq: Record<string, string> = {}

const prompts = { terminal_prompts: { dev_channel_warning: 'auto_accept', workspace_trust: 'auto_accept' } }
const requestIdOf = (text: string) => (text.match(/rq-[0-9a-f]+/) ?? [''])[0]
const replyIn = (conv: string, pred: (t: string) => boolean, after: number, what: string, timeout = T) =>
  h.waitEvent(e => e.kind === 'secretary_reply' && e.conv_id === conv && pred(String(e.text)), after, timeout, what)
const report = (pred: (e: Ev) => boolean) => (e: Ev) => e.kind === 'worker_report' && e.worker === W && pred(e)
// the secretary's answer to "pm ..." (the project_pm_send result) -> its request_id
async function pmAccepted(conv: string, after: number, pred: (t: string) => boolean = () => true): Promise<string> {
  const r = await replyIn(conv, t => t.startsWith('pm {') && pred(t), after, `${conv} project_pm_send result`)
  const id = requestIdOf(r.text)
  expect(id).toMatch(/^rq-/)
  return id
}
async function waitCount(pred: (e: Ev) => boolean, n: number, after: number, what: string): Promise<Ev[]> {
  const t0 = Date.now()
  while (Date.now() - t0 < T) {
    const hits = h.events().filter(e => e.seq > after && pred(e))
    if (hits.length >= n) return hits
    await Bun.sleep(200)
  }
  throw new Error(`timeout waiting for ${n} x ${what}`)
}
// the p1 workspace lease is free (latest state released), so the next step starts from a known state
async function p1Free(): Promise<void> {
  const t0 = Date.now()
  for (;;) {
    const last = h.events().filter(e => e.kind === 'resource_lease_state' && e.resource_id === p1Resource).pop()
    if (!last || last.state === 'released') return
    if (Date.now() - t0 > T) throw new Error(`p1 lease not released: ${JSON.stringify(last)}`)
    await Bun.sleep(200)
  }
}
// Q15/B single writer: replaying every lease event in order, a resource is never held by two sessions at once
function assertSingleWriter(): void {
  const holder = new Map<string, string>()
  const evs = h.events().filter(e => e.kind === 'resource_lease_state')
  expect(evs.length).toBeGreaterThan(0)
  for (const e of evs) {
    const k = `${e.worker}/${e.resource_id}`
    if (e.state === 'held') {
      const cur = holder.get(k)
      if (cur && cur !== e.session) throw new Error(`two writers on ${k}: ${cur} and ${e.session} (seq ${e.seq})`)
      holder.set(k, e.session)
    } else if (e.state === 'released') holder.delete(k)
  }
}

beforeAll(async () => {
  h = new Harness({
    workerProjects: [{ id: 'p1', pm: { enabled: true, execution_policy: 'hybrid' } }],
    secretaryAutostart: false,
    secretarySession: prompts,
    pmSession: prompts,
    workerSession: prompts,
    // 1 minute is the shortest TTL the config accepts; the expiry case rewrites the queue file instead of waiting
    hubExtra: { offline_queue: { enabled: true, ttl_minutes: 1 } },
    workerExtra: { max_sessions: 8 },
  })
  h.startHub()
  await h.waitHttp()
  h.startWorker()
  await h.waitEvent(e => e.kind === 'worker_link' && e.worker === W && e.connected === true, 0, T, 'worker connected')
})
afterAll(async () => {
  await h?.cleanup()
})

describe('phase 3 end to end (hub + worker + fake claude)', () => {
  test('exit 1: secretary -> project_pm_send -> PM works directly -> report returns to the requesting conversation', async () => {
    const s0 = h.lastSeq()
    await h.send('pm local p1 direct:hello', 'conv-a')
    rq.hello = await pmAccepted('conv-a', s0)
    const pm = await h.waitEvent(e => e.kind === 'session_state' && e.worker === W && e.role === 'pm' && e.project === 'p1', s0, T, 'PM session')
    pmKey = pm.session
    expect(pm.pm_session).toBe(null)
    const rep = await h.waitEvent(report(e => e.text === 'pm did: hello'), s0, T, 'PM report')
    expect(rep).toMatchObject({ role: 'pm', session: pmKey, request_id: rq.hello, origin: 'request', routed: true, context_id: 'conv-a' })
    const back = await replyIn('conv-a', t => t.startsWith('report: pm did: hello'), s0, 'report in conv-a')
    expect(back.text).toContain(`request_id=${rq.hello}`)
    const states = h.events().filter(e => e.seq > s0 && e.kind === 'request_state' && e.request_id === rq.hello).map(e => e.state)
    expect(states[0]).toBe('accepted')
    expect(states).toContain('delivered')
    // the PM took the p1 workspace lease for its own work and gave it back
    const held = await h.waitEvent(e => e.kind === 'resource_lease_state' && e.state === 'held' && e.session === pmKey, s0, T, 'PM holds')
    p1Resource = held.resource_id
    expect(p1Resource).toMatch(/^[0-9a-f]{64}$/)
  }, T)

  test('exit 1 (delegation): PM delegates to a task, the task report goes through the PM with the original request_id', async () => {
    await p1Free()
    const s0 = h.lastSeq()
    await h.send('pm local p1 delegate:build-x', 'conv-a')
    rq.build = await pmAccepted('conv-a', s0)
    const created = await h.waitEvent(e => e.kind === 'task_event' && e.action === 'created' && e.pm_session === pmKey, s0, T, 'task created')
    taskKey = created.task_session
    await h.waitEvent(e => e.kind === 'task_event' && e.action === 'sent' && e.task_session === taskKey, s0, T, 'task sent')
    const ts = await h.waitEvent(e => e.kind === 'session_state' && e.session === taskKey, s0, T, 'task session state')
    expect(ts).toMatchObject({ role: 'task', pm_session: pmKey, project: 'p1' })
    const tr = await h.waitEvent(report(e => e.session === taskKey && e.text === 'echo: build-x'), s0, T, 'task report')
    expect(tr).toMatchObject({ role: 'task', pm_session: pmKey, origin: 'task_report', routed: false })
    const pr = await h.waitEvent(report(e => e.session === pmKey && e.text === 'pm report: echo: build-x'), s0, T, 'PM report')
    expect(pr).toMatchObject({ request_id: rq.build, origin: 'request', routed: true, context_id: 'conv-a' })
    const back = await replyIn('conv-a', t => t.startsWith('report: pm report: echo: build-x'), s0, 'delegated result in conv-a')
    expect(back.text).toContain(`request_id=${rq.build}`)
    // the task's own reply never reached a secretary
    expect(h.events().some(e => e.seq > s0 && e.kind === 'secretary_reply' && e.text === 'report: echo: build-x')).toBe(false)
    // pm_ensure is idempotent: one PM for p1 after both requests
    expect(new Set(h.events().filter(e => e.kind === 'session_state' && e.worker === W && e.role === 'pm').map(e => e.session))).toEqual(new Set([pmKey]))
    const th = await h.api('/api/threads')
    const p1 = th.json.workers.find((w: any) => w.worker === W).projects.find((p: any) => p.id === 'p1')
    expect(p1.pm.session).toBe(pmKey)
    expect(p1.tasks.map((t: any) => t.session)).toContain(taskKey)
    expect(p1.other_sessions.filter((s: any) => s.role === 'pm')).toEqual([])
  }, T)

  test('exit 3: two conversations ask the same PM at once; each report returns only to its own conversation', async () => {
    await p1Free()
    const s0 = h.lastSeq()
    await Promise.all([h.send('pm local p1 direct:from-b', 'conv-b'), h.send('pm local p1 direct:from-a', 'conv-a')])
    const ra = await replyIn('conv-a', t => t.startsWith('report: pm did: from-a'), s0, 'from-a in conv-a')
    const rb = await replyIn('conv-b', t => t.startsWith('report: pm did: from-b'), s0, 'from-b in conv-b')
    rq.fromA = requestIdOf(ra.text)
    rq.fromB = requestIdOf(rb.text)
    expect(rq.fromA).toMatch(/^rq-/)
    expect(rq.fromB).toMatch(/^rq-/)
    expect(rq.fromA).not.toBe(rq.fromB)
    // the request_ids the secretaries got back from project_pm_send are the ones on the reports
    const accA = h.events().filter(e => e.seq > s0 && e.kind === 'secretary_reply' && e.conv_id === 'conv-a' && String(e.text).startsWith('pm {'))
    const accB = h.events().filter(e => e.seq > s0 && e.kind === 'secretary_reply' && e.conv_id === 'conv-b' && String(e.text).startsWith('pm {'))
    expect(accA.map(e => requestIdOf(e.text))).toEqual([rq.fromA])
    expect(accB.map(e => requestIdOf(e.text))).toEqual([rq.fromB])
    await Bun.sleep(1500)
    const replies = h.events().filter(e => e.kind === 'secretary_reply')
    expect(replies.filter(e => e.conv_id === 'conv-a').some(e => String(e.text).includes('from-b') || String(e.text).includes(rq.fromB))).toBe(false)
    expect(replies.filter(e => e.conv_id === 'conv-b').some(e => String(e.text).includes('from-a') || String(e.text).includes(rq.fromA))).toBe(false)
    expect(replies.filter(e => e.conv_id === 'conv-b').some(e => String(e.text).includes('hello') || String(e.text).includes('build-x'))).toBe(false)
    // one secretary per conversation
    const st = (await h.api('/api/state')).json
    const secs = st.workers.find((w: any) => w.worker === '_secretary').sessions
    expect(secs.length).toBe(2)
    const byCtx = Object.fromEntries(st.secretaries.map((s: any) => [s.context_id, s.session]))
    expect(Object.keys(byCtx).sort()).toEqual(['conv-a', 'conv-b'])
    expect(byCtx['conv-a']).not.toBe(byCtx['conv-b'])
    expect(secs.map((s: any) => s.key).sort()).toEqual([byCtx['conv-a'], byCtx['conv-b']].sort())
    const secStates = h.events().filter(e => e.kind === 'session_state' && e.worker === '_secretary')
    expect(new Set(secStates.map(e => `${e.context_id}:${e.session}`))).toEqual(new Set([`conv-a:${byCtx['conv-a']}`, `conv-b:${byCtx['conv-b']}`]))
  }, T)

  test('exit 2: direct posts to the PM and to the task; the PM is notified and does not re-instruct', async () => {
    await p1Free()
    let s0 = h.lastSeq()
    const r = await h.api('/api/thread/send', { worker: W, session: pmKey, msg_id: 'd-pm-1', text: 'hi pm' })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ status: 'accepted', pm_notice_delivery: 'not_applicable' })
    const rep = await h.waitEvent(report(e => e.session === pmKey && e.text === 'pm direct: hi pm'), s0, T, 'PM direct reply')
    expect(rep).toMatchObject({ in_reply_to: 'd-pm-1', origin: 'user_direct', routed: false, request_id: null })
    await h.waitEvent(e => e.kind === 'direct_delivery_state' && e.message_id === 'd-pm-1' && e.source === 'worker' && e.target_delivery === 'delivered', s0, T, 'd-pm-1 delivered')
    await Bun.sleep(1500)
    expect(h.events().some(e => e.seq > s0 && e.kind === 'secretary_reply')).toBe(false)
    const ph = await h.api(`/api/thread/history?worker=${W}&session=${pmKey}`)
    expect(ph.json.items.some((e: any) => e.kind === 'user_direct' && e.msg_id === 'd-pm-1')).toBe(true)
    expect(ph.json.items.some((e: any) => e.kind === 'worker_report' && e.text === 'pm direct: hi pm')).toBe(true)

    await p1Free()
    s0 = h.lastSeq()
    const t = await h.api('/api/thread/send', { worker: W, session: taskKey, msg_id: 'd-t-1', text: 'hi task' })
    expect(t.status).toBe(200)
    expect(t.json.pm_session).toBe(pmKey)
    expect(t.json.pm_notice_delivery).not.toBe('not_applicable')
    const ud = h.events().find(e => e.kind === 'user_direct' && e.msg_id === 'd-t-1')!
    expect(ud).toMatchObject({ worker: W, session: taskKey, target_role: 'task', pm_session: pmKey })
    const n = await h.waitEvent(e => e.kind === 'user_direct_notice' && e.message_id === 'd-t-1', s0, T, 'PM notice')
    expect(n).toMatchObject({ session: taskKey, pm_session: pmKey })
    const tr = await h.waitEvent(report(e => e.session === taskKey && e.text === 'task direct: hi task'), s0, T, 'task direct reply')
    expect(tr.in_reply_to).toBe('d-t-1')
    await h.waitEvent(report(e => e.session === pmKey && e.text === 'noticed d-t-1'), s0, T, 'PM saw the notice')
    await h.waitEvent(
      e => e.kind === 'direct_delivery_state' && e.message_id === 'd-t-1' && e.source === 'worker' && e.target_delivery === 'delivered' && e.pm_notice_delivery === 'delivered',
      s0,
      T,
      'task post and PM notice delivered',
    )
    // the task's answer to the post goes to its PM without the earlier request (build-x): the PM's follow-up
    // stays in the PM thread and never reaches a secretary (02 §3.6: no double count as a request answer)
    const fwd = await h.waitEvent(report(e => e.session === pmKey && e.text === 'pm report: task direct: hi task'), s0, T, 'PM saw the task answer')
    expect(fwd).toMatchObject({ routed: false, request_id: null })
    expect(fwd.origin).not.toBe('request')
    await Bun.sleep(1500)
    // the notice is not a work order: the PM neither re-sent the instruction nor started another task
    expect(h.events().some(e => e.seq > s0 && e.kind === 'task_event' && (e.action === 'sent' || e.action === 'created'))).toBe(false)
    const replies = h.events().filter(e => e.seq > s0 && e.kind === 'secretary_reply')
    expect(replies.some(e => String(e.text).includes('noticed'))).toBe(false)
    expect(replies.some(e => String(e.text).includes('task direct'))).toBe(false)
    expect(replies).toEqual([])
  }, T)

  test('exit 5: single writer - a post to the PM waits while its task writes, then the lease moves to the PM', async () => {
    await p1Free()
    const s0 = h.lastSeq()
    await h.send('pm local p1 delegate:slow:6', 'conv-a')
    rq.slow = await pmAccepted('conv-a', s0)
    const created = await h.waitEvent(e => e.kind === 'task_event' && e.action === 'created' && e.pm_session === pmKey, s0, T, 'slow task created')
    const slowTask = created.task_session
    await h.waitEvent(e => e.kind === 'resource_lease_state' && e.state === 'held' && e.session === slowTask, s0, T, 'task holds the lease')
    const r = await h.api('/api/thread/send', { worker: W, session: pmKey, msg_id: 'd-pm-2', text: 'while busy' })
    expect(r.status).toBe(200)
    const wait = await h.waitEvent(e => e.kind === 'resource_wait' && e.message_id === 'd-pm-2', s0, T, 'resource_wait')
    expect(wait).toMatchObject({ reason: 'workspace_busy', session: pmKey, resource_id: p1Resource })
    await h.waitEvent(report(e => e.session === slowTask && e.text === 'slow done 6'), s0, T, 'task finished')
    const rel = await h.waitEvent(e => e.kind === 'resource_lease_state' && e.state === 'released' && e.session === slowTask, s0, T, 'task released')
    const got = await h.waitEvent(e => e.kind === 'resource_lease_state' && e.state === 'held' && e.session === pmKey, rel.seq, T, 'PM holds')
    expect(got.lease_epoch).toBeGreaterThan(rel.lease_epoch)
    const del = await h.waitEvent(e => e.kind === 'direct_delivery_state' && e.message_id === 'd-pm-2' && e.source === 'worker' && e.target_delivery === 'delivered', s0, T, 'd-pm-2 delivered')
    expect(del.seq).toBeGreaterThan(rel.seq)
    await h.waitEvent(report(e => e.session === pmKey && e.text === 'pm direct: while busy'), s0, T, 'PM answered the post')
    const back = await replyIn('conv-a', t => t.startsWith('report: pm report: slow done 6'), s0, 'slow result in conv-a')
    expect(back.text).toContain(`request_id=${rq.slow}`)
    assertSingleWriter()
  }, T)

  test('exit 4: a request for a stopped worker is held, then delivered in order after the worker returns', async () => {
    await p1Free()
    let s0 = h.lastSeq()
    await h.stopWorker()
    await h.waitEvent(e => e.kind === 'worker_link' && e.worker === W && e.connected === false, s0, T, 'worker gone')
    s0 = h.lastSeq()
    await h.send('pm local p1 direct:while-offline', 'conv-a')
    rq.off = await pmAccepted('conv-a', s0, t => t.includes('pending_offline'))
    const rs = await h.waitEvent(e => e.kind === 'request_state' && e.request_id === rq.off && e.state === 'pending_offline', s0, T, 'pending_offline')
    const q = await h.waitEvent(e => e.kind === 'offline_request_state' && e.request_id === rq.off && e.state === 'pending_offline', s0, T, 'queued')
    expect(Date.parse(q.expires_at) - Date.parse(q.accepted_at)).toBe(60000)
    expect(rs.expires_at).toBe(q.expires_at)
    const list = await h.api('/api/offline-requests')
    expect(list.json.requests.find((x: any) => x.request_id === rq.off)).toMatchObject({ state: 'pending_offline', worker: W, project: 'p1' })
    // nothing was executed while offline
    expect(h.events().some(e => e.seq > s0 && e.kind === 'worker_report' && String(e.text).includes('while-offline'))).toBe(false)
    const s1 = h.lastSeq()
    h.startWorker()
    await h.waitEvent(e => e.kind === 'worker_link' && e.connected === true, s1, T, 'worker back')
    await h.waitEvent(e => e.kind === 'offline_request_state' && e.request_id === rq.off && e.state === 'delivered', s1, T, 'delivered')
    const rep = await h.waitEvent(report(e => e.text === 'pm did: while-offline'), s1, T, 'PM report')
    expect(rep).toMatchObject({ request_id: rq.off, routed: true, context_id: 'conv-a' })
    await replyIn('conv-a', t => t.startsWith('report: pm did: while-offline'), s1, 'held request answered in conv-a')
  }, T)

  test('exit 4 (expiry): a held request past its deadline is never executed and its conversation is told', async () => {
    await p1Free()
    let s0 = h.lastSeq()
    await h.stopWorker()
    await h.waitEvent(e => e.kind === 'worker_link' && e.worker === W && e.connected === false, s0, T, 'worker gone')
    s0 = h.lastSeq()
    await h.send('pm local p1 direct:exp-1', 'conv-a')
    rq.exp1 = await pmAccepted('conv-a', s0, t => t.includes('pending_offline'))
    const s1 = h.lastSeq()
    await h.send('pm local p1 direct:exp-2', 'conv-a')
    rq.exp2 = await pmAccepted('conv-a', s1, t => t.includes('pending_offline'))
    await h.stopHub()
    // move the first request's acceptance two hours back; the second stays valid
    const f = join(h.home, 'hub', 'offline-requests.jsonl')
    const past = Date.now() - 2 * 3600_000
    const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    let moved = 0
    for (const x of lines)
      if (x.request_id === rq.exp1) {
        x.accepted_at = new Date(past).toISOString()
        x.expires_at = new Date(past + 60000).toISOString()
        moved++
      }
    expect(moved).toBeGreaterThan(0)
    writeFileSync(f, lines.map(x => JSON.stringify(x)).join('\n') + '\n')
    const s2 = h.lastSeq()
    h.startHub()
    await h.waitHttp()
    const ex = await h.waitEvent(e => e.kind === 'request_expired' && e.request_id === rq.exp1, s2, T, 'request_expired')
    expect(ex.context_id).toBe('conv-a')
    await h.waitEvent(e => e.kind === 'request_state' && e.request_id === rq.exp1 && e.state === 'expired', s2, T, 'request expired')
    const notice = await replyIn('conv-a', t => t.startsWith('event:') && t.includes(rq.exp1), s2, 'expiry notice in conv-a')
    expect(notice.text).toContain('実行されていません')
    const s3 = h.lastSeq()
    h.startWorker()
    await h.waitEvent(e => e.kind === 'worker_link' && e.connected === true, s3, T, 'worker back')
    await h.waitEvent(e => e.kind === 'offline_request_state' && e.request_id === rq.exp2 && e.state === 'delivered', s3, T, 'second delivered')
    const rep = await h.waitEvent(report(e => e.text === 'pm did: exp-2'), s3, T, 'second executed')
    expect(rep).toMatchObject({ request_id: rq.exp2, routed: true, context_id: 'conv-a' })
    await replyIn('conv-a', t => t.startsWith('report: pm did: exp-2'), s3, 'second answered')
    await Bun.sleep(2000)
    // the expired request never reached the worker
    const after = h.events().filter(e => e.seq > s0)
    expect(after.some(e => e.kind === 'delivery' && e.request_id === rq.exp1)).toBe(false)
    expect(after.some(e => e.kind === 'worker_report' && (e.request_id === rq.exp1 || String(e.text).includes('exp-1')))).toBe(false)
    expect(after.filter(e => e.kind === 'offline_request_state' && e.request_id === rq.exp1).map(e => e.state)).not.toContain('delivered')
    expect(after.filter(e => e.kind === 'secretary_reply' && e.conv_id !== 'conv-a' && String(e.text).includes('exp-')).length).toBe(0)
  }, T * 2)

  test('hub restart keeps conversations and requests: the same secretary is resumed and reports still route', async () => {
    await p1Free()
    const st = (await h.api('/api/state')).json
    const key = st.secretaries.find((s: any) => s.context_id === 'conv-a').session
    let s0 = h.lastSeq()
    const stop = await h.api('/api/session/stop', { worker: '_secretary', session: key })
    expect(stop.status).toBe(200)
    await h.waitEvent(e => e.kind === 'session_state' && e.worker === '_secretary' && e.session === key && ['stopped', 'exited'].includes(e.state), s0, T, 'secretary stopped')
    await h.stopHub()
    s0 = h.lastSeq()
    h.startHub()
    await h.waitHttp()
    await h.waitEvent(e => e.kind === 'worker_link' && e.worker === W && e.connected === true, s0, T, 'worker reconnected')
    await h.send('pm local p1 direct:after-restart', 'conv-a')
    const ctx = await h.waitEvent(e => e.kind === 'secretary_context' && e.context_id === 'conv-a', s0, T, 'conv-a secretary')
    expect(ctx).toMatchObject({ action: 'resumed', session: key })
    const id = await pmAccepted('conv-a', s0)
    const back = await replyIn('conv-a', t => t.startsWith('report: pm did: after-restart'), s0, 'report after restart')
    expect(back.text).toContain(`request_id=${id}`)
    expect(h.events().some(e => e.seq > s0 && e.kind === 'secretary_context' && e.action === 'created')).toBe(false)
  }, T)

  test('thread history of the task: direct posts and reports, with the coverage it can show', async () => {
    const r = await h.api(`/api/thread/history?worker=${W}&session=${taskKey}`)
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ worker: W, session: taskKey, role: 'task', pm_session: pmKey, project: 'p1' })
    const items = r.json.items as Ev[]
    expect(items.some(e => e.kind === 'user_direct' && e.msg_id === 'd-t-1')).toBe(true)
    expect(items.some(e => e.kind === 'worker_report' && e.text === 'echo: build-x')).toBe(true)
    expect(items.some(e => e.kind === 'worker_report' && e.text === 'task direct: hi task')).toBe(true)
    expect(items.some(e => e.kind === 'task_event' && e.action === 'created')).toBe(true)
    // the fake writes no Claude Code transcript: either nothing observed yet, or the adapter's "unavailable"
    expect(['hannigan_only', 'unavailable']).toContain(r.json.coverage)
    // older pages
    const p = await h.api(`/api/thread/history?worker=${W}&session=${taskKey}&limit=2`)
    expect(p.json.items.length).toBe(2)
    expect(p.json.has_more).toBe(true)
    const older = await h.api(`/api/thread/history?worker=${W}&session=${taskKey}&limit=2&before=${p.json.next_before}`)
    expect(older.json.items.every((e: Ev) => e.seq < p.json.next_before)).toBe(true)
  }, T)

  test('work items: the PM registers one; another conversation reads it through project_status without conversation text', async () => {
    await p1Free()
    const s0 = h.lastSeq()
    await h.send('pm local p1 item:Title-1', 'conv-a')
    const id = await pmAccepted('conv-a', s0)
    const w = await h.waitEvent(e => e.kind === 'work_item' && e.title === 'Title-1', s0, T, 'work item')
    expect(w).toMatchObject({ worker: W, project: 'p1', request_id: id, status: 'open', action: 'created' })
    await replyIn('conv-a', t => t.startsWith(`report: item ${w.work_item_id}`), s0, 'item report')
    const s1 = h.lastSeq()
    await h.send('items local p1', 'conv-b')
    const r = await replyIn('conv-b', t => t.startsWith('items '), s1, 'items reply')
    expect(r.text).toContain('Title-1')
    expect(r.text).toContain(pmKey)
    for (const said of ['pm local p1', 'direct:', 'hello', 'from-a', 'while-offline', 'item:Title-1']) expect(r.text).not.toContain(said)
    const ledger = readFileSync(join(h.home, 'hub', 'work-items.jsonl'), 'utf8')
    expect(ledger).toContain('Title-1')
    expect(ledger).not.toContain('pm local p1')
    assertSingleWriter()
  }, T)
})
