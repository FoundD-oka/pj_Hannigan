#!/usr/bin/env bun
// Worker daemon: connects out to the hub, runs Claude Code sessions in tmux, relays results.
// docs/design/02-worker-daemon.md
import { z } from 'zod'
import { readFileSync } from 'fs'
import { join } from 'path'
import { ConfigError, loadWorkerConfig } from '../shared/config.ts'
import {
  COMMANDS,
  CommandError,
  PROTO,
  VERSION,
  parseJson,
  type HubCommand,
  type WorkerEvent,
  type WorkerHello,
  type ConfigSetResult,
  type WorkerResult,
} from '../shared/protocol.ts'
import { ensureSecret, readSecret, secretPath } from '../shared/secrets.ts'
import { SessionManager, TERMINAL_STATES, type BridgeSocket, type SessionRecord } from '../shared/session-manager.ts'
import type { SessionState } from '../shared/protocol.ts'
import { Backoff, ensureDir, log, writeJsonAtomic } from '../shared/util.ts'
import { planConfigSet, projectInfo } from './config-set.ts'
import { Dispatcher } from './dispatch.ts'
import { BaselineStore, LeaseManager, osVerifier } from './lease.ts'
import { Outbox } from './outbox.ts'
import { Router } from './pm.ts'
import { ReceivedLedger } from './received.ts'
import { TranscriptAdapter } from './transcript.ts'

let cfg: ReturnType<typeof loadWorkerConfig>
try {
  cfg = loadWorkerConfig()
} catch (e) {
  if (e instanceof ConfigError) {
    process.stderr.write(e.message + '\n')
    process.exit(2)
  }
  throw e
}
const home = cfg.home
const stateDir = ensureDir(join(home, 'worker'))
const workerKey = readSecret(home, 'worker-key')
if (!workerKey) {
  process.stderr.write(`hannigan worker: ${secretPath(home, 'worker-key')} is missing. Run scripts/dev-setup.ts (Phase 2) or pair (Phase 3).\n`)
  process.exit(2)
}
const bridgeToken = ensureSecret(home, 'local-bridge-token.worker')
const outbox = new Outbox(join(stateDir, 'outbox.jsonl'), cfg.outbox.max_events)
const C = 'worker'

// ---------------------------------------------------------------- hub link
let hub: WebSocket | null = null
let hubReady = false
const backoff = new Backoff()
const resultCache = new Map<string, WorkerResult>() // command id -> result (last 200)

function emit(e: WorkerEvent): void {
  const m = outbox.push(e)
  if (hub && hubReady) hub.send(JSON.stringify(m))
}

// folders only in command results, never in events (they are recorded in the hub's event log)
const projectInfos = (withPath = false) => cfg.projects.map(p => projectInfo(p, withPath))

function inventory(): void {
  emit({ kind: 'inventory', projects: projectInfos(), sessions: manager.list() })
}

function connectHub(): void {
  const ws = new WebSocket(cfg.hub_url)
  hub = ws
  ws.onopen = () => {
    const hello: WorkerHello = { t: 'hello', proto: PROTO, worker_id: cfg.worker_id, key: workerKey!, version: VERSION, next_seq: outbox.next }
    ws.send(JSON.stringify(hello))
  }
  ws.onmessage = ev => {
    const m = parseJson<{ t: string; [k: string]: unknown }>(String(ev.data))
    if (!m) return
    if (m.t === 'welcome') {
      hubReady = true
      backoff.reset()
      const last = Number(m.last_seq ?? 0)
      outbox.ack(last)
      const backlog = outbox.after(last)
      for (const e of backlog) ws.send(JSON.stringify(e))
      log(C, 'connected to hub', { hub: cfg.hub_url, resent: backlog.length })
      inventory()
    } else if (m.t === 'ack') {
      outbox.ack(Number(m.seq))
    } else if (m.t === 'command') {
      void runCommand(m as unknown as HubCommand).then(r => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(r)))
    } else if (m.t === 'bye') {
      log(C, 'hub closed the connection', { reason: m.reason })
    }
  }
  ws.onclose = () => {
    const wasReady = hubReady
    hubReady = false
    if (hub === ws) hub = null
    const d = backoff.next()
    if (wasReady) log(C, 'hub connection lost; reconnecting', { in_ms: d })
    setTimeout(connectHub, d)
  }
  ws.onerror = () => {}
}

// ---------------------------------------------------------------- commands
const A = {
  session_create: z.object({ project: z.string(), name: z.string().max(80).optional(), chat_id: z.string().max(64).nullish() }),
  session: z.object({ session: z.string() }),
  approval_answer: z.object({ session: z.string(), request_id: z.string().regex(/^[a-km-z]{5}$/), behavior: z.enum(['allow', 'deny']) }),
  terminal_answer: z.object({ session: z.string(), prompt_id: z.string(), option: z.number().int().min(0) }),
}

