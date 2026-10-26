#!/usr/bin/env bun
// ACP agent over stdio that runs an interactive Claude Code session in tmux with Hannigan's SessionManager, so that
// OpenMausBot's customAcp engine can drive native computer use (which `claude -p` cannot load).
// Verification spike: docs/verification/omb-native-cu/README.md. Not used by the hub or the worker.
//
// Mapping
//   session/prompt          -> channel deliver (bridge); text and tool calls come back from the transcript
//   turn end                -> pane back to `ready` after transcript output (no `result` in interactive mode)
//   terminal dialogs        -> session/request_permission (CU app approval, folder trust, ...) -> keys in tmux
//   channel permission relay-> session/request_permission -> verdict over the channel
//   session/cancel          -> Esc into tmux
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'fs'
import { randomBytes, randomUUID } from 'crypto'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { createInterface } from 'readline'
import { SessionSpecSchema } from '../../shared/config.ts'
import type { BridgeSetup, WorkerEvent } from '../../shared/protocol.ts'
import { SessionManager, TERMINAL_STATES, type BridgeSocket } from '../../shared/session-manager.ts'
import * as tmux from '../../shared/tmux.ts'

// OpenMausBot checks a custom engine with `<cli> --version` before using it
if (process.argv.includes('--version')) {
  console.log('hannigan-omb-acp 0.0.1')
  process.exit(0)
}

const ROOT = process.env.HANNIGAN_OMB_ACP_DIR ?? join(tmpdir(), 'hannigan-omb-acp')
// computer-use is enabled per project folder (/mcp), so the spike runs Claude in a folder where it is already on
const FORCED_CWD = process.env.HANNIGAN_OMB_ACP_CWD ?? null
const CLAUDE_BIN = process.env.HANNIGAN_OMB_ACP_CLAUDE ?? 'claude'
const PROJECTS_ROOT = join(homedir(), '.claude', 'projects')
const SERVER_NAME = 'omb'
mkdirSync(ROOT, { recursive: true, mode: 0o700 })
// OpenMausBot does not keep an engine's stderr: copy it (ours and SessionManager's) to a log file
const LOG_FILE = join(ROOT, 'acp.log')
const stderrWrite = process.stderr.write.bind(process.stderr)
process.stderr.write = ((chunk: any, ...rest: any[]) => {
  try {
    appendFileSync(LOG_FILE, chunk)
  } catch {}
  return stderrWrite(chunk, ...rest)
}) as typeof process.stderr.write
const TOKEN_FILE = join(ROOT, 'bridge-token')
if (!existsSync(TOKEN_FILE)) writeFileSync(TOKEN_FILE, randomBytes(24).toString('hex'), { mode: 0o600 })
const TOKEN = readFileSync(TOKEN_FILE, 'utf8').trim()

const debug = (msg: string, extra?: Record<string, unknown>) =>
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), c: 'omb-acp', msg, ...(extra ?? {}) }) + '\n')

// ---------------------------------------------------------------- JSON-RPC over stdio
type Rpc = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: any; result?: any; error?: any }
const write = (m: Rpc) => process.stdout.write(JSON.stringify(m) + '\n')
const pendingOut = new Map<string, (r: Rpc) => void>()
let outSeq = 0
function request(method: string, params: unknown): Promise<Rpc> {
  const id = `omb-acp-${++outSeq}`
  write({ jsonrpc: '2.0', id, method, params })
  return new Promise(r => pendingOut.set(id, r))
}
const notify = (method: string, params: unknown) => write({ jsonrpc: '2.0', method, params })
const update = (sessionId: string, u: Record<string, unknown>) => notify('session/update', { sessionId, update: u })

// ---------------------------------------------------------------- sessions
type Turn = {
  resolve: (stopReason: string) => void
  sentAt: number
  output: boolean // the transcript showed assistant output for this turn
  cancelled: boolean
  readySince: number
}
type AcpSession = {
  id: string // ACP sessionId = Claude conversation id = SessionManager key
  cwd: string
  manager: SessionManager | null
  turn: Turn | null
  transcript: string | null
  offset: number
  partial: string
  tools: Set<string>
}
const sessions = new Map<string, AcpSession>()
// SessionManager names the tmux session `<prefix>-<project>-<key[0..8]>`
const tmuxName = (id: string) => `omb-omb-${id.slice(0, 8)}`

