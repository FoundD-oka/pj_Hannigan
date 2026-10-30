#!/usr/bin/env bun
// The always-on program on a Mac: connects out to the relay and runs interactive Claude Code in tmux, the only way to
// get native computer use. It owns the sessions, so they survive OpenMausBot restarting its engine process and network
// drops. docs/design/05-omb-mac-relay.md, verified in docs/verification/omb-mac-relay.
//   bun relay/mac-agent.ts pair https://host CODE --mac m4-mini --cwd ~/work
//   bun relay/mac-agent.ts
import { spawnSync } from 'child_process'
import { randomUUID } from 'crypto'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { ReliableLink } from './link.ts'
import { DEAD_AFTER_MS, PING_MS, RELAY_PATH, type FromMac, type MacHello, type RelayDenied, type RelayWelcome, type ToMac } from './protocol.ts'

const HOME = process.env.HANNIGAN_MAC_HOME ?? join(homedir(), '.hannigan-mac')
const CONFIG_FILE = join(HOME, 'config.json')
const KEY_FILE = join(HOME, 'relay-key')
const TOKEN_FILE = join(HOME, 'bridge-token')
const PROJECTS_ROOT = join(homedir(), '.claude', 'projects')
const SERVER_NAME = 'hannigan'
const COMPONENT = 'mac-agent'

type Config = { relay_url: string; mac: string; cwd: string; claude_bin: string; local_port: number; idle_stop_minutes: number }

const argv = process.argv.slice(2)
if (argv[0] === 'pair') await pair(argv.slice(1))
else await run()