function parseArgs<T>(schema: z.ZodType<T>, args: unknown): T {
  const r = schema.safeParse(args ?? {})
  if (!r.success) throw new CommandError('bad_args', r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '))
  return r.data
}

async function execute(c: HubCommand): Promise<unknown> {
  if (!COMMANDS.includes(c.name)) throw new CommandError('unknown_command', `unknown command ${String(c.name)}`)
  switch (c.name) {
    case 'list':
      return { projects: projectInfos(true), sessions: manager.list() }
    case 'session_create': {
      const a = parseArgs(A.session_create, c.args)
      const p = cfg.projects.find(x => x.id === a.project)
      if (!p) throw new CommandError('not_found', `no project "${a.project}". known: ${cfg.projects.map(x => x.id).join(', ')}`)
      const s = manager.create({ project: p.id, cwd: p.path, name: a.name, chat_id: a.chat_id })
      inventory()
      return { session: s }
    }
    case 'session_resume':
      return router.sessionResume(c.args) // a PM: pm_ensure
    case 'session_send':
      return router.sessionSend(c.args) // tasks without a PM only; through the dispatcher and the lease
    // session_stop / session_interrupt stay open for every role: they are the human control paths
    case 'pm_ensure':
      return router.pmEnsure(c.args)
    case 'pm_send':
      return router.pmSend(c.args)
    case 'thread_direct_send':
      return router.threadDirectSend(c.args)
    case 'session_interrupt':
      return { status: manager.interrupt(parseArgs(A.session, c.args).session) }
    case 'session_stop':
      return { status: manager.stop(parseArgs(A.session, c.args).session) }
    case 'approval_answer': {
      const a = parseArgs(A.approval_answer, c.args)
      return { status: manager.answerApproval(a.session, a.request_id, a.behavior) }
    }
    case 'terminal_answer': {
      const a = parseArgs(A.terminal_answer, c.args)
      return { status: manager.answerTerminal(a.session, a.prompt_id, a.option) }
    }
    case 'config_set':
      return configSet(c.args)
  }
}

// settings screen (01 §25): replace projects[] in worker.json and in memory without a restart
function configSet(args: unknown): ConfigSetResult {
  const file = join(home, 'worker.json')
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    throw new CommandError('internal', `worker.json を読めませんでした: ${(e as Error).message}`)
  }
  const sessions = manager.records().map(s => ({ key: s.key, project: s.project, role: s.role, name: s.name, state: s.state }))
  const plan = planConfigSet(args, cfg.projects, sessions, raw)
  try {
    writeJsonAtomic(file, plan.file)
  } catch (e) {
    throw new CommandError('internal', `worker.json を保存できませんでした（設定は変わっていません）: ${(e as Error).message}`)
  }
  // the router, the trust check and the launch guard all read cfg.projects at use time
  cfg.projects = plan.projects
  leases.writeWorkspaces(cfg.projects.map(p => p.path))
  log(C, 'projects updated from the settings screen', { projects: cfg.projects.length })
  inventory()
  dispatcher.pump()
  return { projects: projectInfos(true), pm_restart_needed: plan.pmRestartNeeded }
}

async function runCommand(c: HubCommand): Promise<WorkerResult> {
  const cached = resultCache.get(c.id)
  if (cached) return cached
  let r: WorkerResult
  try {
    r = { t: 'result', id: c.id, ok: true, data: await execute(c) }
  } catch (e) {
    const ce = e instanceof CommandError ? e : new CommandError('internal', String((e as Error).message ?? e))
    r = { t: 'result', id: c.id, ok: false, error: { code: ce.code, message: ce.message } }
  }
  log(C, 'command', { id: c.id, name: c.name, ok: r.ok, ...(r.ok ? {} : { error: r.error.code }) })
  resultCache.set(c.id, r)
  if (resultCache.size > 200) resultCache.delete(resultCache.keys().next().value!)
  return r
}

// ---------------------------------------------------------------- sessions, leases, deliveries
const received = new ReceivedLedger(join(stateDir, 'received.jsonl'))
const leases: LeaseManager = new LeaseManager({
  stateDir,
  emit,
  verify: osVerifier(stateDir, key => manager.panePid(key)),
  ownerStatus: key => {
    const s = manager.find(key)
    return !s ? 'missing' : TERMINAL_STATES.includes(s.state) ? 'terminal' : 'live'
  },
})
const baselines = new BaselineStore(stateDir)
const transcripts = new TranscriptAdapter({ stateDir, home, emit, redactSensitive: cfg.thread_observation.redact_sensitive })
const router: Router = new Router({
  cfg,
  stateDir,
  emit,
  inventory,
  leases,
  received,
  manager: () => manager,
  dispatcher: () => dispatcher,
})