const KIND_LABEL: Record<string, string> = {
  cu_app_approval: 'Computer Use のアプリ承認',
  workspace_trust: 'フォルダの信頼確認',
  dev_channel_warning: '開発用チャネルの起動確認',
  unknown: '端末の確認',
}

const INSTRUCTIONS = [
  `Messages from the user arrive as <channel source="${SERVER_NAME}" ...>. They come from the OpenMausBot chat app, not from this terminal.`,
  'Treat each one as the user speaking to you. Your normal text answers are shown to the user in that chat automatically; there is no reply tool.',
  'When a task needs the screen or a desktop app, use the computer-use tools.',
].join('\n')

function managerFor(s: AcpSession): SessionManager {
  if (s.manager) return s.manager
  const m = new SessionManager({
    component: 'omb-acp',
    stateDir: join(ROOT, 'sessions', s.id),
    spec: SessionSpecSchema.parse({
      permission_mode: 'manual',
      allowed_tools: [],
      terminal_prompts: { dev_channel_warning: 'auto_accept', workspace_trust: 'relay' },
    }),
    role: 'task',
    tmux: { prefix: 'omb', width: 160, height: 48 },
    claudeBin: CLAUDE_BIN,
    bunBin: process.execPath,
    bridgeUrl: `ws://127.0.0.1:${server.port}/bridge`,
    bridgeTokenFile: TOKEN_FILE,
    bridgeToken: TOKEN,
    serverName: SERVER_NAME,
    maxSessions: 1,
    isTrustedDir: () => false,
    emit: e => onEvent(s, e),
    setupFor: () => ({ t: 'setup', server_name: SERVER_NAME, instructions: INSTRUCTIONS, tools: [] }) satisfies BridgeSetup,
    onToolCall: async () => ({ ok: false, text: 'no tools on this channel' }),
    pollMs: 500,
  })
  m.restore()
  s.manager = m
  return m
}

// ---------------------------------------------------------------- dialogs and approvals -> approval cards
function onEvent(s: AcpSession, e: WorkerEvent): void {
  debug('event', { session: s.id, kind: e.kind, ...('state' in e ? { state: e.state } : {}), ...('prompt_kind' in e ? { prompt_kind: e.prompt_kind } : {}) })
  if (e.kind === 'terminal_prompt') {
    if (e.prompt_kind === 'dev_channel_warning') return // auto-accepted by the manager (our own channel)
    const options = e.options.map((name, i) => ({
      optionId: String(i),
      name,
      kind: /deny|don't|do not|no,|exit|reject|cancel/i.test(name) ? 'reject_once' : 'allow_once',
    }))
    void request('session/request_permission', {
      sessionId: s.id,
      toolCall: {
        toolCallId: `dialog-${e.prompt_id}`,
        title: `${KIND_LABEL[e.prompt_kind] ?? e.prompt_kind}: ${e.title}`.slice(0, 200),
        kind: 'other',
        status: 'pending',
        rawInput: { dialog: e.body.slice(0, 1200), options: e.options },
      },
      options,
    }).then(r => {
      const picked = r.result?.outcome?.outcome === 'selected' ? Number(r.result.outcome.optionId) : options.findIndex(o => o.kind === 'reject_once')
      debug('dialog answer', { session: s.id, prompt_id: e.prompt_id, option: e.options[picked] ?? null })
      try {
        if (picked >= 0) s.manager!.answerTerminal(s.id, e.prompt_id, picked)
        else s.manager!.interrupt(s.id)
      } catch (err) {
        debug('dialog answer failed', { err: String(err) })
      }
    })
    return
  }
  if (e.kind === 'permission_request') {
    void request('session/request_permission', {
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
    }).then(r => {
      const allow = r.result?.outcome?.outcome === 'selected' && r.result.outcome.optionId === 'allow'
      try {
        s.manager!.answerApproval(s.id, e.request_id, allow ? 'allow' : 'deny')
      } catch (err) {
        debug('verdict failed', { err: String(err) })
      }
    })
  }
}