// ---------------------------------------------------------------- pairing
async function pair(a: string[]): Promise<void> {
  const flag = (name: string) => (a.includes(name) ? a[a.indexOf(name) + 1] : undefined)
  const [url, code] = a
  const mac = flag('--mac')
  const cwd = resolve(flag('--cwd') ?? homedir())
  if (!url || !code || !mac) {
    console.error('usage: mac-agent.ts pair https://host CODE --mac ID [--cwd FOLDER]')
    process.exit(2)
  }
  const r = await fetch(`${url.replace(/\/+$/, '')}${RELAY_PATH}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, mac }),
  })
  const body = (await r.json()) as { key?: string; error?: string }
  if (!r.ok || !body.key) {
    console.error(`pairing failed: ${body.error ?? r.status}`)
    process.exit(1)
  }
  mkdirSync(HOME, { recursive: true, mode: 0o700 })
  writeFileSync(KEY_FILE, body.key, { mode: 0o600 })
  const u = new URL(url)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  u.pathname = `${RELAY_PATH}/ws`
  const config: Config = {
    relay_url: u.toString(),
    mac,
    cwd,
    claude_bin: Bun.which('claude') ?? join(homedir(), '.local', 'bin', 'claude'),
    local_port: 8802,
    idle_stop_minutes: 30,
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  console.log(`paired as "${mac}". Claude Code runs in ${cwd}. Start the agent with: bun relay/mac-agent.ts`)
}

// ---------------------------------------------------------------- the agent
async function run(): Promise<void> {
  const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Config
  const relayKey = readFileSync(KEY_FILE, 'utf8').trim()
  // read by shared/tmux.ts at import: the agent's sessions stay on their own tmux server
  process.env.HANNIGAN_TMUX_BIN ??= join(import.meta.dir, 'tmux-hannigan.sh')
  const { SessionSpecSchema } = await import('../shared/config.ts')
  const { SessionManager, TERMINAL_STATES } = await import('../shared/session-manager.ts')
  const { Backoff, log } = await import('../shared/util.ts')
  type Manager = InstanceType<typeof SessionManager>
  type Bridge = Parameters<Manager['bridgeMessage']>[0]
  type WorkerEvent = Parameters<ConstructorParameters<typeof SessionManager>[0]['emit']>[0]

  // Claude Code gets the macOS permissions of the app that started its tmux server, and launchd's processes have none
  // (docs/verification/omb-mac-relay 2): Terminal.app starts the server, and the session `keepalive` shows it did
  const tmuxServerUp = () => spawnSync(process.env.HANNIGAN_TMUX_BIN!, ['has-session', '-t', '=keepalive']).status === 0
  async function ensureTmuxServer(): Promise<void> {
    if (tmuxServerUp()) return
    spawnSync('open', ['-a', 'Terminal', join(import.meta.dir, 'start-tmux-server.command')])
    for (let i = 0; i < 40 && !tmuxServerUp(); i++) await Bun.sleep(500)
    if (!tmuxServerUp()) log(COMPONENT, 'Terminal.app did not start the tmux server; computer use will lack macOS permissions')
  }

  if (!existsSync(TOKEN_FILE)) writeFileSync(TOKEN_FILE, randomUUID(), { mode: 0o600 })
  chmodSync(TOKEN_FILE, 0o600)
  const bridgeToken = readFileSync(TOKEN_FILE, 'utf8').trim()

  type Rpc = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: any; result?: any; error?: any }
  type Turn = { rpcId: number | string; ch: string; sentAt: number; output: boolean; cancelled: boolean; readySince: number }
  type Dialog = { prompt_id: string; kind: string; title: string; body: string; options: string[] }
  type Session = {
    id: string
    ch: string | null
    turn: Turn | null
    transcript: string | null
    offset: number
    partial: string
    tools: Set<string>
    lastActive: number
    dialog: Dialog | null // the terminal dialog on screen, latest rendering
    dialogTimer: ReturnType<typeof setTimeout> | null
    asking: boolean // its question card is open in the chat
  }

  const sessions = new Map<string, Session>()
  const sessionFor = (id: string): Session => {
    let s = sessions.get(id)
    if (!s) {
      s = { id, ch: null, turn: null, transcript: null, offset: 0, partial: '', tools: new Set(), lastActive: Date.now(), dialog: null, dialogTimer: null, asking: false }
      sessions.set(id, s)
    }
    return s
  }

  const INSTRUCTIONS = [
    `Messages from the user arrive as <channel source="${SERVER_NAME}" ...>. They come from the OpenMausBot chat app, not from this terminal.`,
    'Treat each one as the user speaking to you. Your normal text answers are shown to the user in that chat automatically; there is no reply tool.',
    'When a task needs the screen or a desktop app, use the computer-use tools.',
  ].join('\n')

  const manager: Manager = new SessionManager({
    component: COMPONENT,
    stateDir: join(HOME, 'sessions'),
    spec: SessionSpecSchema.parse({
      permission_mode: 'manual',
      allowed_tools: [],
      terminal_prompts: { dev_channel_warning: 'auto_accept', workspace_trust: 'auto_accept' },
    }),
    role: 'task',
    tmux: { prefix: 'hm', width: 160, height: 48 },
    claudeBin: cfg.claude_bin,
    bunBin: process.execPath,
    bridgeUrl: `ws://127.0.0.1:${cfg.local_port}/bridge`,
    bridgeTokenFile: TOKEN_FILE,
    bridgeToken,
    serverName: SERVER_NAME,
    maxSessions: 4,
    isTrustedDir: dir => dir === cfg.cwd, // the one folder the owner chose at pairing
    emit: e => onEvent(e),
    setupFor: () => ({ t: 'setup', server_name: SERVER_NAME, instructions: INSTRUCTIONS, tools: [] }),
    onToolCall: async () => ({ ok: false, text: 'no tools on this channel' }),
    pollMs: 500,
  })
  manager.restore()

  // ---------------------------------------------------------------- the relay link
  const epoch = randomUUID()
  const link = new ReliableLink<ToMac, FromMac>(onFrame, () => {
    log(COMPONENT, 'queue overflow; dropping the queue')
    link.reset()
  })
  const channels = new Set<string>()
  const backoff = new Backoff(1000, 30000)
  let relayEpoch: string | null = null

  const send = (ch: string | null, m: Rpc) => {
    if (ch && channels.has(ch)) link.send({ t: 'line', ch, line: JSON.stringify(m) })
  }
  const update = (s: Session, u: Record<string, unknown>) => send(s.ch, { jsonrpc: '2.0', method: 'session/update', params: { sessionId: s.id, update: u } })
  const say = (s: Session, text: string) => update(s, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })

  function connect(): void {
    const ws = new WebSocket(cfg.relay_url)
    let lastRx = Date.now()
    let ping: ReturnType<typeof setInterval> | null = null
    let live = false
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', mac: cfg.mac, key: relayKey, epoch, lastSeen: link.lastSeen } satisfies MacHello))
    ws.onmessage = ev => {
      lastRx = Date.now()
      const text = String(ev.data)
      if (text === '{"pong":1}') return
      if (!live) {
        const m = JSON.parse(text) as RelayWelcome | RelayDenied
        if (m.t === 'denied') {
          log(COMPONENT, 'relay refused this Mac', { reason: m.reason })
          return
        }
        if (relayEpoch && relayEpoch !== m.epoch) {
          // the relay restarted: its channels are gone, and so is its queue
          log(COMPONENT, 'relay restarted; ending the open channels', { channels: channels.size })
          for (const ch of [...channels]) closeChannel(ch)
          link.reset()
        }
        relayEpoch = m.epoch
        live = true
        backoff.reset()
        link.attach(t => ws.readyState === WebSocket.OPEN && ws.send(t))
        link.resume(m.lastSeen)
        ping = setInterval(() => {
          if (Date.now() - lastRx > DEAD_AFTER_MS) return ws.close()
          ws.send('{"ping":1}')
        }, PING_MS)
        log(COMPONENT, 'connected to the relay', { queued: link.pending })
        return
      }
      link.receive(text)
    }
    ws.onerror = () => {}
    ws.onclose = () => {
      if (ping) clearInterval(ping)
      if (live) {
        link.detach()
        log(COMPONENT, 'relay connection lost')
      }
      setTimeout(connect, backoff.next())
    }
  }

  function onFrame(f: ToMac): void {
    if (f.t === 'open') channels.add(f.ch)
    else if (f.t === 'close') closeChannel(f.ch)
    else onLine(f.ch, f.line)
  }

  // the acp-client is gone. Claude keeps running for the next prompt, but a turn with no reader stops here.
  function closeChannel(ch: string): void {
    channels.delete(ch)
    for (const [id, p] of pendingOut) {
      if (p.ch === ch) {
        pendingOut.delete(id)
        p.done({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'cancelled' } } })
      }
    }
    for (const s of sessions.values()) {
      if (s.ch !== ch) continue
      s.ch = null
      if (s.turn && !s.turn.cancelled) cancelTurn(s)
    }
  }

  // ---------------------------------------------------------------- ACP from the acp-client
  const pendingOut = new Map<string, { ch: string; done: (r: Rpc) => void }>()
  let outSeq = 0
  function ask(ch: string, method: string, params: unknown): Promise<Rpc> {
    const id = `mac-${++outSeq}`
    return new Promise(done => {
      pendingOut.set(id, { ch, done })
      send(ch, { jsonrpc: '2.0', id, method, params })
    })
  }

  function onLine(ch: string, line: string): void {
    let m: Rpc
    try {
      m = JSON.parse(line)
    } catch {
      return
    }
    if (m.method === 'session/prompt') {
      void prompt(ch, m).catch(e => send(ch, { jsonrpc: '2.0', id: m.id, error: { code: -32603, message: (e as Error).message } }))
    } else if (m.method === 'session/cancel') {
      const s = sessions.get(String(m.params?.sessionId))
      if (s?.turn) cancelTurn(s)
    } else if (!m.method && m.id !== undefined) {
      const p = pendingOut.get(String(m.id))
      pendingOut.delete(String(m.id))
      p?.done(m)
    }
  }

  async function prompt(ch: string, m: Rpc): Promise<void> {
    const s = sessionFor(String(m.params?.sessionId))
    if (s.turn) throw new Error('a turn is already running on this conversation')
    s.ch = ch
    s.lastActive = Date.now()
    const text = (Array.isArray(m.params?.prompt) ? m.params.prompt : [])
      .map((b: any) => (b?.type === 'text' ? b.text : b?.type === 'resource_link' ? `[${b.name ?? b.uri}](${b.uri})` : ''))
      .filter(Boolean)
      .join('\n')
    for (let i = 0; i < 24 && manager.find(s.id)?.state === 'stopping'; i++) await Bun.sleep(500)
    const rec = manager.find(s.id)
    if (!rec || TERMINAL_STATES.includes(rec.state)) await ensureTmuxServer()
    if (!rec) manager.create({ project: 'mac', cwd: cfg.cwd, key: s.id, name: 'OpenMausBot' })
    else if (TERMINAL_STATES.includes(rec.state)) manager.resume(s.id)
    drain(s) // what is already in the transcript belongs to earlier turns
    const how = manager.send(s.id, text, { chat_id: s.id })
    s.turn = { rpcId: m.id!, ch, sentAt: Date.now(), output: false, cancelled: false, readySince: 0 }
    log(COMPONENT, 'prompt', { session: s.id, chars: text.length, delivery: how })
  }

  function cancelTurn(s: Session): void {
    if (!s.turn) return
    s.turn.cancelled = true
    try {
      manager.interrupt(s.id)
    } catch (e) {
      log(COMPONENT, 'interrupt failed', { err: String(e) })
    }
  }

  // ---------------------------------------------------------------- dialogs and approvals -> the chat
  function onEvent(e: WorkerEvent): void {
    const s = 'session' in e && e.session ? sessions.get(e.session) : undefined
    if (!s) return
    if (e.kind === 'terminal_prompt') {
      if (e.prompt_kind === 'dev_channel_warning' || e.prompt_kind === 'workspace_trust') return // answered by the manager
      s.dialog = { prompt_id: e.prompt_id, kind: e.prompt_kind, title: e.title, body: e.body, options: e.options }
      // a dialog is seen while it is still drawing, as two prompts: open the card once the screen settles
      if (s.dialogTimer) clearTimeout(s.dialogTimer)
      s.dialogTimer = setTimeout(() => void openDialog(s), 700)
    } else if (e.kind === 'terminal_prompt_closed') {
      if (s.dialog?.prompt_id === e.prompt_id && !s.asking) {
        if (s.dialogTimer) clearTimeout(s.dialogTimer)
        s.dialog = null
      }
    } else if (e.kind === 'permission_request') {
      void askPermission(s, e)
    }
  }

  async function openDialog(s: Session): Promise<void> {
    const d = s.dialog
    const ch = s.ch
    if (!d || s.asking || !ch) return
    if (/needs macOS permissions/i.test(d.title)) {
      // nothing here can be approved from the chat: it needs the System Settings of this Mac
      s.dialog = null
      say(s, `\nこの Mac（${cfg.mac}）で Computer Use の権限が足りないよ。macOS の「プライバシーとセキュリティ」で、Claude Code を起動しているアプリに「アクセシビリティ」と「画面収録」を付けてね。\n`)
      cancelTurn(s)
      return
    }
    s.asking = true
    const isCu = d.kind === 'cu_app_approval'
    const options = isCu
      ? [
          { optionId: 'allow', name: '許可（この会話の間）', kind: 'allow_once' },
          { optionId: 'deny', name: '拒否', kind: 'reject_once' },
        ]
      : d.options.map((name, i) => ({ optionId: String(i), name: name.slice(0, 120), kind: /deny|don't|do not|no,|exit|reject|cancel/i.test(name) ? 'reject_once' : 'allow_once' }))
    // `interaction_` makes this a question card: OpenMausBot's approval levels, "full" included, never answer those
    const r = await ask(ch, 'session/request_permission', {
      sessionId: s.id,
      toolCall: {
        toolCallId: `interaction_${d.prompt_id}`,
        title: `${cfg.mac} の画面を操作する確認\n\n${d.title}\n${d.body}`.slice(0, 2000),
        kind: 'other',
        status: 'pending',
        rawInput: {},
      },
      options,
    })
    s.asking = false
    const now = s.dialog // the same dialog, maybe redrawn since the card opened
    s.dialog = null
    if (!now) return
    const picked = r.result?.outcome?.outcome === 'selected' ? String(r.result.outcome.optionId) : 'deny'
    try {
      if (isCu) {
        const want = picked === 'allow' ? /^Allow/i : /^Deny/i
        const idx = now.options.findIndex(o => want.test(o.trim()))
        if (picked !== 'allow') {
          // Claude's tool result only says nothing was granted: tell it first, or it asks again under another name
          manager.send(s.id, 'The user denied this computer-use request in the chat. Do not request it again under another name. Say that it was denied and stop.', { chat_id: s.id })
        }
        if (idx >= 0) manager.answerTerminal(s.id, now.prompt_id, idx)
        else manager.interrupt(s.id)
      } else if (/^\d+$/.test(picked)) {
        manager.answerTerminal(s.id, now.prompt_id, Number(picked))
      } else {
        manager.interrupt(s.id)
      }
    } catch (e) {
      log(COMPONENT, 'dialog answer failed', { err: String(e) })
    }
  }

  async function askPermission(s: Session, e: Extract<WorkerEvent, { kind: 'permission_request' }>): Promise<void> {
    if (!s.ch) return
    const r = await ask(s.ch, 'session/request_permission', {
      sessionId: s.id,
      toolCall: {
        toolCallId: `perm-${e.request_id}`,
        title: `${e.tool_name}: ${e.description}`.slice(0, 200),
        kind: e.tool_name === 'Bash' ? 'execute' : e.tool_name === 'Edit' || e.tool_name === 'Write' ? 'edit' : 'other',
        status: 'pending',
        rawInput: { preview: e.input_preview.slice(0, 1200) },
      },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    })
    const allow = r.result?.outcome?.outcome === 'selected' && r.result.outcome.optionId === 'allow'
    try {
      manager.answerApproval(s.id, e.request_id, allow ? 'allow' : 'deny')
    } catch (err) {
      log(COMPONENT, 'verdict failed', { err: String(err) })
    }
  }

  // ---------------------------------------------------------------- transcript -> chat text and tool cards
  function transcriptPath(s: Session): string | null {
    const conv = manager.find(s.id)?.conversation_id ?? s.id
    if (s.transcript?.endsWith(`${conv}.jsonl`)) return s.transcript
    let dirs: string[] = []
    try {
      dirs = readdirSync(PROJECTS_ROOT)
    } catch {}
    for (const d of dirs) {
      const f = join(PROJECTS_ROOT, d, `${conv}.jsonl`)
      if (existsSync(f)) {
        if (s.transcript && s.transcript !== f) {
          s.offset = 0
          s.partial = ''
        }
        return (s.transcript = f)
      }
    }
    return null
  }

  const safeInput = (input: unknown): Record<string, unknown> => {
    try {
      const text = JSON.stringify(input ?? {})
      return text.length <= 2000 ? JSON.parse(text) : { preview: text.slice(0, 2000) }
    } catch {
      return {}
    }
  }

  function drain(s: Session): void {
    const f = transcriptPath(s)
    if (!f) return
    const size = statSync(f).size
    if (size <= s.offset) return
    const fd = openSync(f, 'r')
    const buf = Buffer.alloc(size - s.offset)
    readSync(fd, buf, 0, buf.length, s.offset)
    closeSync(fd)
    s.offset = size
    const lines = (s.partial + buf.toString('utf8')).split('\n')
    s.partial = lines.pop() ?? ''
    if (!s.turn) return
    for (const line of lines) {
      let m: any
      try {
        m = JSON.parse(line)
      } catch {
        continue
      }
      if (m.isSidechain) continue
      const content = Array.isArray(m.message?.content) ? m.message.content : []
      if (m.type === 'assistant') {
        for (const b of content) {
          if (b.type === 'text' && b.text) {
            s.turn.output = true
            say(s, b.text + '\n')
          } else if (b.type === 'tool_use') {
            s.turn.output = true
            s.tools.add(b.id)
            update(s, { sessionUpdate: 'tool_call', toolCallId: b.id, title: String(b.name), kind: b.name === 'Bash' ? 'execute' : 'other', status: 'in_progress', rawInput: safeInput(b.input) })
          }
        }
      } else if (m.type === 'user') {
        for (const b of content) {
          if (b.type === 'tool_result' && s.tools.has(b.tool_use_id)) {
            s.tools.delete(b.tool_use_id)
            update(s, { sessionUpdate: 'tool_call_update', toolCallId: b.tool_use_id, status: b.is_error ? 'failed' : 'completed' })
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------- turn end: interactive Claude prints no `result`
  function finish(s: Session, stopReason: string, note?: string): void {
    const t = s.turn
    if (!t) return
    try {
      drain(s)
    } catch {}
    if (note) say(s, note)
    for (const id of s.tools) update(s, { sessionUpdate: 'tool_call_update', toolCallId: id, status: t.cancelled ? 'failed' : 'completed' })
    s.tools.clear()
    s.turn = null
    s.lastActive = Date.now()
    log(COMPONENT, 'turn end', { session: s.id, stopReason })
    send(t.ch, { jsonrpc: '2.0', id: t.rpcId, result: { stopReason } })
  }

  setInterval(() => {
    const now = Date.now()
    for (const s of sessions.values()) {
      try {
        drain(s)
      } catch (e) {
        log(COMPONENT, 'drain failed', { err: String(e) })
      }
      const t = s.turn
      const state = manager.find(s.id)?.state ?? 'stopped'
      if (!t) {
        // a session keeps the computer-use lock until it exits: an idle one gives it back and resumes at the next prompt
        if (state === 'ready' && now - s.lastActive > cfg.idle_stop_minutes * 60000) {
          log(COMPONENT, 'stopping an idle session', { session: s.id })
          manager.stop(s.id)
        }
        continue
      }
      if (TERMINAL_STATES.includes(state)) {
        finish(s, 'refusal', `Claude Code のセッションが終了した（${state}）`)
        continue
      }
      if (state !== 'ready') {
        t.readySince = 0
        continue
      }
      t.readySince ||= now
      const quiet = now - t.readySince
      if (t.cancelled && quiet >= 800) finish(s, 'cancelled')
      else if (t.output && quiet >= 2500) finish(s, 'end_turn')
      else if (!t.output && now - t.sentAt > 30000 && quiet >= 20000) finish(s, 'end_turn', '（Claude からの出力がなかった）')
    }
  }, 500)

  // ---------------------------------------------------------------- the channel's local WebSocket
  Bun.serve<{ kind: 'bridge'; key?: string }>({
    hostname: '127.0.0.1',
    port: cfg.local_port,
    fetch(req, srv) {
      if (new URL(req.url).pathname === '/bridge' && srv.upgrade(req, { data: { kind: 'bridge' } })) return
      return new Response('not found', { status: 404 })
    },
    websocket: {
      message: (ws: Bridge, raw) => manager.bridgeMessage(ws, raw as string),
      close: (ws: Bridge) => manager.bridgeClosed(ws),
    },
  })

  // sessions left running by an earlier agent reconnect on their own; they belong to no conversation until a prompt
  for (const r of manager.records()) sessionFor(r.key)
  await ensureTmuxServer()
  log(COMPONENT, 'started', { mac: cfg.mac, cwd: cfg.cwd, relay: cfg.relay_url, sessions: manager.records().length })
  connect()
}
