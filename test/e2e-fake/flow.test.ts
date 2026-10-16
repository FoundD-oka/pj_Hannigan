// End-to-end flow with the fake Claude Code (no API usage). Runs hub + worker + tmux for real.
// Covers the Phase 2 exit conditions and the T06/T07-style reconnect cases, with Phase 3 per-conversation
// secretaries (lazy start, one session per conv_id, replies only to the own conversation) and the hub side of
// project_pm_send / the offline queue / the thread API against the current worker.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Harness, type Ev } from '../harness.ts'

const T = 60000
let h: Harness
let session = '' // worker session key
const isSec = (e: Ev) => e.worker === '_secretary'
const isWorker = (e: Ev) => e.worker === 'local'
// the fake secretary of a new conversation shows the folder trust dialog (relay), then the dev channel warning (relay)
async function secretaryDialogs(conv: string, after: number): Promise<void> {
  await h.answer(e => isSec(e) && e.context_id === conv && e.prompt_kind === 'workspace_trust', 1, after, T)
  await h.answer(e => isSec(e) && e.context_id === conv && e.prompt_kind === 'dev_channel_warning', 0, after, T)
}

// the session may already be `working` before a step starts (busy window of the previous message): wait for
// the latest state instead of a new state event
async function untilWorking(): Promise<void> {
  const t0 = Date.now()
  while (h.events().filter(e => e.kind === 'session_state' && e.session === session).pop()?.state !== 'working') {
    if (Date.now() - t0 > T) throw new Error('session not working')
    await Bun.sleep(100)
  }
}

beforeAll(async () => {
  h = new Harness({
    projects: ['p1', 'p2'],
    // worker: development channel warning auto-accepted, folder trust relayed (fake shows the trust dialog)
    workerSession: { terminal_prompts: { dev_channel_warning: 'auto_accept', workspace_trust: 'relay' } },
    // the p1 PM (project_pm_send cases) must start on its own: Phase 2 tasks of p1 share its write lease and
    // wait behind a PM that sits at a dialog (one writer per folder, FIFO)
    pmSession: { terminal_prompts: { dev_channel_warning: 'auto_accept', workspace_trust: 'auto_accept' } },
    env: { FAKE_TRUST_DIALOG: '1' },
    secretaryAutostart: false, // Q6/B: a secretary starts with the first message of its conversation
    hubExtra: { offline_queue: { enabled: true } },
  })
  h.startHub()
  await h.waitHttp()
  h.startWorker()
})
afterAll(async () => {
  await h?.cleanup()
})