// owner idle -> release_pending -> verified -> released (Q16/A). A short debounce keeps a queued channel
// message that Claude picks up right after a turn from losing the lease in between.
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
function onStateChange(s: SessionRecord, prev: SessionState, next: SessionState): void {
  if (next === 'starting' && Router.observed(s) && cfg.thread_observation.mode === 'transcript') transcripts.watch(watched(s))
  if (TERMINAL_STATES.includes(next)) {
    transcripts.unwatch(s.key)
    if (leases.releaseOwned(s.key, 'owner_stopped')) dispatcher.pump()
    return
  }
  if (next === 'ready' && prev !== 'ready') {
    clearTimeout(idleTimers.get(s.key))
    idleTimers.set(
      s.key,
      setTimeout(() => {
        idleTimers.delete(s.key)
        const cur = manager.find(s.key)
        if (cur?.state === 'ready' && leases.releaseOwned(s.key, 'owner_idle')) dispatcher.pump()
      }, 1500),
    )
  }
  dispatcher.pump()
}
const watched = (s: SessionRecord) => ({ key: s.key, project: s.project, role: s.role, pm_session: s.pm_session, cwd: s.cwd, conversation_id: s.conversation_id })

const manager: SessionManager = new SessionManager({
  component: C,
  stateDir,
  spec: cfg.session,
  specByRole: { pm: cfg.pm_session, task: cfg.session },
  role: 'task',
  tmux: cfg.tmux,
  claudeBin: cfg.claude_bin,
  bunBin: cfg.bun_bin,
  bridgeUrl: `ws://${cfg.local.host}:${cfg.local.port}/bridge`,
  bridgeTokenFile: secretPath(home, 'local-bridge-token.worker'),
  bridgeToken,
  serverName: 'hannigan',
  maxSessions: cfg.max_sessions,
  resumeBlocked: s => router.resumeBlocked(s),
  isTrustedDir: dir => cfg.projects.some(p => p.path === dir),
  emit,
  setupFor: s => router.setupFor(s),
  onToolCall: (s, name, args) => router.onToolCall(s, name, args),
  launchExtras: s => router.launchExtras(s),
  onStateChange,
})

const dispatcher: Dispatcher = new Dispatcher({
  file: join(stateDir, 'deliveries.jsonl'),
  manager,
  leases,
  onStatus: (d, prev) => router.onDeliveryStatus(d, prev),
  baseline: s => baselines.for(s.key, manager.panePid(s.key)),
  prepare: d => router.prepare(d),
})

// ---------------------------------------------------------------- local server (bridges)
Bun.serve<{ kind: 'bridge'; key?: string }>({
  hostname: cfg.local.host,
  port: cfg.local.port,
  fetch(req, server) {
    const url = new URL(req.url)
    if (url.pathname === '/bridge' && server.upgrade(req, { data: { kind: 'bridge' } })) return
    if (url.pathname === '/health') return Response.json({ ok: true, worker: cfg.worker_id, hub: hubReady, outbox: outbox.size })
    return new Response('not found', { status: 404 })
  },
  websocket: {
    message: (ws, raw) => manager.bridgeMessage(ws as BridgeSocket, raw as string),
    close: ws => manager.bridgeClosed(ws as BridgeSocket),
  },
})

manager.restore()
leases.restore()
// every project folder is guarded, also against writes from sessions of other projects (lease-guard.ts)
leases.writeWorkspaces(cfg.projects.map(p => p.path))
dispatcher.restore()
if (cfg.thread_observation.mode === 'transcript') {
  for (const s of manager.records()) if (Router.observed(s) && !TERMINAL_STATES.includes(s.state)) transcripts.watch(watched(s))
  transcripts.start()
}
const ticker = setInterval(() => {
  try {
    leases.tick()
    dispatcher.pump()
  } catch (e) {
    log(C, 'tick error', { err: String(e) })
  }
}, 1000)
log(C, 'worker started', { worker: cfg.worker_id, local: `${cfg.local.host}:${cfg.local.port}`, projects: cfg.projects.length })
connectHub()

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    // sessions keep running in tmux; the next daemon start picks them up again
    log(C, 'worker stopping (sessions keep running)', { signal: sig })
    clearInterval(ticker)
    transcripts.close()
    manager.close()
    process.exit(0)
  })
}
