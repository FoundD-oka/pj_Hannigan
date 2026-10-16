// Hub-side Phase 3 routing with fake Claude secretaries and a scripted fake worker (no worker daemon):
// request_id routing of PM reports to the originating conversation only, unrouted reports, the shared ledger,
// direct thread posts, and the offline queue (FIFO dispatch on reconnect, worker-side expiry notice).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { Harness, type Ev } from '../harness.ts'

const T = 60000
let h: Harness

type Cmd = { id: string; name: string; args: Record<string, any> }
class FakeWorker {
  ws: WebSocket | null = null
  seq = 0
  commands: Cmd[] = []
  // name -> handler returning data, or { error } to fail
  answer: (c: Cmd) => { data?: unknown; error?: { code: string; message: string }; delayMs?: number } = () => ({ data: {} })
  constructor(
    private url: string,
    private key: string,
  ) {}
  inventory = {
    projects: [{ id: 'p1', description: 'one', pm_enabled: true, execution_policy: 'hybrid' }],
    sessions: [
      { key: 'pm-1', project: 'p1', name: 'pm', role: 'pm', pm_session: null, state: 'ready', created_at: '', updated_at: '', conversation_id: 'pm-1' },
      { key: 'task-1', project: 'p1', name: 't1', role: 'task', pm_session: 'pm-1', state: 'ready', created_at: '', updated_at: '', conversation_id: 'task-1' },
    ],
  }
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url)
      this.ws = ws
      ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', proto: 2, worker_id: 'local', key: this.key, version: 'fake', next_seq: this.seq + 1 }))
      ws.onerror = e => reject(e)
      ws.onmessage = m => {
        const msg = JSON.parse(String(m.data))
        if (msg.t === 'welcome') {
          this.event({ kind: 'inventory', ...this.inventory })
          resolve()
        } else if (msg.t === 'command') {
          const c: Cmd = { id: msg.id, name: msg.name, args: msg.args }
          this.commands.push(c)
          const r = this.answer(c)
          const out = JSON.stringify(r.error ? { t: 'result', id: c.id, ok: false, error: r.error } : { t: 'result', id: c.id, ok: true, data: r.data })
          if (r.delayMs) setTimeout(() => ws.readyState === WebSocket.OPEN && ws.send(out), r.delayMs)
          else ws.send(out)
        }
      }
    })
  }
  event(e: Record<string, unknown>): void {
    this.ws!.send(JSON.stringify({ t: 'event', seq: ++this.seq, ts: new Date().toISOString(), event: e }))
  }
  async close(): Promise<void> {
    const ws = this.ws!
    const closed = new Promise(r => (ws.onclose = r))
    ws.close()
    await closed
  }
}
let fw: FakeWorker

const replyIn = (conv: string, pred: (t: string) => boolean, after: number, what: string) =>
  h.waitEvent(e => e.kind === 'secretary_reply' && e.conv_id === conv && pred(String(e.text)), after, T, what)
const requestIdOf = (text: string) => (text.match(/rq-[0-9a-f]+/) ?? [''])[0]
async function waitCount(pred: (e: Ev) => boolean, n: number, after: number, what: string): Promise<Ev[]> {
  const t0 = Date.now()
  while (Date.now() - t0 < T) {
    const hits = h.events().filter(e => e.seq > after && pred(e))
    if (hits.length >= n) return hits
    await Bun.sleep(200)
  }
  throw new Error(`timeout waiting for ${n} x ${what}`)
}
const heldReply = (e: Ev) => e.kind === 'secretary_reply' && e.conv_id === 'conv-x' && String(e.text).startsWith('pm ') && String(e.text).includes('pending_offline')