describe('phase 2 flow (fake claude)', () => {
  test('no secretary before the first message; it starts lazily and its terminal dialogs are answered in WebChat', async () => {
    await h.waitEvent(e => e.kind === 'worker_link' && e.connected === true, 0, T, 'worker connected')
    const st = await h.api('/api/state')
    expect(st.json.workers.find((x: any) => x.worker === '_secretary').sessions.length).toBe(0)
    expect(h.tmuxSessions().length).toBe(0)
    const s0 = h.lastSeq()
    const r = await h.send('hi', 'conv-a')
    expect(r.json.status).toBe('accepted')
    await secretaryDialogs('conv-a', s0)
    await h.waitEvent(e => e.kind === 'session_state' && isSec(e) && e.context_id === 'conv-a' && e.state === 'ready', s0, T, 'secretary ready')
    const reply = await h.waitEvent(e => e.kind === 'secretary_reply' && e.text === 'hello: hi', s0, T, 'first reply')
    expect(reply.conv_id).toBe('conv-a')
    expect(reply.context_id).toBe('conv-a')
  }, T)

  test('one WebChat round trip: secretary creates a session, instructs it, result comes back to the same conversation', async () => {
    const s0 = h.lastSeq()
    const r = await h.send('task local p1 hello-1', 'conv-a')
    expect(r.status).toBe(200)
    // worker: trust dialog relayed, dev warning auto-accepted (recorded as a prompt that closes by itself)
    await h.answer(e => isWorker(e) && e.prompt_kind === 'workspace_trust', 1, s0, T)
    const dev = await h.waitEvent(e => e.kind === 'approval_open' && isWorker(e) && e.prompt_kind === 'dev_channel_warning', s0, T, 'dev warning seen')
    await h.waitEvent(e => e.kind === 'approval_closed' && e.approval_id === dev.approval_id, s0, T, 'dev warning auto closed')
    const report = await h.waitEvent(e => e.kind === 'worker_report', s0, T, 'worker report')
    expect(report.text).toBe('echo: hello-1')
    expect(report.conv_id).toBe('conv-a')
    session = report.session
    const reply = await h.waitEvent(e => e.kind === 'secretary_reply' && String(e.text).startsWith('report:'), s0, T, 'secretary reply')
    expect(reply.text).toBe('report: echo: hello-1')
    expect(reply.conv_id).toBe('conv-a')
  }, T)

  test('duplicate msg_id is ignored', async () => {
    const r1 = await h.send('hi once', 'conv-a', 'dup-1')
    const r2 = await h.send('hi once', 'conv-a', 'dup-1')
    expect(r1.json.status).toBe('accepted')
    expect(r2.json.status).toBe('duplicate_ignored')
  })

  test('a second conversation gets its own secretary session and replies only there', async () => {
    const s0 = h.lastSeq()
    await h.send('hello there', 'conv-b')
    await secretaryDialogs('conv-b', s0)
    const reply = await h.waitEvent(e => e.kind === 'secretary_reply' && e.text === 'hello: hello there', s0, T, 'conv-b reply')
    expect(reply.conv_id).toBe('conv-b')
    const st = await h.api('/api/state')
    const secs = st.json.workers.find((x: any) => x.worker === '_secretary').sessions
    expect(secs.length).toBe(2)
    expect(new Set(secs.map((x: any) => x.context_id))).toEqual(new Set(['conv-a', 'conv-b']))
    expect(new Set(secs.map((x: any) => x.key)).size).toBe(2)
    expect(st.json.secretaries.map((x: any) => x.context_id).sort()).toEqual(['conv-a', 'conv-b'])
    // separate folders under secretary/contexts
    const argv = (await Bun.file(`${h.fakeState}/argv.jsonl`).text()).trim().split('\n').map(l => JSON.parse(l))
    const cwds = new Set(argv.filter(a => secs.some((x: any) => x.key === a.sessionId)).map(a => a.cwd))
    expect(cwds.size).toBe(2)
    for (const c of cwds) expect(String(c)).toContain('/secretary/contexts/conv-')
    // the conv-a secretary never saw this message
    expect(h.events().some(e => e.kind === 'secretary_reply' && e.conv_id === 'conv-a' && String(e.text).includes('hello there'))).toBe(false)
  }, T)

  test('a secretary cannot reply to another conversation (forbidden_origin)', async () => {
    const s0 = h.lastSeq()
    await h.send('replyto conv-a sneaky', 'conv-b')
    const r = await h.waitEvent(e => e.kind === 'secretary_reply' && String(e.text).startsWith('replyto'), s0, T, 'replyto outcome')
    expect(r.conv_id).toBe('conv-b')
    expect(r.text).toContain('refused')
    expect(r.text).toContain('forbidden_origin')
    expect(h.events().some(e => e.seq > s0 && e.kind === 'secretary_reply' && String(e.text).includes('sneaky'))).toBe(false)
    expect(h.events().some(e => e.seq > s0 && e.kind === 'reply_refused' && e.context_id === 'conv-b')).toBe(true)
  }, T)

  test('tool approval can be allowed from WebChat', async () => {
    const s0 = h.lastSeq()
    await h.send(`send local ${session} bash:ls -la`, 'conv-a')
    const ap = await h.answer(e => isWorker(e) && e.type === 'tool', 'allow', s0, T)
    expect(ap.title).toContain('Bash')
    expect(ap.body).toContain('ls -la')
    await h.waitEvent(e => e.kind === 'approval_closed' && e.approval_id === ap.approval_id && e.by === 'webchat', s0, T, 'closed by webchat')
    const rep = await h.waitEvent(e => e.kind === 'worker_report' && String(e.text).startsWith('bash'), s0, T)
    expect(rep.text).toBe('bash allowed: ls -la')
  }, T)

  test('tool approval can be denied from WebChat', async () => {
    const s0 = h.lastSeq()
    await h.send(`send local ${session} bash:rm -rf /tmp/x`, 'conv-a')
    await h.answer(e => isWorker(e) && e.type === 'tool', 'deny', s0, T)
    const rep = await h.waitEvent(e => e.kind === 'worker_report' && String(e.text).startsWith('bash'), s0, T)
    expect(rep.text).toBe('bash denied: rm -rf /tmp/x')
  }, T)

  test('answering an already closed approval is rejected', async () => {
    const closed = h.events().find(e => e.kind === 'approval_closed')!
    const r = await h.api('/api/answer', { approval_id: closed.approval_id, choice: 'allow' })
    expect(r.status).toBe(404)
  })

  test('interrupt (Esc) stops running work and the session stays usable', async () => {
    const s0 = h.lastSeq()
    await h.send(`send local ${session} slow:30`, 'conv-a')
    await h.waitEvent(e => e.kind === 'secretary_reply' && e.conv_id === 'conv-a' && String(e.text).startsWith('sent'), s0, T, 'slow:30 sent')
    await untilWorking()
    await Bun.sleep(1500)
    const r = await h.api('/api/session/interrupt', { worker: 'local', session })
    expect(r.json.ok).toBe(true)
    await h.waitEvent(e => e.kind === 'session_state' && e.session === session && e.state === 'ready', s0, T, 'ready after interrupt')
    expect(h.events().some(e => e.seq > s0 && e.kind === 'worker_report' && String(e.text).startsWith('slow done'))).toBe(false)
    const s1 = h.lastSeq()
    await h.send(`send local ${session} after-interrupt`, 'conv-a')
    const rep = await h.waitEvent(e => e.kind === 'worker_report', s1, T)
    expect(rep.text).toBe('echo: after-interrupt')
  }, T)

  test('resume keeps history and the channel', async () => {
    let s0 = h.lastSeq()
    await h.send(`send local ${session} remember:apple`, 'conv-a')
    await h.waitEvent(e => e.kind === 'worker_report' && e.text === 'remembered apple', s0, T)
    s0 = h.lastSeq()
    const st = await h.api('/api/session/stop', { worker: 'local', session })
    expect(st.json.ok).toBe(true)
    await h.waitEvent(e => e.kind === 'session_state' && e.session === session && e.state === 'stopped', s0, T, 'stopped')
    // another conversation may not resume (or drive) a session conv-a owns
    s0 = h.lastSeq()
    await h.send(`resume local ${session} recall`, 'conv-b')
    const no = await h.waitEvent(e => e.kind === 'secretary_reply' && e.conv_id === 'conv-b' && String(e.text).startsWith('resume failed'), s0, T, 'foreign resume refused')
    expect(no.text).toContain('forbidden_origin')
    expect(h.events().some(e => e.seq > s0 && e.kind === 'session_state' && e.session === session && e.state === 'starting')).toBe(false)
    s0 = h.lastSeq()
    await h.send(`resume local ${session} recall`, 'conv-a')
    const rep = await h.waitEvent(e => e.kind === 'worker_report' && String(e.text).startsWith('recall'), s0, T, 'recall report')
    expect(rep.text).toBe('recall: apple')
    expect(rep.session).toBe(session)
    expect(rep.conv_id).toBe('conv-a')
    // regression: the stop timer of the previous launch must not kill the resumed session (same tmux name)
    const s1 = h.lastSeq()
    await Bun.sleep(11000)
    expect(h.events().some(e => e.seq > s1 && e.kind === 'session_state' && e.session === session && ['exited', 'stopped'].includes(e.state))).toBe(false)
    // same conversation id was resumed
    const argv = (await Bun.file(`${h.fakeState}/argv.jsonl`).text()).trim().split('\n').map(l => JSON.parse(l))
    expect(argv.some(a => a.argv[0] === '--resume' && a.argv[1] === session)).toBe(true)
  }, T)

  test('state endpoint lists workers, sessions and no stale approvals', async () => {
    const r = await h.api('/api/state')
    expect(r.status).toBe(200)
    const w = r.json.workers.find((x: any) => x.worker === 'local')
    expect(w.connected).toBe(true)
    expect(w.sessions.some((s: any) => s.key === session)).toBe(true)
    expect(r.json.approvals.length).toBe(0)
  })

  test('project_pm_send: the hub issues a request_id; a worker without pm_send fails it gracefully', async () => {
    const s0 = h.lastSeq()
    await h.send('pm local p1 summarize the repo', 'conv-a')
    const reply = await h.waitEvent(e => e.kind === 'secretary_reply' && /^pm /.test(String(e.text)), s0, T, 'pm reply')
    expect(reply.conv_id).toBe('conv-a')
    const accepted = await h.waitEvent(e => e.kind === 'request_state' && e.state === 'accepted' && e.context_id === 'conv-a', s0, T, 'accepted')
    expect(String(accepted.request_id)).toMatch(/^rq-/)
    const final = await h.waitEvent(e => e.kind === 'request_state' && e.request_id === accepted.request_id && e.state !== 'accepted', s0, T, 'final')
    if (String(reply.text).startsWith('pm failed')) {
      // worker without the PM implementation (before WP2): unknown_command -> failed, nothing guessed
      expect(reply.text).toContain('unknown_command')
      expect(final.state).toBe('failed')
      expect(final.reason).toBe('unknown_command')
    } else {
      expect(['delivered', 'worker_queued', 'resource_wait']).toContain(final.state)
      expect(reply.text).toContain(String(accepted.request_id))
    }
    // pm to an unknown project is refused by the hub itself
    const s1 = h.lastSeq()
    await h.send('pm local nope do it', 'conv-a')
    const nf = await h.waitEvent(e => e.kind === 'secretary_reply' && /^pm failed/.test(String(e.text)), s1, T, 'pm not_found')
    expect(nf.text).toContain('not_found')
  }, T)

  test('thread API: hierarchy, history with coverage, direct post refused for a task without a PM', async () => {
    const th = await h.api('/api/threads')
    expect(th.status).toBe(200)
    const p1 = th.json.workers.find((w: any) => w.worker === 'local').projects.find((p: any) => p.id === 'p1')
    expect(p1.pm_enabled).toBe(true)
    expect([...p1.tasks, ...p1.other_sessions].some((x: any) => x.session === session)).toBe(true)
    expect(th.json.secretaries.length).toBe(2)
    const hist = await h.api(`/api/thread/history?worker=local&session=${session}&limit=3`)
    expect(hist.status).toBe(200)
    expect(hist.json.coverage).toBe('hannigan_only')
    expect(hist.json.items.length).toBe(3)
    expect(hist.json.items.every((e: any) => e.session === session || e.kind === 'approval_closed')).toBe(true)
    expect(hist.json.has_more).toBe(true)
    const older = await h.api(`/api/thread/history?worker=local&session=${session}&limit=200&before=${hist.json.next_before}`)
    expect(older.json.items.every((e: any) => e.seq < hist.json.next_before)).toBe(true)
    expect(older.json.items.some((e: any) => e.kind === 'worker_report')).toBe(true)
    const orphan = await h.api('/api/thread/send', { worker: 'local', session, msg_id: 'd1', text: 'direct' })
    expect(orphan.status).toBe(409)
    expect(orphan.json.error).toBe('orphan_task')
    const missing = await h.api('/api/thread/send', { worker: 'local', session: 'no-such-session', msg_id: 'd2', text: 'direct' })
    expect(missing.status).toBe(404)
    const bad = await h.api('/api/thread/send', { worker: 'local', session: '../x', msg_id: 'd3', text: 'direct' })
    expect(bad.status).toBe(400)
  })

  test('worker daemon restart: sessions keep running and are picked up again', async () => {
    await h.stopWorker()
    let s0 = h.lastSeq()
    await h.waitEvent(e => e.kind === 'worker_link' && e.connected === false, s0 - 5, T, 'worker link down')
    // while the worker is away the secretary gets worker_offline
    await h.send(`send local ${session} while-offline`, 'conv-a')
    const off = await h.waitEvent(e => e.kind === 'secretary_reply' && String(e.text).includes('worker_offline'), s0, T, 'offline reply')
    expect(off.text).toContain('send failed')
    // a project_pm_send while the worker is away is held with a 24h deadline (Q12/C) and not executed
    await h.send('pm local p1 queued-work', 'conv-a')
    const held = await h.waitEvent(e => e.kind === 'secretary_reply' && /^pm /.test(String(e.text)), s0, T, 'pm held reply')
    expect(held.text).toContain('pending_offline')
    const q = await h.waitEvent(e => e.kind === 'offline_request_state' && e.state === 'pending_offline', s0, T, 'queued')
    expect(Date.parse(q.expires_at) - Date.parse(q.accepted_at)).toBe(24 * 3600_000)
    expect((await h.api('/api/state')).json.offline_requests.some((x: any) => x.operation_id === q.operation_id)).toBe(true)
    h.startWorker()
    await h.waitEvent(e => e.kind === 'worker_link' && e.connected === true, s0, T, 'worker back')
    // dispatched after the inventory sync; the current worker refuses pm_send -> failed and the conversation is told
    const done = await h.waitEvent(
      e => e.kind === 'offline_request_state' && e.operation_id === q.operation_id && !['pending_offline', 'dispatching'].includes(e.state),
      s0,
      T,
      'dispatched',
    )
    if (done.state === 'failed') {
      expect(done.reason).toBe('unknown_command')
      const ev = await h.waitEvent(e => e.kind === 'secretary_reply' && String(e.text).includes(q.request_id) && String(e.text).startsWith('event:'), s0, T, 'not executed')
      expect(ev.conv_id).toBe('conv-a')
      expect(ev.text).toContain('実行されていません')
    } else {
      expect(['delivered', 'worker_queued', 'resource_wait']).toContain(done.state)
    }
    s0 = h.lastSeq()
    // the bridge reconnects to the new daemon on its own
    await Bun.sleep(3000)
    await h.send(`send local ${session} after-worker-restart`, 'conv-a')
    const rep = await h.waitEvent(e => e.kind === 'worker_report' && e.text === 'echo: after-worker-restart', s0, T)
    expect(rep.session).toBe(session)
  }, T)

  test('hub restart: a report produced while the hub is down is delivered from the outbox', async () => {
    let s0 = h.lastSeq()
    await h.send(`send local ${session} slow:4`, 'conv-a')
    await h.waitEvent(e => e.kind === 'secretary_reply' && e.conv_id === 'conv-a' && String(e.text).startsWith('sent'), s0, T, 'slow:4 sent')
    await untilWorking()
    await h.stopHub()
    await Bun.sleep(6000) // the report is produced now and stays in the worker outbox
    h.startHub()
    await h.waitHttp()
    const rep = await h.waitEvent(e => e.kind === 'worker_report' && e.text === 'slow done 4', s0, T, 'report after hub restart')
    expect(rep.session).toBe(session)
    // exactly once
    await Bun.sleep(2000)
    expect(h.events().filter(e => e.kind === 'worker_report' && e.text === 'slow done 4').length).toBe(1)
    // the secretary bridge reconnected too and relays the result
    await h.waitEvent(e => e.kind === 'secretary_reply' && e.text === 'report: slow done 4', s0, T, 'secretary relays after hub restart')
  }, 90000)

  test('SSE replays events after a given seq (browser reconnect)', async () => {
    const all = h.events()
    const since = all[all.length - 5]!.seq
    const ctrl = new AbortController()
    const res = await fetch(h.url(`/api/events?since=${since}&token=${h.token}`), { signal: ctrl.signal })
    const reader = res.body!.getReader()
    let text = ''
    const t0 = Date.now()
    while (Date.now() - t0 < 5000) {
      const { value } = await reader.read()
      text += new TextDecoder().decode(value)
      if ((text.match(/^id: /gm) ?? []).length >= 4) break
    }
    ctrl.abort()
    const ids = [...text.matchAll(/^id: (\d+)/gm)].map(m => Number(m[1]))
    expect(ids[0]).toBe(since + 1)
    expect(ids.every((v, i) => i === 0 || v === ids[i - 1]! + 1)).toBe(true)
  })

  test('auth: wrong WebChat token and wrong worker key are rejected', async () => {
    const r = await h.api('/api/state', undefined, 'wrong')
    expect(r.status).toBe(401)
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws/worker`)
    const closed = new Promise<string>(resolve => {
      ws.onmessage = ev => resolve(String(ev.data))
      ws.onclose = () => resolve('closed')
    })
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', proto: 2, worker_id: 'local', key: 'nope', version: 'x', next_seq: 1 }))
    expect(await closed).toContain('auth')
    // the real worker is still connected
    const st = await h.api('/api/state')
    expect(st.json.workers.find((x: any) => x.worker === 'local').connected).toBe(true)
  })

  test('commands with bad arguments are refused by the worker', async () => {
    const s0 = h.lastSeq()
    await h.send('task local no-such-project hi', 'conv-a')
    const r = await h.waitEvent(e => e.kind === 'secretary_reply' && String(e.text).startsWith('create failed'), s0, T)
    expect(r.text).toContain('not_found')
  }, T)

  test('stop ends the tmux session', async () => {
    const s0 = h.lastSeq()
    await h.api('/api/session/stop', { worker: 'local', session })
    await h.waitEvent(e => e.kind === 'session_state' && e.session === session && e.state === 'stopped', s0, T)
    expect(h.tmuxSessions().some(n => n.includes(session.slice(0, 8)))).toBe(false)
  }, T)
})
