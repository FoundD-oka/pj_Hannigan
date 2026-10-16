// Launches Claude Code sessions in tmux, tracks their state from the screen and the bridge,
// and relays terminal-only dialogs. Shared by the worker daemon and the hub (for the secretary).
// See docs/design/02-worker-daemon.md.
import type { ServerWebSocket } from 'bun'
import { randomUUID } from 'crypto'
import { existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { SessionSpec } from './config.ts'
import { ACCEPT_LABEL, keysToSelect, parsePane, type TerminalPrompt } from './pane.ts'
import {
  CommandError,
  type BridgeSetup,
  type FromBridge,
  type SessionInfo,
  type SessionRole,
  type SessionState,
  type ToBridge,
  type WorkerEvent,
  parseJson,
} from './protocol.ts'
import { safeEqual } from './secrets.ts'
import * as tmux from './tmux.ts'
import { ensureDir, log, nowIso, readJson, rid, writeJsonAtomic } from './util.ts'

export type BridgeSocket = ServerWebSocket<{ kind: 'bridge'; key?: string }>

export type SessionRecord = SessionInfo & {
  cwd: string
  tmux: string
  last_chat_id: string | null
  claude_session_id: string | null
}

type Runtime = {
  bridge: BridgeSocket | null
  bridgeReady: boolean
  pending: Extract<ToBridge, { t: 'deliver' }>[]
  openRequests: Map<string, number> // request_id -> received at
  prompt: TerminalPrompt | null
  startingSince: number
  busyUntil: number
  stopRequested: boolean
  answeredPromptId: string | null
}

export type ManagerOptions = {
  component: string
  stateDir: string
  spec: SessionSpec
  // spec per role (e.g. worker pm_session); falls back to spec
  specByRole?: Partial<Record<SessionRole, SessionSpec>>
  // role of sessions created without an explicit role, and of Phase 2 records restored without one
  role: SessionRole
  tmux: { prefix: string; width: number; height: number }
  claudeBin: string
  bunBin: string
  bridgeUrl: string
  bridgeTokenFile: string
  bridgeToken: string
  serverName: string
  maxSessions: number
  // why a stopped session must not be resumed (worker: its project was removed or moved in the settings), or null
  resumeBlocked?: (s: SessionRecord) => string | null
  isTrustedDir: (dir: string) => boolean
  emit: (e: WorkerEvent) => void
  setupFor: (s: SessionInfo & { cwd: string }) => BridgeSetup
  onToolCall: (s: SessionRecord, name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; text: string }>
  pollMs?: number
  startTimeoutMs?: number
  // extra argv / env for a launch (worker: write-lease guard `--settings` for pm / task sessions)
  launchExtras?: (s: SessionRecord) => { args: string[]; env: Record<string, string> } | null
  // every state change, after the session_state event (worker: lease release on idle, transcript watch)
  onStateChange?: (s: SessionRecord, prev: SessionState, next: SessionState) => void
  // the bridge confirmed it wrote a deliver to Claude Code (03 §3 `delivered`)
  onDelivered?: (s: SessionRecord, deliverId: string) => void
  // messages accepted by send() while the bridge was not ready, still unsent when the session ended
  // (hub: re-queued for the conversation; never dropped silently)
  onUndelivered?: (s: SessionRecord, msgs: { content: string; meta: Record<string, string> }[]) => void
}

export const TERMINAL_STATES: SessionState[] = ['stopped', 'exited', 'failed']
const TERMINAL = TERMINAL_STATES
const BRIDGE_SCRIPT = join(import.meta.dir, 'bridge.ts')

export class SessionManager {
  private sessions = new Map<string, SessionRecord>()
  private rt = new Map<string, Runtime>()
  private file: string
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private o: ManagerOptions) {
    ensureDir(o.stateDir)
    this.file = join(o.stateDir, 'sessions.json')
  }

  // ------------------------------------------------------------ lifecycle
  restore(): void {
    const saved = readJson<SessionRecord[]>(this.file, [])
    const live = new Set(tmux.listSessions())
    for (const s of saved) {
      // Phase 2 records carry no role: they are taken over as the manager's default role (role=task on workers)
      s.role ??= this.o.role
      s.pm_session ??= null
      this.sessions.set(s.key, s)
      this.rt.set(s.key, this.newRuntime())
      if (!TERMINAL.includes(s.state)) {
        if (live.has(s.tmux)) {
          s.state = 'starting' // re-derived from the bridge and the screen
        } else {
          s.state = 'stopped'
        }
      }
    }
    this.persist()
    this.timer = setInterval(() => this.poll(), this.o.pollMs ?? 1000)
  }

  close(): void {
    if (this.timer) clearInterval(this.timer)
  }

  private newRuntime(): Runtime {
    return {
      bridge: null,
      bridgeReady: false,
      pending: [],
      openRequests: new Map(),
      prompt: null,
      startingSince: Date.now(),
      busyUntil: 0,
      stopRequested: false,
      answeredPromptId: null,
    }
  }

  private persist(): void {
    writeJsonAtomic(this.file, [...this.sessions.values()])
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map(s => this.info(s))
  }

  get(key: string): SessionRecord {
    const s = this.sessions.get(key)
    if (!s) throw new CommandError('not_found', `no session ${key}`)
    return s
  }

  private info(s: SessionRecord): SessionInfo {
    return {
      key: s.key,
      project: s.project,
      name: s.name,
      role: s.role,
      pm_session: s.pm_session,
      ...(s.context_id !== undefined ? { context_id: s.context_id } : {}),
      state: s.state,
      created_at: s.created_at,
      updated_at: s.updated_at,
      conversation_id: s.conversation_id,
    }
  }

  private setState(s: SessionRecord, state: SessionState, detail?: string): void {
    if (s.state === state) return
    const prev = s.state
    s.state = state
    s.updated_at = nowIso()
    this.persist()
    this.o.emit({
      kind: 'session_state',
      session: s.key,
      project: s.project,
      role: s.role,
      pm_session: s.pm_session,
      state,
      ...(detail ? { detail } : {}),
    })
    this.notifyState(s, prev, state)
  }

  private notifyState(s: SessionRecord, prev: SessionState, next: SessionState): void {
    try {
      this.o.onStateChange?.(s, prev, next)
    } catch (e) {
      log(this.o.component, 'onStateChange error', { session: s.key, err: String(e) })
    }
  }

  // the record of a session, or undefined (no throw)
  find(key: string): SessionRecord | undefined {
    return this.sessions.get(key)
  }

  records(): SessionRecord[] {
    return [...this.sessions.values()]
  }

  isBridgeReady(key: string): boolean {
    const rt = this.rt.get(key)
    return !!rt && !!rt.bridge && rt.bridgeReady
  }

  // PID of Claude Code in the tmux pane, or null when the pane is gone
  panePid(key: string): number | null {
    const s = this.sessions.get(key)
    return s ? tmux.panePid(s.tmux) : null
  }

  specOf(s: { role: SessionRole }): SessionSpec {
    return this.o.specByRole?.[s.role] ?? this.o.spec
  }

  // settings screen (hub: secretary.contexts.max_active); running sessions above a lowered limit keep running
  setMaxSessions(n: number): void {
    this.o.maxSessions = n
  }

  // ------------------------------------------------------------ commands
  private ensureSlot(): void {
    const running = [...this.sessions.values()].filter(s => !TERMINAL.includes(s.state)).length
    if (running >= this.o.maxSessions) throw new CommandError('busy', `max_sessions (${this.o.maxSessions}) reached`)
  }

  create(a: {
    project: string
    cwd: string
    name?: string
    chat_id?: string | null
    key?: string
    role?: SessionRole
    pm_session?: string | null
    context_id?: string | null
  }): SessionInfo {
    this.ensureSlot()
    // the folder path stays in the local log; the error (sent to the hub) names the project only
    if (!existsSync(a.cwd)) {
      log(this.o.component, 'project folder does not exist', { project: a.project, cwd: a.cwd })
      throw new CommandError('not_found', `the folder of project "${a.project}" does not exist on this worker`)
    }
    const key = a.key ?? randomUUID()
    const s: SessionRecord = {
      key,
      project: a.project,
      name: a.name?.slice(0, 80) || a.project,
      role: a.role ?? this.o.role,
      pm_session: a.pm_session ?? null,
      ...(a.context_id !== undefined ? { context_id: a.context_id } : {}),
      state: 'starting',
      created_at: nowIso(),
      updated_at: nowIso(),
      conversation_id: key,
      cwd: a.cwd,
      tmux: `${this.o.tmux.prefix}-${a.project}-${key.slice(0, 8)}`,
      last_chat_id: a.chat_id ?? null,
      claude_session_id: null,
    }
    this.sessions.set(key, s)
    this.rt.set(key, this.newRuntime())
    this.launch(s, false)
    this.notifyState(s, 'stopped', 'starting')
    return this.info(s)
  }

  resume(key: string, chat_id?: string | null): SessionInfo {
    const s = this.get(key)
    if (!TERMINAL.includes(s.state)) throw new CommandError('invalid_state', `session is ${s.state}; only stopped sessions can be resumed`)
    const blocked = this.o.resumeBlocked?.(s)
    if (blocked) throw new CommandError('invalid_state', blocked)
    this.ensureSlot() // a resumed session counts like a new one (max_sessions)
    if (tmux.hasSession(s.tmux)) tmux.killSession(s.tmux)
    if (chat_id) s.last_chat_id = chat_id
    this.rt.set(key, this.newRuntime())
    const prev = s.state
    s.state = 'starting'
    s.updated_at = nowIso()
    this.launch(s, true)
    this.o.emit({ kind: 'session_state', session: s.key, project: s.project, role: s.role, pm_session: s.pm_session, state: 'starting' })
    this.notifyState(s, prev, 'starting')
    return this.info(s)
  }

  private launch(s: SessionRecord, resume: boolean): void {
    const spec = this.specOf(s)
    const extras = this.o.launchExtras?.(s) ?? null
    const cfgFile = join(this.o.stateDir, `bridge-${s.key}.json`)
    writeFileSync(
      cfgFile,
      JSON.stringify({
        mcpServers: {
          [this.o.serverName]: {
            command: this.o.bunBin,
            args: [BRIDGE_SCRIPT],
            env: {
              HANNIGAN_BRIDGE_URL: this.o.bridgeUrl,
              HANNIGAN_BRIDGE_TOKEN_FILE: this.o.bridgeTokenFile,
              HANNIGAN_SESSION_KEY: s.key,
            },
          },
        },
      }),
      { mode: 0o600 },
    )
    const argv = [
      this.o.claudeBin,
      ...(resume ? ['--resume', s.conversation_id] : ['--session-id', s.key]),
      '--permission-mode',
      spec.permission_mode,
      '--mcp-config',
      cfgFile,
      '--dangerously-load-development-channels',
      `server:${this.o.serverName}`,
      ...(spec.model ? ['--model', spec.model] : []),
      ...(spec.builtin_tools != null ? ['--tools', spec.builtin_tools] : []),
      ...(spec.allowed_tools.length ? ['--allowedTools', spec.allowed_tools.join(',')] : []),
      ...(extras?.args ?? []),
      ...spec.extra_args,
    ]
    const env: Record<string, string> = {
      HOME: process.env.HOME ?? '',
      USER: process.env.USER ?? '',
      LOGNAME: process.env.LOGNAME ?? process.env.USER ?? '',
      SHELL: process.env.SHELL ?? '/bin/zsh',
      PATH: process.env.PATH ?? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      TERM: 'xterm-256color',
      LANG: process.env.LANG ?? 'ja_JP.UTF-8',
      ...(process.env.TERM_PROGRAM ? { TERM_PROGRAM: process.env.TERM_PROGRAM } : {}),
      ...spec.env,
      ...(extras?.env ?? {}),
    }
    const r = tmux.newSession({ name: s.tmux, cwd: s.cwd, width: this.o.tmux.width, height: this.o.tmux.height, env, argv })
    log(this.o.component, 'session launch', { session: s.key, tmux: s.tmux, resume, ok: r.ok })
    if (!r.ok) {
      log(this.o.component, 'tmux new-session failed', { session: s.key, err: r.err.trim() })
      this.setState(s, 'failed', 'tmux new-session failed (see the worker log)')
      throw new CommandError('internal', `tmux new-session failed for a session of project "${s.project}" (see the worker log)`)
    }
    this.persist()
  }

  send(key: string, text: string, meta: Record<string, string>, chat_id?: string | null): 'delivered' | 'queued' {
    const s = this.get(key)
    if (TERMINAL.includes(s.state) || s.state === 'stopping')
      throw new CommandError('invalid_state', `session is ${s.state}; resume it first`)
    const rt = this.rt.get(key)!
    if (chat_id) {
      s.last_chat_id = chat_id
      this.persist()
    }
    const msg: Extract<ToBridge, { t: 'deliver' }> = { t: 'deliver', id: rid('d'), content: text, meta }
    rt.busyUntil = Date.now() + 4000
    if (rt.bridge && rt.bridgeReady) {
      rt.bridge.send(JSON.stringify(msg))
      return 'delivered'
    }
    if (rt.pending.length >= 30) throw new CommandError('busy', 'too many queued messages for a session that is not connected yet')
    rt.pending.push(msg)
    return 'queued'
  }

  interrupt(key: string): 'key_sent' {
    const s = this.get(key)
    if (!tmux.sendKeys(s.tmux, ['Escape'])) throw new CommandError('invalid_state', 'tmux session not found')
    log(this.o.component, 'interrupt sent', { session: key })
    return 'key_sent'
  }

  stop(key: string): 'stopping' | 'already_stopped' {
    const s = this.get(key)
    if (TERMINAL.includes(s.state)) return 'already_stopped'
    const rt = this.rt.get(key)!
    rt.stopRequested = true
    this.setState(s, 'stopping')
    // the timers below must only touch this launch: a resume reuses the tmux name with a new runtime
    const same = () => this.rt.get(key) === rt && s.state === 'stopping'
    tmux.sendKeys(s.tmux, ['Escape'])
    setTimeout(() => {
      if (!same()) return
      tmux.sendLiteral(s.tmux, '/exit')
      setTimeout(() => same() && tmux.sendKeys(s.tmux, ['Enter']), 300)
    }, 300)
    setTimeout(() => {
      if (same() && tmux.hasSession(s.tmux)) {
        log(this.o.component, 'stop: /exit timed out, killing tmux session', { session: key })
        tmux.killSession(s.tmux)
      }
    }, 10000)
    return 'stopping'
  }

  answerApproval(key: string, request_id: string, behavior: 'allow' | 'deny'): 'verdict_sent' {
    const s = this.get(key)
    const rt = this.rt.get(key)!
    if (!rt.openRequests.has(request_id)) throw new CommandError('stale', `request ${request_id} is not open`)
    if (!rt.bridge) throw new CommandError('invalid_state', 'bridge not connected')
    rt.bridge.send(JSON.stringify({ t: 'verdict', request_id, behavior } satisfies ToBridge))
    rt.openRequests.delete(request_id)
    this.o.emit({ kind: 'permission_closed', session: s.key, request_id, reason: `webchat:${behavior}` })
    return 'verdict_sent'
  }

  answerTerminal(key: string, prompt_id: string, option: number): 'keys_sent' {
    const s = this.get(key)
    const screen = tmux.capture(s.tmux)
    if (screen == null) throw new CommandError('invalid_state', 'tmux session not found')
    const p = parsePane(screen).prompt
    if (!p || p.prompt_id !== prompt_id) throw new CommandError('stale', 'the dialog is no longer on screen')
    if (!Number.isInteger(option) || option < 0 || option >= p.options.length)
      throw new CommandError('bad_args', `option must be 0..${p.options.length - 1}`)
    this.selectOption(s, p, option)
    return 'keys_sent'
  }

  private selectOption(s: SessionRecord, p: TerminalPrompt, option: number): void {
    const keys = keysToSelect(p.cursor, option)
    log(this.o.component, 'terminal answer', { session: s.key, kind: p.kind, option: p.options[option] })
    const rt = this.rt.get(s.key)!
    rt.answeredPromptId = p.prompt_id
    // send one key at a time; some dialogs ignore keys sent in a single burst
    let delay = 0
    for (const k of keys) {
      setTimeout(() => tmux.sendKeys(s.tmux, [k]), delay)
      delay += 150
    }
    rt.startingSince = Date.now() + delay
  }

  // ------------------------------------------------------------ bridge
  bridgeMessage(ws: BridgeSocket, raw: string | Buffer): void {
    const m = parseJson<FromBridge>(raw)
    if (!m) return
    if (m.t === 'hello') {
      if (!safeEqual(m.token ?? '', this.o.bridgeToken)) {
        ws.send(JSON.stringify({ t: 'bye', reason: 'auth' } satisfies ToBridge))
        ws.close()
        return
      }
      const s = this.sessions.get(m.session_key)
      if (!s) {
        ws.send(JSON.stringify({ t: 'bye', reason: 'unknown session' } satisfies ToBridge))
        ws.close()
        return
      }
      ws.data.key = s.key
      const rt = this.rt.get(s.key)!
      if (rt.bridge && rt.bridge !== ws) rt.bridge.close()
      rt.bridge = ws
      rt.bridgeReady = false
      s.claude_session_id = m.claude_session_id
      if (m.claude_session_id && m.claude_session_id !== s.conversation_id) s.conversation_id = m.claude_session_id
      this.persist()
      ws.send(JSON.stringify(this.o.setupFor({ ...this.info(s), cwd: s.cwd })))
      log(this.o.component, 'bridge connected', { session: s.key, pid: m.pid })
      return
    }
    const key = ws.data.key
    if (!key) return
    const s = this.sessions.get(key)
    const rt = this.rt.get(key)
    if (!s || !rt) return
    switch (m.t) {
      case 'ready':
        rt.bridgeReady = true
        for (const d of rt.pending.splice(0)) ws.send(JSON.stringify(d))
        return
      case 'delivered':
        try {
          this.o.onDelivered?.(s, m.id)
        } catch {}
        return
      case 'tool_call':
        void this.o
          .onToolCall(s, m.name, m.args)
          .catch(e => ({ ok: false, text: `hannigan: ${(e as Error).message}` }))
          .then(r => ws.send(JSON.stringify({ t: 'tool_result', id: m.id, ok: r.ok, text: r.text } satisfies ToBridge)))
        return
      case 'permission_request':
        rt.openRequests.set(m.request_id, Date.now())
        this.o.emit({
          kind: 'permission_request',
          session: s.key,
          project: s.project,
          request_id: m.request_id,
          tool_name: m.tool_name,
          description: m.description,
          input_preview: m.input_preview,
        })
        this.setState(s, 'awaiting_approval')
        return
    }
  }

  bridgeClosed(ws: BridgeSocket): void {
    const key = ws.data.key
    if (!key) return
    const rt = this.rt.get(key)
    if (rt && rt.bridge === ws) {
      rt.bridge = null
      rt.bridgeReady = false
    }
  }

  // ------------------------------------------------------------ screen polling
  private poll(): void {
    for (const s of this.sessions.values()) {
      if (TERMINAL.includes(s.state)) continue
      try {
        this.pollOne(s)
      } catch (e) {
        log(this.o.component, 'poll error', { session: s.key, err: String(e) })
      }
    }
  }

  private pollOne(s: SessionRecord): void {
    const rt = this.rt.get(s.key)!
    const screen = tmux.capture(s.tmux)
    if (screen == null) return this.onGone(s, rt)
    const pane = parsePane(screen)
    const now = Date.now()

    // terminal-only dialogs (tool permission dialogs are relayed by the bridge instead)
    const p = pane.prompt && pane.prompt.kind !== 'tool_permission' ? pane.prompt : null
    if (rt.prompt && (!p || p.prompt_id !== rt.prompt.prompt_id)) {
      this.o.emit({
        kind: 'terminal_prompt_closed',
        session: s.key,
        prompt_id: rt.prompt.prompt_id,
        reason: rt.answeredPromptId === rt.prompt.prompt_id ? 'answered' : 'gone',
      })
      rt.prompt = null
    }
    if (p && !rt.prompt) {
      rt.prompt = p
      const spec = this.specOf(s)
      const policy =
        p.kind === 'dev_channel_warning'
          ? spec.terminal_prompts.dev_channel_warning
          : p.kind === 'workspace_trust'
            ? spec.terminal_prompts.workspace_trust
            : 'relay'
      const label = ACCEPT_LABEL[p.kind]
      const idx = label ? p.options.findIndex(o => label.test(o)) : -1
      const trustOk = p.kind !== 'workspace_trust' || this.o.isTrustedDir(s.cwd)
      this.o.emit({
        kind: 'terminal_prompt',
        session: s.key,
        project: s.project,
        prompt_id: p.prompt_id,
        prompt_kind: p.kind,
        title: p.title,
        body: p.body,
        options: p.options,
        cursor: p.cursor,
      })
      if (policy === 'auto_accept' && idx >= 0 && trustOk && rt.answeredPromptId !== p.prompt_id) {
        log(this.o.component, 'auto_accept terminal prompt', { session: s.key, kind: p.kind })
        this.selectOption(s, p, idx)
      }
    }

    // permission requests answered in the terminal (or otherwise gone)
    if (rt.openRequests.size && pane.prompt?.kind !== 'tool_permission') {
      for (const [id, at] of rt.openRequests) {
        if (now - at > 4000) {
          rt.openRequests.delete(id)
          this.o.emit({ kind: 'permission_closed', session: s.key, request_id: id, reason: 'resolved_elsewhere' })
        }
      }
    }

    if (s.state === 'stopping') return
    let next: SessionState
    if (rt.prompt) next = 'awaiting_terminal'
    else if (rt.openRequests.size) next = 'awaiting_approval'
    else if (!rt.bridgeReady) next = 'starting'
    else if (pane.working || now < rt.busyUntil) next = 'working'
    else if (pane.inputReady) next = 'ready'
    else next = s.state === 'starting' || s.state === 'awaiting_terminal' ? 'starting' : s.state
    if (next !== 'starting') rt.startingSince = now
    if (next === 'starting' && rt.startingSince && now - rt.startingSince > (this.o.startTimeoutMs ?? 90000)) {
      // the screen may show paths and file contents: it stays in the local log, the hub gets one line
      const tailLines = screen.split('\n').filter(l => l.trim()).slice(-20).join('\n')
      log(this.o.component, 'session did not become ready in time', { session: s.key, screen: tailLines })
      this.setState(s, 'failed', 'did not become ready in time (screen tail in the local log)')
      tmux.killSession(s.tmux)
      return
    }
    this.setState(s, next)
  }

  private onGone(s: SessionRecord, rt: Runtime): void {
    for (const id of rt.openRequests.keys()) {
      this.o.emit({ kind: 'permission_closed', session: s.key, request_id: id, reason: 'session_ended' })
    }
    rt.openRequests.clear()
    if (rt.prompt) {
      this.o.emit({ kind: 'terminal_prompt_closed', session: s.key, prompt_id: rt.prompt.prompt_id, reason: 'session_ended' })
      rt.prompt = null
    }
    // handed back before the state change, so the owner can queue them again for the next launch
    const undelivered = rt.pending.splice(0).map(d => ({ content: d.content, meta: d.meta }))
    if (undelivered.length) {
      log(this.o.component, 'session ended with undelivered messages', { session: s.key, count: undelivered.length })
      try {
        this.o.onUndelivered?.(s, undelivered)
      } catch (e) {
        log(this.o.component, 'onUndelivered error', { session: s.key, err: String(e) })
      }
    }
    this.setState(s, rt.stopRequested || s.state === 'stopping' ? 'stopped' : 'exited')
  }
}