beforeAll(async () => {
  h = new Harness({
    secretaryAutostart: false,
    // context folders are trusted by the hub: the trust dialog is accepted automatically, as is the dev warning
    secretarySession: { terminal_prompts: { dev_channel_warning: 'auto_accept', workspace_trust: 'auto_accept' } },
    env: { FAKE_TRUST_DIALOG: '1' },
    hubExtra: { offline_queue: { enabled: true } },
  })
  h.startHub()
  await h.waitHttp()
  const key = readFileSync(join(h.home, 'secrets', 'worker-key'), 'utf8').trim()
  fw = new FakeWorker(`ws://127.0.0.1:${h.port}/ws/worker`, key)
  fw.answer = c => {
    if (c.name === 'pm_send') {
      if (String(c.args.text).includes('expire-me')) return { error: { code: 'deadline_expired', message: 'expires_at passed' } }
      // a slow answer keeps the first held request "in flight" while the test cancels a later one
      return { data: { pm_session: 'pm-1', status: 'delivered' }, delayMs: String(c.args.text).startsWith('slowfirst') ? 3000 : 0 }
    }
    if (c.name === 'thread_direct_send')
      return { data: { target_delivery: 'delivered', pm_notice_delivery: c.args.session === 'task-1' ? 'queued' : 'not_applicable', pm_session: 'pm-1' } }
    if (c.name === 'list') return { data: fw.inventory }
    return { error: { code: 'unknown_command', message: c.name } }
  }
  await fw.connect()
})
afterAll(async () => {
  try {
    await fw?.close()
  } catch {}
  await h?.cleanup()
})