// ---------------------------------------------------------------- transcript -> chat text and tool cards
function transcriptPath(s: AcpSession): string | null {
  if (s.transcript) return s.transcript
  let dirs: string[] = []
  try {
    dirs = readdirSync(PROJECTS_ROOT)
  } catch {}
  for (const d of dirs) {
    const f = join(PROJECTS_ROOT, d, `${s.id}.jsonl`)
    if (existsSync(f)) return (s.transcript = f)
  }
  return null
}

function drain(s: AcpSession): void {
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
          if (s.turn) s.turn.output = true
          update(s.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: b.text + '\n' } })
        } else if (b.type === 'tool_use') {
          if (s.turn) s.turn.output = true
          s.tools.add(b.id)
          update(s.id, {
            sessionUpdate: 'tool_call',
            toolCallId: b.id,
            title: String(b.name),
            kind: String(b.name).startsWith('mcp__computer-use__') ? 'other' : b.name === 'Bash' ? 'execute' : 'other',
            status: 'in_progress',
            rawInput: safeRawInput(b.input),
          })
        }
      }
    } else if (m.type === 'user') {
      for (const b of content) {
        if (b.type === 'tool_result' && s.tools.has(b.tool_use_id)) {
          s.tools.delete(b.tool_use_id)
          update(s.id, { sessionUpdate: 'tool_call_update', toolCallId: b.tool_use_id, status: b.is_error ? 'failed' : 'completed' })
        }
      }
    }
  }
}