describe('hub routing (scripted worker)', () => {
  const rq: Record<string, string> = {}

  test('two conversations ask the same PM; reports return only to the requesting conversation, in any order', async () => {
    const s0 = h.lastSeq()
    await h.send('pm local p1 alpha', 'conv-x')
    await h.send('pm local p1 beta', 'conv-y')
    const rx = await replyIn('conv-x', t => t.startsWith('pm '), s0, 'conv-x pm reply')
    const ry = await replyIn('conv-y', t => t.startsWith('pm '), s0, 'conv-y pm reply')
    rq.x = requestIdOf(rx.text)
    rq.y = requestIdOf(ry.text)
    expect(rq.x).toMatch(/^rq-/)
    expect(rq.y).toMatch(/^rq-/)
    expect(rq.x).not.toBe(rq.y)
    expect(rx.text).toContain('delivered')
    const sends = fw.commands.filter(c => c.name === 'pm_send')
    expect(sends.map(c => c.args.request_id).sort()).toEqual([rq.x, rq.y].sort())
    for (const c of sends) {
      expect(c.args.project).toBe('p1')
      expect(typeof c.args.operation_id).toBe('string')
      expect(Date.parse(c.args.expires_at)).toBeGreaterThan(Date.now())
      expect(c.args.chat_id).toBeUndefined() // no conversation id leaves the hub
    }
    // reports arrive in reverse order
    const s1 = h.lastSeq()
    fw.event({ kind: 'session_report', session: 'pm-1', project: 'p1', role: 'pm', pm_session: null, text: 'done-beta', request_id: rq.y, origin: 'request' })
    fw.event({ kind: 'session_report', session: 'pm-1', project: 'p1', role: 'pm', pm_session: null, text: 'done-alpha', request_id: rq.x, origin: 'request' })
    const a = await replyIn('conv-x', t => t.startsWith('report: done-alpha'), s1, 'alpha back in conv-x')
    const b = await replyIn('conv-y', t => t.startsWith('report: done-beta'), s1, 'beta back in conv-y')
    expect(a.text).toContain(`request_id=${rq.x}`)
    expect(b.text).toContain(`request_id=${rq.y}`)
    await Bun.sleep(1500)
    const replies = h.events().filter(e => e.seq > s1 && e.kind === 'secretary_reply')
    expect(replies.filter(e => String(e.text).includes('done-alpha')).map(e => e.conv_id)).toEqual(['conv-x'])
    expect(replies.filter(e => String(e.text).includes('done-beta')).map(e => e.conv_id)).toEqual(['conv-y'])
    const st = await h.api('/api/state')
    expect(st.json.workers.find((w: any) => w.worker === '_secretary').sessions.length).toBe(2)
  }, T)

  test('unknown request_id and direct-post answers are not delivered to any secretary', async () => {
    const s0 = h.lastSeq()
    fw.event({ kind: 'session_report', session: 'pm-1', project: 'p1', role: 'pm', text: 'ghost-report', request_id: 'rq-unknown', origin: 'request' })
    fw.event({ kind: 'session_report', session: 'pm-1', project: 'p1', role: 'pm', text: 'direct-answer', in_reply_to: 'd-1', origin: 'user_direct' })
    fw.event({ kind: 'session_report', session: 'task-1', project: 'p1', role: 'task', pm_session: 'pm-1', text: 'task-answer', chat_id: 'conv-x' })
    const un = await h.waitEvent(e => e.kind === 'report_unrouted' && e.request_id === 'rq-unknown', s0, T, 'unrouted')
    expect(un.reason).toBe('unknown_request')
    await h.waitEvent(e => e.kind === 'worker_report' && e.text === 'task-answer', s0, T, 'task report recorded')
    await Bun.sleep(2000)
    const evs = h.events().filter(e => e.seq > s0)
    expect(evs.some(e => e.kind === 'secretary_reply')).toBe(false)
    expect(evs.filter(e => e.kind === 'worker_report').every(e => e.routed === false)).toBe(true)
    // all of them stay visible in their threads
    const hist = await h.api('/api/thread/history?worker=local&session=pm-1')
    expect(hist.json.items.some((e: any) => e.text === 'ghost-report')).toBe(true)
    expect(hist.json.items.some((e: any) => e.text === 'direct-answer')).toBe(true)
  }, T)

  test('shared ledger: PM work items are readable from another conversation; foreign PMs are refused', async () => {
    const s0 = h.lastSeq()
    fw.event({ kind: 'work_item_created', project: 'p1', pm_session: 'pm-1', work_item_id: 'wi-1', title: 'Fix login', status: 'open', summary: 'auth bug', request_id: rq.x })
    fw.event({ kind: 'work_item_updated', project: 'p1', pm_session: 'pm-1', work_item_id: 'wi-1', status: 'done', summary: 'merged' })
    fw.event({ kind: 'work_item_created', project: 'p1', pm_session: 'task-1', work_item_id: 'wi-2', title: 'sneaky', status: 'open' })
    await h.waitEvent(e => e.kind === 'work_item' && e.work_item_id === 'wi-1' && e.status === 'done', s0, T, 'ledger update')
    const rej = await h.waitEvent(e => e.kind === 'work_item_rejected' && e.work_item_id === 'wi-2', s0, T, 'rejected')
    expect(rej.reason).toBe('unknown_pm')
    const lines = readFileSync(join(h.home, 'hub', 'work-items.jsonl'), 'utf8').trim().split('\n')
    expect(lines.length).toBe(2)
    expect(lines.join('\n')).not.toContain('alpha') // no conversation text in the ledger
    await h.send('items local p1', 'conv-y')
    const r = await replyIn('conv-y', t => t.startsWith('items '), s0, 'items reply')
    expect(r.text).toContain('Fix login')
    expect(r.text).toContain('"status": "done"')
    expect(r.text).toContain('"pm_session": "pm-1"')
  }, T)

  test('direct posts: task post tracks target and PM notice separately; retries are idempotent', async () => {
    const r = await h.api('/api/thread/send', { worker: 'local', session: 'task-1', msg_id: 'd-1', text: 'please also add tests' })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ status: 'accepted', target_delivery: 'delivered', pm_notice_delivery: 'queued', pm_session: 'pm-1' })
    const c = fw.commands.filter(x => x.name === 'thread_direct_send')
    expect(c.length).toBe(1)
    expect(c[0]!.args).toMatchObject({ session: 'task-1', message_id: 'd-1', target_role: 'task', text: 'please also add tests' })
    const again = await h.api('/api/thread/send', { worker: 'local', session: 'task-1', msg_id: 'd-1', text: 'please also add tests' })
    expect(again.json.status).toBe('duplicate_ignored')
    expect(again.json.target_delivery).toBe('delivered')
    expect(fw.commands.filter(x => x.name === 'thread_direct_send').length).toBe(1)
    const ud = h.events().find(e => e.kind === 'user_direct' && e.msg_id === 'd-1')!
    expect(ud).toMatchObject({ worker: 'local', session: 'task-1', target_role: 'task', pm_session: 'pm-1' })
    const pm = await h.api('/api/thread/send', { worker: 'local', session: 'pm-1', msg_id: 'd-2', text: 'status?' })
    expect(pm.json.pm_notice_delivery).toBe('not_applicable')
    // nothing reached a secretary
    expect(h.events().some(e => e.kind === 'secretary_reply' && String(e.text).includes('add tests'))).toBe(false)
  }, T)

  test('offline queue: held while the worker is away, dispatched FIFO after reconnect; worker-side expiry is reported', async () => {
    let s0 = h.lastSeq()
    await fw.close()
    await h.waitEvent(e => e.kind === 'worker_link' && e.connected === false, s0, T, 'link down')
    s0 = h.lastSeq()
    await h.send('pm local p1 one', 'conv-x')
    await waitCount(heldReply, 1, s0, 'one held')
    await h.send('pm local p1 two', 'conv-x')
    await waitCount(heldReply, 2, s0, 'two held')
    const d = await h.api('/api/thread/send', { worker: 'local', session: 'task-1', msg_id: 'd-3', text: 'three' })
    expect(d.status).toBe(202)
    expect(d.json.status).toBe('pending_offline')
    await h.send('pm local p1 expire-me', 'conv-x')
    await waitCount(heldReply, 3, s0, 'expire-me held')
    const held = (await h.api('/api/state')).json.offline_requests
    expect(held.length).toBe(4)
    for (const x of held) expect(Date.parse(x.expires_at) - Date.parse(x.accepted_at)).toBe(24 * 3600_000)
    const before = fw.commands.length
    const s1 = h.lastSeq()
    await fw.connect()
    await h.waitEvent(e => e.kind === 'request_expired', s1, T, 'expired')
    const sent = fw.commands.slice(before).filter(c => c.name !== 'list')
    expect(sent.map(c => c.name === 'pm_send' ? c.args.text : `direct:${c.args.text}`)).toEqual(['one', 'two', 'direct:three', 'expire-me'])
    for (const c of sent) {
      expect(typeof c.args.operation_id).toBe('string')
      expect(held.find((x: any) => x.operation_id === c.args.operation_id).expires_at).toBe(c.args.expires_at)
    }
    const notice = await replyIn('conv-x', t => t.startsWith('event:') && t.includes('実行されていません'), s1, 'expiry notice')
    expect(notice.text).toContain('rq-')
    await Bun.sleep(500)
    const states = h.events().filter(e => e.seq > s1 && e.kind === 'offline_request_state').map(e => e.state)
    expect(states.filter(s => s === 'delivered').length).toBe(3)
    expect(states.filter(s => s === 'expired').length).toBe(1)
    expect((await h.api('/api/state')).json.offline_requests.length).toBe(0)
  }, T)

  test('cancel only applies to held requests; thread send disabled flag and bad input', async () => {
    const r = await h.api('/api/offline-requests/cancel', { operation_id: 'op-nope' })
    expect(r.status).toBe(404)
    const list = await h.api('/api/offline-requests')
    const delivered = list.json.requests.find((x: any) => x.state === 'delivered')
    const c = await h.api('/api/offline-requests/cancel', { operation_id: delivered.operation_id })
    expect(c.status).toBe(409)
    const bad = await h.api('/api/send', { conv_id: '../etc', msg_id: 'm1', text: 'x' })
    expect(bad.status).toBe(400)
  })

  test('a held request cancelled while an earlier one is in flight is never dispatched', async () => {
    let s0 = h.lastSeq()
    await fw.close()
    await h.waitEvent(e => e.kind === 'worker_link' && e.connected === false, s0, T, 'link down')
    s0 = h.lastSeq()
    for (const [i, t] of ['slowfirst', 'second', 'third'].entries()) {
      await h.send(`pm local p1 ${t}`, 'conv-x')
      await waitCount(heldReply, i + 1, s0, `${t} held`)
    }
    const held = (await h.api('/api/offline-requests')).json.requests.filter((x: any) => x.state === 'pending_offline')
    const third = held.find((x: any) => x.text_preview === 'third')
    expect(third).toBeTruthy()
    const before = fw.commands.length
    await fw.connect()
    // the first one is in flight (its answer is delayed); cancel the third now
    const t0 = Date.now()
    while (!fw.commands.slice(before).some(c => c.args.text === 'slowfirst')) {
      if (Date.now() - t0 > T) throw new Error('slowfirst not dispatched')
      await Bun.sleep(50)
    }
    const c = await h.api('/api/offline-requests/cancel', { operation_id: third.operation_id })
    expect(c.status).toBe(200)
    await h.waitEvent(e => e.kind === 'offline_request_state' && e.state === 'delivered' && held.some((x: any) => x.text_preview === 'second' && x.operation_id === e.operation_id), s0, T, 'second delivered')
    await Bun.sleep(1000)
    const sent = fw.commands.slice(before).filter(x => x.name === 'pm_send').map(x => x.args.text)
    expect(sent).toEqual(['slowfirst', 'second'])
    const after = (await h.api('/api/offline-requests')).json.requests.find((x: any) => x.operation_id === third.operation_id)
    expect(after.state).toBe('cancelled')
    const rs = h.events().filter(e => e.kind === 'request_state' && e.request_id === third.request_id).map(e => e.state)
    expect(rs.at(-1)).toBe('cancelled')
    expect(rs).not.toContain('dispatching')
  }, T)
})

export type { Ev }