function safeRawInput(input: unknown): Record<string, unknown> {
  try {
    const text = JSON.stringify(input ?? {})
    return text.length <= 2000 ? JSON.parse(text) : { preview: text.slice(0, 2000) }
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------- turn end
setInterval(() => {
  for (const s of sessions.values()) {
    if (!s.manager) continue
    try {
      drain(s)
    } catch (err) {
      debug('drain failed', { err: String(err) })
    }
    const t = s.turn
    if (!t) continue
    const rec = s.manager.find(s.id)
    const state = rec?.state ?? 'stopped'
    const now = Date.now()
    if (TERMINAL_STATES.includes(state)) {
      finish(s, 'refusal', `Claude Code の端末セッションが終了した（${state}）`)
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

function finish(s: AcpSession, stopReason: string, note?: string): void {
  const t = s.turn
  if (!t) return
  try {
    drain(s)
  } catch {}
  if (note) update(s.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: note } })
  for (const id of s.tools) update(s.id, { sessionUpdate: 'tool_call_update', toolCallId: id, status: t.cancelled ? 'failed' : 'completed' })
  s.tools.clear()
  s.turn = null
  debug('turn end', { session: s.id, stopReason })
  t.resolve(stopReason)
}

// ---------------------------------------------------------------- ACP methods
async function handle(m: Rpc): Promise<unknown> {
  const p = m.params ?? {}
  switch (m.method) {
    case 'initialize':
      return {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: false } },
        authMethods: [],
        agentInfo: { name: 'hannigan-omb-acp', title: 'Claude Code (interactive, Hannigan)', version: '0.0.1' },
      }
    case 'session/new': {
      // Claude starts at the first prompt, so OpenMausBot's model discovery sessions never launch one
      const id = randomUUID()
      sessions.set(id, { id, cwd: FORCED_CWD ?? p.cwd, manager: null, turn: null, transcript: null, offset: 0, partial: '', tools: new Set() })
      debug('session/new', { session: id, cwd: FORCED_CWD ?? p.cwd, omb_cwd: p.cwd })
      return { sessionId: id }
    }
    case 'session/load': {
      // a session of an earlier adapter process: resume the same Claude conversation (--resume)
      const id = String(p.sessionId ?? '')
      if (!existsSync(join(ROOT, 'sessions', id, 'sessions.json'))) throw Object.assign(new Error('unknown session'), { code: -32602, data: { sessionId: id } })
      const s: AcpSession = { id, cwd: FORCED_CWD ?? p.cwd, manager: null, turn: null, transcript: null, offset: 0, partial: '', tools: new Set() }
      sessions.set(id, s)
      // a Claude left running by a killed adapter still dials the old bridge port: end it and resume the conversation
      tmux.killSession(tmuxName(id))
      const mgr = managerFor(s)
      const rec = mgr.find(id)
      if (rec && TERMINAL_STATES.includes(rec.state)) mgr.resume(id)
      const f = transcriptPath(s)
      s.offset = f ? statSync(f).size : 0
      debug('session/load', { session: id, state: mgr.find(id)?.state })
      return {}
    }
    case 'session/prompt': {
      const s = sessions.get(String(p.sessionId))
      if (!s) throw Object.assign(new Error('unknown session'), { code: -32602 })
      if (s.turn) throw Object.assign(new Error('a turn is already running'), { code: -32600 })
      const text = (Array.isArray(p.prompt) ? p.prompt : [])
        .map((b: any) => (b?.type === 'text' ? b.text : b?.type === 'resource_link' ? `[${b.name ?? b.uri}](${b.uri})` : ''))
        .filter(Boolean)
        .join('\n')
      const mgr = managerFor(s)
      const rec = mgr.find(s.id)
      if (!rec) mgr.create({ project: 'omb', cwd: s.cwd, key: s.id, name: 'OpenMausBot' })
      else if (TERMINAL_STATES.includes(rec.state)) mgr.resume(s.id)
      const f = transcriptPath(s)
      if (f) drain(s) // skip anything older than this turn
      const how = mgr.send(s.id, text, { chat_id: s.id })
      debug('session/prompt', { session: s.id, chars: text.length, delivery: how, head: text.slice(0, 300) })
      return new Promise(resolve => {
        s.turn = { resolve: stopReason => resolve({ stopReason }), sentAt: Date.now(), output: false, cancelled: false, readySince: 0 }
      })
    }
    default:
      throw Object.assign(new Error(`method not found: ${m.method}`), { code: -32601 })
  }
}

function onNotification(m: Rpc): void {
  if (m.method === 'session/cancel') {
    const s = sessions.get(String(m.params?.sessionId))
    if (!s?.manager || !s.turn) return
    s.turn.cancelled = true
    try {
      s.manager.interrupt(s.id)
    } catch (err) {
      debug('interrupt failed', { err: String(err) })
    }
  }
}

// ---------------------------------------------------------------- wiring
const server = Bun.serve<{ kind: 'bridge'; key?: string }>({
  hostname: '127.0.0.1',
  port: 0,
  fetch(req, srv) {
    if (new URL(req.url).pathname === '/bridge' && srv.upgrade(req, { data: { kind: 'bridge' } })) return
    return new Response('not found', { status: 404 })
  },
  websocket: {
    message(ws: BridgeSocket, raw) {
      let key = ws.data.key
      if (!key) {
        try {
          key = JSON.parse(String(raw)).session_key
        } catch {}
      }
      const s = key ? sessions.get(key) : undefined
      if (s?.manager) s.manager.bridgeMessage(ws, raw as string)
      else ws.close()
    },
    close(ws: BridgeSocket) {
      const s = ws.data.key ? sessions.get(ws.data.key) : undefined
      s?.manager?.bridgeClosed(ws)
    },
  },
})

const rl = createInterface({ input: process.stdin })
rl.on('line', line => {
  let m: Rpc
  try {
    m = JSON.parse(line)
  } catch {
    return
  }
  if (m.method && m.id !== undefined) {
    debug('rpc in', { method: m.method })
    handle(m).then(
      result => write({ jsonrpc: '2.0', id: m.id, result: result ?? null }),
      (err: any) => write({ jsonrpc: '2.0', id: m.id, error: { code: err.code ?? -32603, message: String(err.message ?? err), ...(err.data ? { data: err.data } : {}) } }),
    )
  } else if (m.method) {
    onNotification(m)
  } else if (m.id !== undefined) {
    pendingOut.get(String(m.id))?.(m)
    pendingOut.delete(String(m.id))
  }
})
rl.on('close', () => {
  // OpenMausBot closed the engine: end the Claude sessions (they also hold the computer-use lock); session/load resumes them
  for (const s of sessions.values()) {
    try {
      if (s.manager?.find(s.id)) s.manager.stop(s.id)
    } catch {}
  }
  setTimeout(() => process.exit(0), 3000)
})
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(sig, () => {
    for (const s of sessions.values()) if (s.manager) tmux.killSession(tmuxName(s.id))
    process.exit(0)
  })
}
debug('ready', { bridge_port: server.port, root: ROOT, forced_cwd: FORCED_CWD })
