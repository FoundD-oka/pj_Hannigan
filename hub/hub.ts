#!/usr/bin/env bun
// Hub: serves WebChat, accepts worker connections, runs one secretary Claude session per conversation and their tools.
// docs/design/00-architecture.md, 03-hub-worker-protocol.md
// Modules: contexts.ts (per-conversation secretaries), requests.ts (request_id -> context), offline-queue.ts (Q12/C),
// ledger.ts (shared work items), threads.ts (WebChat thread view), secretary.ts (tools and instructions).
import type { Server as BunServer, ServerWebSocket } from 'bun'
import { readFileSync } from 'fs'
import { hostname, userInfo } from 'os'
import { join, sep } from 'path'
import { canonical, ConfigError, ID_RE, loadHubConfig } from '../shared/config.ts'
import {
  CommandError,
  PROTO,
  VERSION,
  cleanMeta,
  parseJson,
  type CommandName,
  type ConfigSetResult,
  type DeliveryStatus,
  type ErrorCode,
  type HubCommand,
  type OfflineRequest,
  type OfflineRequestState,
  type PmSendResult,
  type ProjectInfo,
  type SessionInfo,
  type ThreadDirectSendResult,
  type WorkerEvent,
  type WorkerEventMsg,
  type WorkerHello,
  type WorkerResult,
} from '../shared/protocol.ts'
import { ensureSecret, readWorkerKeys, safeEqual, secretPath } from '../shared/secrets.ts'
import { SessionManager, type BridgeSocket } from '../shared/session-manager.ts'
import { EventLog, ensureDir, log, readJson, rid, writeJsonAtomic, type SeqEvent } from '../shared/util.ts'
import { CONTEXT_ID_RE, ContextStore, LIVE_STATES, evictionCandidate, idleContexts } from './contexts.ts'
import { Ledger } from './ledger.ts'
import { OfflineQueue } from './offline-queue.ts'
import { RequestStore, type RequestState } from './requests.ts'
import { SECRETARY_TOOLS, secretaryInstructions } from './secretary.ts'
import { planHubSettings, SettingsError } from './settings.ts'
import { secondMacPromptTemplate } from '../shared/second-mac-prompt.ts'
import { buildThreads, coverageOf, nextCoverage, threadHistory, type Coverage } from './threads.ts'

let cfg: ReturnType<typeof loadHubConfig>
try {
  cfg = loadHubConfig()
} catch (e) {
  if (e instanceof ConfigError) {
    process.stderr.write(e.message + '\n')
    process.exit(2)
  }
  throw e
}
const C = 'hub'
const home = cfg.home
const stateDir = ensureDir(join(home, 'hub'))
ensureDir(cfg.secretaryDir)
cfg.secretaryDir = canonical(cfg.secretaryDir)
const contextsRoot = canonical(ensureDir(cfg.contextsDir))
const webToken = ensureSecret(home, 'webchat-token')
const bridgeToken = ensureSecret(home, 'local-bridge-token.hub')
// duplicate keys of WebChat posts: /api/send by msg_id, /api/thread/send by (worker, session, msg_id)
const msgKey = (msg_id: unknown) => `um\0${String(msg_id)}`
const directKey = (worker: unknown, session: unknown, msg_id: unknown) => `ud\0${String(worker)}\0${String(session)}\0${String(msg_id)}`
const events = new EventLog(join(stateDir, 'events.jsonl'), e =>
  e.kind === 'user_message' ? msgKey(e.msg_id) : e.kind === 'user_direct' ? directKey(e.worker, e.session, e.msg_id) : null,
)
const SECRETARY = '_secretary'
const ID = /^[A-Za-z0-9_-]{1,64}$/
const ENDED = ['stopped', 'exited', 'failed']

const contexts = new ContextStore(join(stateDir, 'contexts.json'), contextsRoot)
const requests = new RequestStore(join(stateDir, 'requests.json'), join(stateDir, 'session-owners.json'))
const ledger = new Ledger(cfg.ledgerPath)
const queue = new OfflineQueue({
  file: cfg.offlineQueuePath,
  ttlMinutes: cfg.offline_queue.ttl_minutes,
  maxPendingPerWorker: cfg.offline_queue.max_pending_per_worker,
})

// ---------------------------------------------------------------- workers
type WsData = { kind: 'worker'; worker?: string } | { kind: 'bridge'; key?: string }
type WorkerConn = {
  id: string
  ws: ServerWebSocket<WsData> | null
  connected: boolean
  version: string | null
  projects: ProjectInfo[]
  sessions: Map<string, SessionInfo>
  pending: Map<string, (r: WorkerResult) => void>
  dispatchOnInventory: boolean
}
const workers = new Map<string, WorkerConn>()
const lastSeq = readJson<Record<string, number>>(join(stateDir, 'workers.json'), {})
const saveSeq = () => writeJsonAtomic(join(stateDir, 'workers.json'), lastSeq)
const leases = new Map<string, SeqEvent>() // `${worker}/${resource_id}` -> latest resource_lease_state event
const seenEntries = new Set<string>() // `${worker}/${entry_id}` of recorded thread_entry events

function workerConn(id: string): WorkerConn {
  let w = workers.get(id)
  if (!w) {
    w = { id, ws: null, connected: false, version: null, projects: [], sessions: new Map(), pending: new Map(), dispatchOnInventory: false }
    workers.set(id, w)
  }
  return w
}
for (const w of cfg.workers) workerConn(w.id)

const displayName = (id: string) =>
  id === SECRETARY ? cfg.secretary.persona.name : (cfg.workers.find(w => w.id === id)?.display_name ?? id)
const isConnected = (id: string) => !!workers.get(id)?.connected
const knownWorker = (id: string) => id !== SECRETARY && (cfg.workers.some(w => w.id === id) || workers.has(id))
const strip = <T extends { kind: string }>(e: T): Omit<T, 'kind'> => {
  const { kind: _k, ...rest } = e
  return rest
}

// `sent` tells whether the command left the hub: a failure after sending (timeout, disconnect) is an unknown outcome
type CmdResult = WorkerResult & { sent: boolean }
function sendCommand(workerId: string, name: CommandName, args: Record<string, unknown>, timeoutMs = 30000): Promise<CmdResult> {
  const w = workers.get(workerId)
  const id = rid('c')
  if (!w || !w.connected || !w.ws) {
    return Promise.resolve({ t: 'result', id, ok: false, sent: false, error: { code: 'worker_offline', message: `worker "${workerId}" is not connected` } })
  }
  const cmd: HubCommand = { t: 'command', id, name, args }
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      w.pending.delete(id)
      resolve({ t: 'result', id, ok: false, sent: true, error: { code: 'timeout', message: `no answer from "${workerId}" in ${timeoutMs / 1000}s` } })
    }, timeoutMs)
    w.pending.set(id, r => {
      clearTimeout(timer)
      resolve({ ...r, sent: true })
    })
    w.ws!.send(JSON.stringify(cmd))
  })
}
const unknownOutcome = (r: CmdResult) => !r.ok && r.sent && (r.error.code === 'timeout' || r.error.code === 'worker_offline')

// rebuild the last known inventory from the event log so threads stay visible while a worker is offline
function restoreInventory(): void {
  for (const e of events.events) {
    if (typeof e.worker !== 'string' || e.worker === SECRETARY) continue
    if (e.kind === 'inventory') {
      const w = workerConn(e.worker)
      w.projects = (e.projects as ProjectInfo[]) ?? []
      w.sessions = new Map(((e.sessions as SessionInfo[]) ?? []).map(s => [s.key, s]))
    } else if (e.kind === 'session_state') {
      const w = workerConn(e.worker)
      const prev = w.sessions.get(String(e.session))
      if (prev) prev.state = e.state as SessionInfo['state']
    } else if (e.kind === 'resource_lease_state') {
      leases.set(`${e.worker}/${e.resource_id}`, e)
    } else if (e.kind === 'thread_entry') {
      seenEntries.add(`${e.worker}/${e.entry_id}`)
    }
  }
}

function workerHello(ws: ServerWebSocket<WsData>, m: WorkerHello): void {
  const keys = readWorkerKeys(home)
  const expected = keys[m.worker_id]
  if (m.proto !== PROTO || !expected || !safeEqual(m.key ?? '', expected)) {
    log(C, 'worker auth rejected', { worker: m.worker_id })
    events.record('notice', { level: 'warn', text: `ワーカー「${m.worker_id}」の接続を拒否しました（認証失敗）` })
    ws.send(JSON.stringify({ t: 'bye', reason: 'auth' }))
    ws.close()
    return
  }
  const w = workerConn(m.worker_id)
  if (w.ws && w.ws !== ws) {
    w.ws.send(JSON.stringify({ t: 'bye', reason: 'replaced' }))
    w.ws.close()
  }
  ;(ws.data as { worker?: string }).worker = m.worker_id
  w.ws = ws
  w.connected = true
  w.version = m.version
  w.dispatchOnInventory = true
  ws.send(JSON.stringify({ t: 'welcome', proto: PROTO, hub_version: VERSION, last_seq: lastSeq[m.worker_id] ?? 0 }))
  events.record('worker_link', { worker: m.worker_id, connected: true })
  log(C, 'worker connected', { worker: m.worker_id, version: m.version })
  // held requests go out after the inventory sync (03 §2.3.1); fall back to a timer if none arrives
  setTimeout(() => {
    if (w.ws === ws && w.dispatchOnInventory) {
      w.dispatchOnInventory = false
      void dispatchOffline(m.worker_id)
    }
  }, 5000)
}

function workerClosed(ws: ServerWebSocket<WsData>): void {
  const id = (ws.data as { worker?: string }).worker
  if (!id) return
  const w = workers.get(id)
  if (!w || w.ws !== ws) return
  w.ws = null
  w.connected = false
  for (const [cid, done] of w.pending) {
    done({ t: 'result', id: cid, ok: false, error: { code: 'worker_offline', message: 'worker disconnected' } })
  }
  w.pending.clear()
  events.record('worker_link', { worker: id, connected: false })
  log(C, 'worker disconnected', { worker: id })
  const active = [...w.sessions.values()].filter(s => !ENDED.includes(s.state))
  if (!active.length) return
  // only conversations that drive work on this worker hear about it (no broadcast to every secretary)
  const targets = new Set<string>()
  for (const o of requests.ownedOn(id)) if (active.some(s => s.key === o.session)) targets.add(o.context_id)
  for (const r of requests.open(id)) targets.add(r.context_id)
  for (const ctx of targets) {
    deliverToContext(
      ctx,
      `ワーカー「${displayName(id)}」との接続が切れました。動いていたセッション: ${active.map(s => s.key).join(', ')}。ワーカーは自動で再接続を試みます。`,
      { kind: 'worker_event', worker: id },
    )
  }
}

function workerMessage(ws: ServerWebSocket<WsData>, raw: string): void {
  const m = parseJson<{ t: string; [k: string]: unknown }>(raw)
  if (!m) return
  const id = (ws.data as { worker?: string }).worker
  if (m.t === 'hello') return workerHello(ws, m as unknown as WorkerHello)
  if (!id) return
  const w = workerConn(id)
  if (m.t === 'event') {
    const em = m as unknown as WorkerEventMsg
    const last = lastSeq[id] ?? 0
    if (em.seq <= last) {
      ws.send(JSON.stringify({ t: 'ack', seq: em.seq }))
      return
    }
    if (em.seq > last + 1) log(C, 'event seq gap', { worker: id, expected: last + 1, got: em.seq })
    lastSeq[id] = em.seq
    saveSeq()
    try {
      handleWorkerEvent(id, em.event)
    } catch (e) {
      log(C, 'event handling error', { worker: id, err: String(e) })
    }
    ws.send(JSON.stringify({ t: 'ack', seq: em.seq }))
  } else if (m.t === 'result') {
    const r = m as unknown as WorkerResult
    const done = w.pending.get(r.id)
    w.pending.delete(r.id)
    done?.(r)
  }
}

// ---------------------------------------------------------------- approvals
type Approval = {
  approval_id: string
  worker: string
  session: string
  project: string
  type: 'tool' | 'terminal'
  request_id?: string
  prompt_id?: string
  prompt_kind?: string
  title: string
  body: string
  options: string[]
  context_id?: string | null
  created_at: string
}
const approvalsFile = join(stateDir, 'approvals.json')
const approvals = new Map<string, Approval>(readJson<Approval[]>(approvalsFile, []).map(a => [a.approval_id, a]))
const saveApprovals = () => writeJsonAtomic(approvalsFile, [...approvals.values()])

function openApproval(a: Omit<Approval, 'approval_id' | 'created_at'>): void {
  const context_id = a.worker === SECRETARY ? (contexts.byKey(a.session)?.context_id ?? null) : null
  const ap: Approval = { ...a, ...(a.worker === SECRETARY ? { context_id } : {}), approval_id: rid('ap', 6), created_at: new Date().toISOString() }
  approvals.set(ap.approval_id, ap)
  saveApprovals()
  events.record('approval_open', { ...ap, worker_name: displayName(ap.worker) })
}

function closeApproval(match: (a: Approval) => boolean, result: string, by: string): void {
  for (const a of approvals.values()) {
    if (!match(a)) continue
    approvals.delete(a.approval_id)
    saveApprovals()
    events.record('approval_closed', { approval_id: a.approval_id, result, by })
  }
}

// ---------------------------------------------------------------- per-conversation secretaries (Q6/B)
const secretaries: SessionManager = new SessionManager({
  component: 'hub.secretary',
  stateDir: ensureDir(join(stateDir, 'secretary')),
  spec: cfg.secretary.session,
  role: 'secretary',
  tmux: { ...cfg.tmux, prefix: cfg.tmux.prefix },
  claudeBin: cfg.claude_bin,
  bunBin: cfg.bun_bin,
  bridgeUrl: `ws://127.0.0.1:${cfg.listen.port}/bridge`,
  bridgeTokenFile: secretPath(home, 'local-bridge-token.hub'),
  bridgeToken,
  serverName: 'hannigan',
  maxSessions: cfg.secretary.contexts.max_active,
  // every context folder is created by the hub under contexts.root_dir from a validated id
  isTrustedDir: dir => dir === cfg.secretaryDir || dir.startsWith(contextsRoot + sep),
  emit: e => handleWorkerEvent(SECRETARY, e),
  setupFor: () => ({ t: 'setup', server_name: 'hannigan', instructions: secretaryInstructions(cfg), tools: SECRETARY_TOOLS, role: 'secretary' }),
  onToolCall: (s, name, args) => secretaryTool({ key: s.key, context_id: s.context_id ?? null }, name, args),
  // messages written while the bridge was not up yet and lost with the session: back to the front of its queue
  onUndelivered: (s, msgs) => {
    const ctx = s.context_id ?? contexts.byKey(s.key)?.context_id
    if (!ctx) return void log(C, 'undelivered secretary messages without a conversation dropped', { session: s.key, count: msgs.length })
    held.set(ctx, [...msgs, ...(held.get(ctx) ?? [])])
    saveHeld()
    events.record('secretary_waiting', { context_id: ctx, reason: 'session_ended_before_delivery' })
  },
})

// Deliveries waiting for a secretary of their context (no slot yet, secretary stopping, or lost on the way).
// Persisted in hub/held.json so a hub restart does not lose them; restored in order at start.
type Held = { content: string; meta: Record<string, string> }
const heldFile = join(stateDir, 'held.json')
const held = new Map<string, Held[]>(
  Object.entries(readJson<Record<string, Held[]>>(heldFile, {})).filter(([k, q]) => CONTEXT_ID_RE.test(k) && Array.isArray(q) && q.length),
)
function saveHeld(): void {
  writeJsonAtomic(heldFile, Object.fromEntries([...held].filter(([, q]) => q.length)))
}

const secState = (key: string): string | undefined => {
  try {
    return secretaries.get(key).state
  } catch {
    return undefined
  }
}
const ctxBusy = (context_id: string, key: string) =>
  (held.get(context_id)?.length ?? 0) > 0 || [...approvals.values()].some(a => a.worker === SECRETARY && a.session === key)

// find, resume or create the secretary of a context. Throws CommandError busy / invalid_state when it must wait.
function ensureContextSecretary(context_id: string): string {
  const c = contexts.ensure(context_id)
  if (c.session_key) {
    const st = secState(c.session_key)
    if (st && LIVE_STATES.includes(st)) return c.session_key
    if (st === 'stopping') throw new CommandError('invalid_state', 'secretary is stopping')
    if (st) {
      try {
        secretaries.resume(c.session_key)
        events.record('secretary_context', { context_id, session: c.session_key, action: 'resumed' })
        events.record('notice', { level: 'info', context_id, text: `会話 ${context_id} の秘書セッションを再開しました` })
        return c.session_key
      } catch (e) {
        if ((e as CommandError).code === 'busy') throw e
        log(C, 'secretary resume failed; creating a new one', { context_id, err: String(e) })
      }
    }
  }
  const s = secretaries.create({ project: 'secretary', cwd: ensureDir(contexts.dirFor(context_id)), name: context_id, role: 'secretary', context_id })
  contexts.setSession(context_id, s.key)
  events.record('secretary_context', { context_id, session: s.key, action: 'created' })
  events.record('notice', { level: 'info', context_id, text: `会話 ${context_id} の秘書セッションを起動しました` })
  return s.key
}

function tryEvict(except: string): void {
  const c = evictionCandidate({ contexts: contexts.all(), stateOf: secState, busy: ctxBusy, except })
  if (!c?.session_key) return
  secretaries.stop(c.session_key)
  events.record('secretary_idle_stop', { context_id: c.context_id, session: c.session_key, reason: 'evicted' })
}

// deliver to the secretary of exactly this context; never to another one. A message is written to the
// channel only when the secretary's bridge is up; until then it waits in the persisted held queue (a hub
// restart or a secretary that dies while starting does not lose it).
function deliverToContext(context_id: string, content: string, meta: Record<string, string | undefined>): 'sent' | 'held' | 'failed' {
  if (!CONTEXT_ID_RE.test(context_id)) return 'failed'
  const m = cleanMeta({ ...meta, chat_id: context_id })
  const q = held.get(context_id)
  if (q?.length) return hold(context_id, { content, meta: m })
  try {
    const key = ensureContextSecretary(context_id)
    if (!secretaries.isBridgeReady(key)) return hold(context_id, { content, meta: m }, 'starting')
    secretaries.send(key, content, m)
    contexts.touch(context_id)
    afterSent(m)
    return 'sent'
  } catch (e) {
    const code = (e as CommandError).code
    if (code === 'busy' || code === 'invalid_state') {
      if (code === 'busy') tryEvict(context_id)
      return hold(context_id, { content, meta: m })
    }
    log(C, 'deliver to secretary failed', { context_id, err: String(e) })
    events.record('notice', { level: 'error', context_id, text: `会話 ${context_id} の秘書へ渡せませんでした: ${(e as Error).message}` })
    return 'failed'
  }
}

function hold(context_id: string, h: Held, reason = 'no_slot'): 'held' | 'failed' {
  const q = held.get(context_id) ?? []
  if (q.length >= cfg.secretary.contexts.max_pending_per_context) {
    events.record('notice', { level: 'error', context_id, text: `会話 ${context_id} の秘書への待機件数が上限に達しました（未配送）` })
    return 'failed'
  }
  q.push(h)
  held.set(context_id, q)
  saveHeld()
  if (q.length === 1) events.record('secretary_waiting', { context_id, reason })
  return 'held'
}

// bookkeeping that only counts once the secretary really got the message: a PM report answering a request
function afterSent(meta: Record<string, string>): void {
  if (meta.kind !== 'worker_report' || meta.role !== 'pm' || !meta.request_id) return
  const r = requests.get(meta.request_id)
  if (r) requests.update(r.request_id, { reports: r.reports + 1 })
}

function flushHeld(): void {
  let changed = false
  for (const [ctx, q] of held) {
    while (q.length) {
      try {
        const key = ensureContextSecretary(ctx)
        if (!secretaries.isBridgeReady(key)) break // flushed again when it becomes ready
        secretaries.send(key, q[0]!.content, q[0]!.meta)
        contexts.touch(ctx)
        afterSent(q[0]!.meta)
        q.shift()
        changed = true
      } catch (e) {
        const code = (e as CommandError).code
        if (code === 'busy' || code === 'invalid_state') {
          if (code === 'busy') tryEvict(ctx)
          break
        }
        log(C, 'held delivery dropped', { context_id: ctx, err: String(e) })
        events.record('notice', { level: 'error', context_id: ctx, text: `会話 ${ctx} の秘書へ渡せませんでした: ${(e as Error).message}` })
        q.shift()
        changed = true
      }
    }
    if (!q.length) held.delete(ctx)
  }
  if (changed) saveHeld()
}

function idleSweep(): void {
  const idle = idleContexts({
    contexts: contexts.all(),
    stateOf: secState,
    busy: ctxBusy,
    now: Date.now(),
    idleMs: cfg.secretary.contexts.idle_minutes * 60000,
  })
  for (const c of idle) {
    secretaries.stop(c.session_key!)
    events.record('secretary_idle_stop', { context_id: c.context_id, session: c.session_key, reason: 'idle' })
  }
}

// ---------------------------------------------------------------- requests and the offline queue (Q6/B, Q12/C)
// request states that no later step may overwrite (a cancelled / expired request stays so even if a stale
// dispatch result arrives). delivery_unknown is final for the hub's own guesses; only a worker-confirmed
// delivery event (onDelivery) may resolve it, because the worker knows what it actually wrote.
const FINAL_REQUEST: RequestState[] = ['cancelled', 'expired', 'delivered', 'failed', 'delivery_unknown']
function setRequestState(
  request_id: string,
  state: RequestState,
  extra: { pm_session?: string | null; reason?: string | null; expires_at?: string | null } = {},
  opts: { resolveUnknown?: boolean } = {},
): void {
  const cur = requests.get(request_id)
  if (!cur) return
  if (FINAL_REQUEST.includes(cur.state) && !(opts.resolveUnknown && cur.state === 'delivery_unknown')) {
    if (cur.state !== state) log(C, 'request state not changed (final)', { request_id, state: cur.state, refused: state })
    return
  }
  const r = requests.update(request_id, { state, ...extra })
  if (!r) return
  events.record('request_state', {
    request_id,
    context_id: r.context_id,
    worker: r.worker,
    project: r.project,
    pm_session: r.pm_session,
    operation_id: r.operation_id,
    state,
    expires_at: r.expires_at,
    reason: r.reason,
  })
}

function recordQueueState(x: OfflineRequest): void {
  events.record('offline_request_state', {
    operation_id: x.operation_id,
    kind_of: x.kind,
    request_id: x.request_id,
    message_id: x.message_id,
    worker: x.worker,
    project: x.project,
    session: x.session,
    context_id: x.context_id,
    state: x.state,
    accepted_at: x.accepted_at,
    expires_at: x.expires_at,
    reason: x.reason ?? null,
  })
}

function markQ(op: string, state: OfflineRequestState, reason?: string | null): OfflineRequest | null {
  const x = queue.markState(op, state, reason)
  if (x) recordQueueState(x)
  return x
}

function recordDirect(f: {
  worker: string
  project: string | null
  session: string
  message_id: string
  target_delivery: string
  pm_session: string | null
  pm_notice_delivery: string
  reason?: string | null
  operation_id?: string | null
  expires_at?: string | null
}): void {
  events.record('direct_delivery_state', { ...f, reason: f.reason ?? null, source: 'hub' })
}

// an expired request was never executed: tell the WebChat views and the originating conversation
function notifyExpired(x: OfflineRequest): void {
  events.record('request_expired', {
    operation_id: x.operation_id,
    request_id: x.request_id,
    message_id: x.message_id,
    worker: x.worker,
    project: x.project,
    session: x.session,
    context_id: x.context_id,
    accepted_at: x.accepted_at,
    expires_at: x.expires_at,
    reason: x.reason ?? null,
  })
  if (x.kind === 'pm_send' && x.request_id) {
    setRequestState(x.request_id, 'expired', { reason: x.reason ?? 'ttl_elapsed' })
    if (x.context_id)
      deliverToContext(
        x.context_id,
        `依頼 ${x.request_id}（${displayName(x.worker)} / ${x.project}）は期限 ${x.expires_at} までにワーカーへ届かなかったため失効しました。この依頼は実行されていません。`,
        { kind: 'worker_event', worker: x.worker, project: x.project ?? undefined, request_id: x.request_id },
      )
  } else if (x.kind === 'thread_direct_send' && x.session && x.message_id) {
    recordDirect({
      worker: x.worker,
      project: x.project,
      session: x.session,
      message_id: x.message_id,
      target_delivery: 'expired',
      pm_session: null,
      pm_notice_delivery: x.target_role === 'task' ? 'expired' : 'not_applicable',
      reason: x.reason ?? 'ttl_elapsed',
      operation_id: x.operation_id,
      expires_at: x.expires_at,
    })
  }
}

function expireItem(x: OfflineRequest, reason: string): void {
  const y = markQ(x.operation_id, 'expired', reason)
  if (y) notifyExpired(y)
}

const DIRECT_TO_STATE: Record<string, OfflineRequestState> = {
  delivered: 'delivered',
  queued: 'worker_queued',
  resource_wait: 'resource_wait',
  expired: 'expired',
  delivery_unknown: 'delivery_unknown',
  not_applicable: 'failed',
}

// FIFO dispatch of held requests after a worker (re)connects (Q14/B): one at a time, next only after the result
const dispatching = new Set<string>()
async function dispatchOffline(worker: string): Promise<void> {
  if (dispatching.has(worker)) return
  dispatching.add(worker)
  try {
    for (const snap of queue.pendingFor(worker)) {
      if (!isConnected(worker)) break
      // re-read: the item may have been cancelled / expired while an earlier one was in flight
      const item = queue.get(snap.operation_id)
      if (!item || item.state !== 'pending_offline') continue
      if (queue.isExpired(item)) {
        expireItem(item, 'ttl_elapsed')
        continue
      }
      if (!markQ(item.operation_id, 'dispatching')) continue
      if (item.request_id) setRequestState(item.request_id, 'dispatching')
      const args =
        item.kind === 'pm_send'
          ? { project: item.project, text: item.text, request_id: item.request_id, expires_at: item.expires_at, operation_id: item.operation_id, work_item_id: item.work_item_id ?? null }
          : { session: item.session, text: item.text, message_id: item.message_id, expires_at: item.expires_at, target_role: item.target_role ?? undefined, operation_id: item.operation_id }
      const r = await sendCommand(worker, item.kind, args)
      if (r.ok) {
        if (item.kind === 'pm_send') {
          const d = r.data as PmSendResult
          markQ(item.operation_id, d.status, d.reason ?? null)
          if (item.request_id) setRequestState(item.request_id, d.status, { pm_session: d.pm_session ?? null, reason: d.reason ?? null })
        } else {
          const d = r.data as ThreadDirectSendResult
          const st = DIRECT_TO_STATE[d.target_delivery] ?? 'delivery_unknown'
          if (st === 'expired') expireItem(item, 'deadline_expired')
          else markQ(item.operation_id, st)
          recordDirect({
            worker,
            project: item.project,
            session: item.session!,
            message_id: item.message_id!,
            target_delivery: d.target_delivery,
            pm_session: d.pm_session ?? null,
            pm_notice_delivery: d.pm_notice_delivery,
            operation_id: item.operation_id,
          })
        }
        continue
      }
      if (!r.sent) {
        markQ(item.operation_id, 'pending_offline', 'worker_offline')
        if (item.request_id) setRequestState(item.request_id, 'pending_offline')
        break
      }
      if (unknownOutcome(r)) {
        // never re-sent automatically (03 §2.3.1)
        markQ(item.operation_id, 'delivery_unknown', r.error.code)
        if (item.request_id) setRequestState(item.request_id, 'delivery_unknown', { reason: r.error.code })
        if (item.kind === 'thread_direct_send')
          recordDirect({
            worker,
            project: item.project,
            session: item.session!,
            message_id: item.message_id!,
            target_delivery: 'delivery_unknown',
            pm_session: null,
            pm_notice_delivery: item.target_role === 'task' ? 'delivery_unknown' : 'not_applicable',
            reason: r.error.code,
            operation_id: item.operation_id,
          })
        continue
      }
      if (r.error.code === 'deadline_expired' || r.error.code === 'expired') {
        expireItem(item, 'deadline_expired')
        continue
      }
      markQ(item.operation_id, 'failed', r.error.code)
      if (item.kind === 'pm_send' && item.request_id) {
        setRequestState(item.request_id, 'failed', { reason: r.error.code })
        if (item.context_id)
          deliverToContext(
            item.context_id,
            `保留していた依頼 ${item.request_id}（${displayName(worker)} / ${item.project}）をワーカーが受け付けませんでした（${r.error.code}: ${r.error.message}）。この依頼は実行されていません。`,
            { kind: 'worker_event', worker, project: item.project ?? undefined, request_id: item.request_id },
          )
      } else if (item.session && item.message_id) {
        recordDirect({
          worker,
          project: item.project,
          session: item.session,
          message_id: item.message_id,
          target_delivery: 'failed',
          pm_session: null,
          pm_notice_delivery: item.target_role === 'task' ? 'failed' : 'not_applicable',
          reason: r.error.code,
          operation_id: item.operation_id,
        })
      }
    }
  } finally {
    dispatching.delete(worker)
  }
}

function sweep(): void {
  for (const x of queue.expireDue()) {
    recordQueueState(x)
    notifyExpired(x)
  }
  for (const id of workers.keys()) if (isConnected(id) && queue.pendingFor(id).length) void dispatchOffline(id)
}

const DELIVERY_TO_STATE: Partial<Record<DeliveryStatus, OfflineRequestState>> = {
  queued: 'worker_queued',
  worker_queued: 'worker_queued',
  resource_wait: 'resource_wait',
  delivered: 'delivered',
  expired: 'expired',
  delivery_unknown: 'delivery_unknown',
}

// worker-side progress of a hub request (worker_queued -> delivered / expired ...)
function onDelivery(worker: string, e: Extract<WorkerEvent, { kind: 'delivery' }>): void {
  events.record('delivery', { worker, ...strip(e) })
  const item =
    (e.operation_id ? queue.get(e.operation_id) : undefined) ??
    (e.request_id ? queue.findByRequest(e.request_id) : undefined) ??
    (e.message_id && e.session ? queue.findByMessage(worker, e.session, e.message_id) : undefined)
  const st = DELIVERY_TO_STATE[e.status]
  if (item && item.worker === worker && st) {
    if (st === 'expired') expireItem(item, e.reason ?? 'deadline_expired')
    else markQ(item.operation_id, st, e.reason ?? null)
  }
  if (e.request_id) {
    const r = requests.get(e.request_id)
    if (r && r.worker === worker && st && r.state !== st && !['expired', 'failed', 'cancelled', 'delivered'].includes(r.state)) {
      if (st === 'expired' && !item) {
        setRequestState(r.request_id, 'expired', { reason: e.reason ?? 'deadline_expired' }, { resolveUnknown: true })
        deliverToContext(r.context_id, `依頼 ${r.request_id}（${displayName(worker)} / ${r.project}）は期限までに PM へ届かず失効しました。この依頼は実行されていません。`, {
          kind: 'worker_event',
          worker,
          project: r.project,
          request_id: r.request_id,
        })
      } else if (st !== 'expired') setRequestState(r.request_id, st, { reason: e.reason ?? null }, { resolveUnknown: st === 'delivered' })
    }
  }
}

// ---------------------------------------------------------------- worker / secretary events
function handleWorkerEvent(worker: string, e: WorkerEvent): void {
  const w = workerConn(worker)
  switch (e.kind) {
    case 'inventory':
      w.projects = e.projects
      w.sessions = new Map(e.sessions.map(s => [s.key, s]))
      // approvals that belong to sessions that are no longer running cannot be answered
      closeApproval(a => a.worker === worker && !LIVE_STATES.includes(w.sessions.get(a.session)?.state ?? 'stopped'), 'closed', 'ended')
      events.record('inventory', { worker, projects: e.projects, sessions: e.sessions })
      if (w.dispatchOnInventory) {
        w.dispatchOnInventory = false
        void dispatchOffline(worker)
      }
      return
    case 'session_state': {
      const prev = w.sessions.get(e.session)
      const s: SessionInfo = prev
        ? { ...prev, state: e.state, updated_at: new Date().toISOString() }
        : {
            key: e.session,
            project: e.project,
            name: e.project,
            role: e.role,
            pm_session: e.pm_session ?? null,
            state: e.state,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            conversation_id: e.session,
          }
      w.sessions.set(e.session, s)
      const context_id = worker === SECRETARY ? (contexts.byKey(e.session)?.context_id ?? null) : undefined
      events.record('session_state', {
        worker,
        session: e.session,
        project: e.project,
        role: e.role,
        pm_session: e.pm_session ?? null,
        ...(context_id !== undefined ? { context_id } : {}),
        state: e.state,
        detail: e.detail ?? null,
      })
      if (worker === SECRETARY) {
        if (ENDED.includes(e.state) && held.size) setTimeout(flushHeld, 200)
        if (e.state === 'ready' && held.has(contexts.byKey(e.session)?.context_id ?? '')) setTimeout(flushHeld, 0)
        return
      }
      if (e.state === 'exited' || e.state === 'failed') {
        const targets = new Set<string>()
        const owner = requests.ownerOf(worker, e.session)
        if (owner) targets.add(owner)
        for (const r of requests.open(worker, e.session)) targets.add(r.context_id)
        for (const ctx of targets)
          deliverToContext(ctx, `ワーカー「${displayName(worker)}」のセッション ${e.session}（${e.project}）が ${e.state} になりました。${e.detail ? '\n' + e.detail : ''}`, {
            kind: 'worker_event',
            worker,
            session: e.session,
          })
      }
      return
    }
    case 'session_report':
      return onReport(worker, e)
    case 'work_item_created':
    case 'work_item_updated':
      return onWorkItem(worker, e)
    case 'thread_entry': {
      const k = `${worker}/${e.entry_id}`
      if (seenEntries.has(k)) return
      seenEntries.add(k)
      events.record('thread_entry', { worker, ...strip(e) })
      return
    }
    case 'direct_delivery_state': {
      events.record('direct_delivery_state', { worker, ...strip(e), source: 'worker' })
      const item = queue.findByMessage(worker, e.session, e.message_id)
      const st = DIRECT_TO_STATE[e.target_delivery]
      if (item && st && st !== 'failed') {
        if (st === 'expired') expireItem(item, e.reason ?? 'deadline_expired')
        else markQ(item.operation_id, st, e.reason ?? null)
      }
      return
    }
    case 'user_direct_notice':
    case 'task_event':
      events.record(e.kind, { worker, ...strip(e) })
      return
    case 'delivery':
      return onDelivery(worker, e)
    case 'resource_wait': {
      events.record('resource_wait', { worker, ...strip(e) })
      const item = e.operation_id ? queue.get(e.operation_id) : e.request_id ? queue.findByRequest(e.request_id) : undefined
      if (item && item.worker === worker) markQ(item.operation_id, 'resource_wait', e.reason)
      return
    }
    case 'resource_lease_state': {
      const ev = events.record('resource_lease_state', { worker, ...strip(e) })
      leases.set(`${worker}/${e.resource_id}`, ev)
      return
    }
    case 'permission_request':
      openApproval({
        worker,
        session: e.session,
        project: e.project,
        type: 'tool',
        request_id: e.request_id,
        title: `${e.tool_name}: ${e.description}`,
        body: e.input_preview,
        options: ['allow', 'deny'],
      })
      return
    case 'permission_closed':
      closeApproval(a => a.worker === worker && a.session === e.session && a.request_id === e.request_id, e.reason, e.reason.startsWith('webchat') ? 'webchat' : e.reason)
      return
    case 'terminal_prompt':
      openApproval({
        worker,
        session: e.session,
        project: e.project,
        type: 'terminal',
        prompt_id: e.prompt_id,
        prompt_kind: e.prompt_kind,
        title: e.title,
        body: e.body,
        options: e.options,
      })
      return
    case 'terminal_prompt_closed':
      closeApproval(a => a.worker === worker && a.session === e.session && a.prompt_id === e.prompt_id, e.reason, e.reason)
      return
  }
}

// Report routing (03 §5, 02 §3.6): every report is recorded for its thread; only a PM report answering a
// known request goes to the secretary of the context that issued the request_id. Nothing is guessed.
function onReport(worker: string, e: Extract<WorkerEvent, { kind: 'session_report' }>): void {
  const base = {
    worker,
    worker_name: displayName(worker),
    session: e.session,
    project: e.project,
    role: e.role,
    pm_session: e.pm_session ?? null,
    text: e.text,
    request_id: e.request_id ?? null,
    in_reply_to: e.in_reply_to ?? null,
    origin: e.origin ?? null,
    conv_id: e.chat_id ?? null,
    ...(e.reason ? { reason: e.reason } : {}),
  }
  const unrouted = (reason: string) => {
    events.record('worker_report', { ...base, routed: false })
    events.record('report_unrouted', { worker, session: e.session, project: e.project, role: e.role, request_id: e.request_id ?? null, reason })
  }
  if (e.origin === 'user_direct' || e.origin === 'task_report') {
    events.record('worker_report', { ...base, routed: false })
    return
  }
  if (e.role === 'pm') {
    if (!e.request_id) {
      // a PM message without a request: stays in the PM thread
      events.record('worker_report', { ...base, routed: false })
      if (e.origin === 'request' || e.reason === 'ambiguous_request')
        events.record('report_unrouted', { worker, session: e.session, project: e.project, role: e.role, request_id: null, reason: e.reason ?? 'missing_request_id' })
      return
    }
    const r = requests.get(e.request_id)
    if (!r || r.worker !== worker || r.project !== e.project) return unrouted('unknown_request')
    events.record('worker_report', { ...base, routed: true, context_id: r.context_id })
    if (!r.pm_session) requests.update(r.request_id, { pm_session: e.session })
    // `reports` counts after the secretary got it (deliverToContext / flushHeld -> afterSent)
    deliverToContext(r.context_id, e.text, {
      kind: 'worker_report',
      worker,
      session: e.session,
      project: e.project,
      role: 'pm',
      request_id: r.request_id,
    })
    return
  }
  // Phase 2 compatibility: a plain task session (no PM) driven by session_send reports to its chat_id's context
  if (e.role === 'task' && !e.pm_session && e.chat_id && CONTEXT_ID_RE.test(e.chat_id)) {
    if (!contexts.get(e.chat_id)) return unrouted('unknown_context')
    events.record('worker_report', { ...base, routed: true, context_id: e.chat_id })
    deliverToContext(e.chat_id, e.text, { kind: 'worker_report', worker, session: e.session, project: e.project, role: 'task' })
    return
  }
  // task reports of a PM go to the PM on the worker, not to a secretary
  events.record('worker_report', { ...base, routed: false })
}

function onWorkItem(worker: string, e: Extract<WorkerEvent, { kind: 'work_item_created' | 'work_item_updated' }>): void {
  const reject = (reason: string) =>
    events.record('work_item_rejected', { worker, project: e.project, work_item_id: e.work_item_id, pm_session: e.pm_session, reason })
  if (!cfg.secretary.shared_ledger.enabled) return void reject('ledger_disabled')
  // only the project's PM may write its items
  const pm = workerConn(worker).sessions.get(e.pm_session)
  if (!pm || pm.role !== 'pm' || pm.project !== e.project) return void reject('unknown_pm')
  const req = e.request_id ? requests.get(e.request_id) : undefined
  const res =
    e.kind === 'work_item_created'
      ? ledger.created(worker, e, req && req.worker === worker ? req.context_id : null)
      : ledger.updated(worker, e)
  if (!res.ok) return void reject(res.reason)
  events.record('work_item', { action: res.action, ...res.item, context_id: undefined })
}

// ---------------------------------------------------------------- secretary tools
function errText(code: ErrorCode | string, message: string): { ok: false; text: string } {
  return { ok: false, text: `error ${code}: ${message}` }
}
const str = (v: unknown) => (typeof v === 'string' ? v : '')

async function workerCall(worker: unknown, name: CommandName, args: Record<string, unknown>) {
  if (typeof worker !== 'string' || !worker) return errText('bad_args', 'worker is required')
  const r = await sendCommand(worker, name, args)
  if (!r.ok) return errText(r.error.code, r.error.message)
  return { ok: true, text: JSON.stringify(r.data) }
}

async function refreshWorker(id: string): Promise<void> {
  const w = workerConn(id)
  if (!w.connected) return
  const r = await sendCommand(id, 'list', {}, 5000)
  if (!r.ok) return
  const d = r.data as { projects: ProjectInfo[]; sessions: SessionInfo[] }
  w.projects = withoutPaths(d.projects)
  w.sessions = new Map(d.sessions.map(s => [s.key, s]))
}

const workerIds = () => [...new Set([...cfg.workers.map(w => w.id), ...[...workers.keys()].filter(k => k !== SECRETARY)])]

async function projectPmSend(ctx: string, a: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
  const worker = str(a.worker)
  const project = str(a.project)
  const text = str(a.text)
  if (!ID_RE.test(worker) || !ID_RE.test(project) || !text.trim()) return errText('bad_args', 'worker, project (ids) and text are required')
  if (a.chat_id != null && a.chat_id !== ctx) return errText('forbidden_origin', 'chat_id is not the conversation this secretary serves')
  if (!knownWorker(worker)) return errText('not_found', `unknown worker "${worker}"`)
  const w = workerConn(worker)
  const p = w.projects.find(x => x.id === project)
  if (w.projects.length && !p) return errText('not_found', `project "${project}" not found on "${worker}"`)
  if (p && !p.pm_enabled) return errText('pm_disabled', `project "${project}" has no PM`)
  const req = requests.add({ request_id: rid('rq'), context_id: ctx, worker, project, operation_id: rid('op'), state: 'accepted', expires_at: null })
  events.record('request_state', { request_id: req.request_id, context_id: ctx, worker, project, operation_id: req.operation_id, state: 'accepted', expires_at: null })

  const holdOffline = (why: string) => {
    if (!cfg.offline_queue.enabled) {
      setRequestState(req.request_id, 'failed', { reason: 'worker_offline' })
      return errText('worker_offline', `worker "${worker}" is offline (${why}) and the offline queue is disabled; the request was not sent`)
    }
    try {
      const x = queue.enqueue({
        operation_id: req.operation_id,
        kind: 'pm_send',
        request_id: req.request_id,
        message_id: null,
        worker,
        project,
        session: null,
        target_role: 'pm',
        text,
        context_id: ctx,
      })
      recordQueueState(x)
      setRequestState(req.request_id, 'pending_offline', { expires_at: x.expires_at })
      return {
        ok: true,
        text: JSON.stringify({
          request_id: req.request_id,
          status: 'pending_offline',
          operation_id: x.operation_id,
          expires_at: x.expires_at,
          note: 'The worker is offline. The request is held and will be delivered in order when it reconnects. It has NOT been executed. If it is not delivered by expires_at it expires and you will be told.',
        }),
      }
    } catch (e) {
      const code = (e as CommandError).code ?? 'internal'
      setRequestState(req.request_id, 'failed', { reason: code })
      return errText(code, (e as Error).message)
    }
  }

  if (!isConnected(worker)) return holdOffline('not connected')
  const expires_at = cfg.offline_queue.enabled ? new Date(Date.now() + cfg.offline_queue.ttl_minutes * 60000).toISOString() : null
  requests.update(req.request_id, { expires_at })
  const r = await sendCommand(worker, 'pm_send', { project, text, request_id: req.request_id, expires_at, operation_id: req.operation_id })
  if (r.ok) {
    const d = r.data as PmSendResult
    setRequestState(req.request_id, d.status, { pm_session: d.pm_session ?? null, reason: d.reason ?? null })
    return {
      ok: true,
      text: JSON.stringify({
        request_id: req.request_id,
        status: d.status,
        pm_session: d.pm_session ?? null,
        reason: d.reason ?? null,
        note: 'The PM received the request (or the worker holds it). The work is NOT done yet; the result comes back as a worker_report with this request_id.',
      }),
    }
  }
  if (!r.sent) return holdOffline('disconnected')
  if (unknownOutcome(r)) {
    setRequestState(req.request_id, 'delivery_unknown', { reason: r.error.code })
    return errText(
      'delivery_unknown',
      `request ${req.request_id}: the worker did not confirm delivery (${r.error.code}). It may or may not have reached the PM. It is not re-sent automatically; tell the person instead of retrying blindly.`,
    )
  }
  setRequestState(req.request_id, 'failed', { reason: r.error.code })
  return errText(r.error.code, `request ${req.request_id} was not accepted: ${r.error.message}`)
}

function projectStatus(a: Record<string, unknown>): { ok: boolean; text: string } {
  const worker = str(a.worker) || undefined
  const project = str(a.project) || undefined
  if (!cfg.secretary.shared_ledger.enabled) return errText('forbidden', 'the shared ledger is disabled')
  const items = ledger.query({ worker, project }).map(i => ({
    worker: i.worker,
    project: i.project,
    work_item_id: i.work_item_id,
    title: i.title,
    status: i.status,
    summary: i.summary,
    assignee: i.assignee ?? null,
    request_id: i.request_id ?? null,
    updated_at: i.updated_at,
  }))
  const pms = []
  for (const id of workerIds()) {
    if (worker && id !== worker) continue
    const w = workerConn(id)
    for (const p of w.projects) {
      if (project && p.id !== project) continue
      const pm = [...w.sessions.values()].filter(s => s.role === 'pm' && s.project === p.id).sort((x, y) => y.updated_at.localeCompare(x.updated_at))[0]
      pms.push({ worker: id, connected: w.connected, project: p.id, pm_enabled: p.pm_enabled, pm_session: pm?.key ?? null, pm_state: pm?.state ?? null })
    }
  }
  return { ok: true, text: JSON.stringify({ projects: pms, work_items: items }, null, 1) }
}

async function workersStatus(): Promise<{ ok: boolean; text: string }> {
  const out = []
  for (const id of workerIds()) {
    await refreshWorker(id)
    const w = workerConn(id)
    const c = cfg.workers.find(x => x.id === id)
    out.push({
      worker: id,
      display_name: c?.display_name ?? id,
      role: c?.role ?? '',
      connected: w.connected,
      projects: w.projects.map(p => ({ id: p.id, description: p.description, pm_enabled: p.pm_enabled, execution_policy: p.execution_policy ?? null })),
      sessions: [...w.sessions.values()].map(s => ({
        session: s.key,
        project: s.project,
        name: s.name,
        role: s.role,
        pm_session: s.pm_session ?? null,
        context: requests.ownerOf(id, s.key) ?? null,
        state: s.state,
        updated_at: s.updated_at,
      })),
    })
  }
  return { ok: true, text: JSON.stringify(out, null, 1) }
}

async function secretaryTool(s: { key: string; context_id: string | null }, name: string, a: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
  // the calling session is identified by its authenticated bridge; its context comes from the hub's own record
  const ctx = s.context_id
  if (!ctx || contexts.get(ctx)?.session_key !== s.key) return errText('forbidden_origin', 'this secretary session is not bound to a conversation')
  contexts.touch(ctx)
  const own = (worker: unknown, session: unknown) => {
    if (typeof worker === 'string' && typeof session === 'string' && ID.test(session)) requests.setOwner(worker, session, ctx)
  }
  // a session driven by another conversation is not this secretary's to touch (Q6/B). Unowned sessions
  // (e.g. made before ownership was recorded) may be taken over; ownership is recorded only after success.
  const foreign = (worker: unknown, session: unknown): { ok: false; text: string } | null => {
    if (typeof worker !== 'string' || typeof session !== 'string') return null
    const owner = requests.ownerOf(worker, session)
    return owner && owner !== ctx ? errText('forbidden_origin', 'that session belongs to another conversation') : null
  }
  switch (name) {
    case 'reply': {
      const text = str(a.text)
      const chat = str(a.chat_id)
      if (!text.trim() || !chat) return errText('bad_args', 'chat_id and text are required')
      if (chat !== ctx) {
        events.record('reply_refused', { context_id: ctx, chat_id: chat.slice(0, 64), reason: 'forbidden_origin' })
        return errText('forbidden_origin', 'you can only reply to the conversation you serve')
      }
      const e = events.record('secretary_reply', { context_id: ctx, conv_id: ctx, source: 'webchat', text, in_reply_to: typeof a.in_reply_to === 'string' ? a.in_reply_to : null })
      return { ok: true, text: `sent (seq ${e.seq})` }
    }
    case 'project_pm_send':
      return projectPmSend(ctx, a)
    case 'project_status':
      return projectStatus(a)
    case 'workers_status':
      return workersStatus()
    case 'session_create': {
      const r = await workerCall(a.worker, 'session_create', { project: a.project, name: a.name, chat_id: ctx })
      if (r.ok) own(a.worker, (parseJson<{ session?: { key?: string } }>(r.text) ?? {}).session?.key)
      return r
    }
    case 'session_resume':
    case 'session_send': {
      const no = foreign(a.worker, a.session)
      if (no) return no
      const r =
        name === 'session_resume'
          ? await workerCall(a.worker, 'session_resume', { session: a.session, chat_id: ctx })
          : await workerCall(a.worker, 'session_send', { session: a.session, text: a.text, chat_id: ctx })
      if (r.ok) own(a.worker, a.session)
      return r
    }
    case 'session_stop':
    case 'session_interrupt': {
      const no = foreign(a.worker, a.session)
      if (no) return no
      const r = await workerCall(a.worker, name, { session: a.session })
      if (r.ok && name === 'session_interrupt') r.text += '\nEsc was sent. Check the real state on screen or ask the session before assuming what was done.'
      return r
    }
  }
  return errText('unknown_command', `unknown tool ${name}`)
}

// ---------------------------------------------------------------- HTTP
const html = readFileSync(join(import.meta.dir, '..', 'web', 'index.html'), 'utf8')
const json = (o: unknown, status = 200) => Response.json(o, { status })

function authed(req: Request, url: URL): boolean {
  const h = req.headers.get('authorization') ?? ''
  const t = h.startsWith('Bearer ') ? h.slice(7) : (url.searchParams.get('token') ?? '')
  return t.length > 0 && safeEqual(t, webToken)
}

const ACTIVE_QUEUE: OfflineRequestState[] = ['pending_offline', 'dispatching', 'worker_queued', 'resource_wait', 'delivery_unknown']
function offlineView(x: OfflineRequest) {
  return {
    operation_id: x.operation_id,
    kind: x.kind,
    request_id: x.request_id,
    message_id: x.message_id,
    worker: x.worker,
    project: x.project,
    session: x.session,
    target_role: x.target_role ?? null,
    context_id: x.context_id,
    state: x.state,
    reason: x.reason ?? null,
    accepted_at: x.accepted_at,
    expires_at: x.expires_at,
    updated_at: x.updated_at,
    text_preview: x.text.slice(0, 120),
  }
}

function threadWorkers() {
  return workerIds().map(id => {
    const w = workerConn(id)
    return { id, display_name: displayName(id), connected: w.connected, projects: w.projects, sessions: [...w.sessions.values()] }
  })
}

function secretaryList() {
  return contexts.all().map(c => ({
    context_id: c.context_id,
    session: c.session_key,
    state: c.session_key ? (secState(c.session_key) ?? null) : null,
    last_used_at: c.last_used_at,
    waiting: held.get(c.context_id)?.length ?? 0,
  }))
}

function stateSnapshot() {
  const ws = []
  const ids = new Set([...cfg.workers.map(w => w.id), ...workers.keys(), SECRETARY])
  for (const id of ids) {
    const w = workerConn(id)
    ws.push({
      worker: id,
      display_name: displayName(id),
      role: cfg.workers.find(x => x.id === id)?.role ?? '',
      connected: id === SECRETARY ? true : w.connected,
      projects: w.projects,
      sessions: id === SECRETARY ? secretaries.list() : [...w.sessions.values()],
    })
  }
  return {
    seq: events.seq,
    workers: ws,
    approvals: [...approvals.values()],
    threads: cfg.webchat.threads.enabled ? buildThreads(threadWorkers()) : [],
    secretaries: secretaryList(),
    offline_requests: queue.list().filter(x => ACTIVE_QUEUE.includes(x.state)).map(offlineView),
    leases: [...leases.values()],
    settings: {
      secretary_name: cfg.secretary.persona.name,
      offline_queue: cfg.offline_queue.enabled,
      ttl_minutes: cfg.offline_queue.ttl_minutes,
      threads: cfg.webchat.threads.enabled,
      direct_send: cfg.webchat.threads.direct_send_enabled,
    },
  }
}

// ---------------------------------------------------------------- settings screen (3f, 01 §25)
// Project folders come only from a live `list` / `config_set` result and go straight to the settings screen:
// they are never cached, recorded in the event log or shown elsewhere (local paths stay off the hub's records).
function withoutPaths(ps: ProjectInfo[]): ProjectInfo[] {
  return ps.map(({ path: _p, ...rest }) => rest)
}

async function settingsView() {
  const worker_projects: Record<string, ProjectInfo[]> = {}
  const paths_known: Record<string, boolean> = {}
  for (const id of workerIds()) {
    const w = workerConn(id)
    const r = w.connected ? await sendCommand(id, 'list', {}, 5000) : null
    if (r?.ok) {
      const d = r.data as { projects: ProjectInfo[]; sessions: SessionInfo[] }
      worker_projects[id] = d.projects
      w.projects = withoutPaths(d.projects)
      paths_known[id] = true
    } else {
      worker_projects[id] = w.projects // last inventory, without folders
      paths_known[id] = false
    }
  }
  return {
    paths_known,
    hub: {
      secretary: {
        persona: { ...cfg.secretary.persona },
        routing_notes: cfg.secretary.routing_notes,
        extra_instructions: cfg.secretary.extra_instructions,
        contexts: { max_active: cfg.secretary.contexts.max_active, idle_minutes: cfg.secretary.contexts.idle_minutes },
        // the instructions a secretary started now would get (read-only preview; what running ones have may be older)
        instructions_preview: secretaryInstructions(cfg),
      },
      offline_queue: {
        enabled: cfg.offline_queue.enabled,
        ttl_minutes: cfg.offline_queue.ttl_minutes,
        max_pending_per_worker: cfg.offline_queue.max_pending_per_worker,
      },
      workers: cfg.workers.map(w => ({ id: w.id, display_name: w.display_name, role: w.role, connected: isConnected(w.id) })),
    },
    worker_projects,
    // shown for reference; changing them means editing hub.json / the secrets and restarting
    fixed: {
      listen: { host: cfg.listen.host, port: cfg.listen.port, editable: false },
      public_url: { value: cfg.public_url, editable: false },
      secrets: { editable: false },
    },
    // the "2 台目の Mac" guide: this Mac's name and login for the ssh tunnel, and the prompt for Claude Code on the
    // other Mac with the worker id and key left as placeholders (the real key only ever leaves add-worker.ts). Not recorded.
    second_mac: secondMac(),
  }
}
function secondMac() {
  const hn = hostname()
  const hubHost = hn.includes('.') ? hn : `${hn}.local`
  const hubUser = userInfo().username
  return { hostname: hubHost, user: hubUser, port: cfg.listen.port, prompt_template: secondMacPromptTemplate({ hubPort: cfg.listen.port, hubHost, hubUser }) }
}

function saveHubSettings(input: unknown): Response {
  if (input == null || typeof input !== 'object') return json({ ok: false, error: 'bad_args', message: '設定を JSON オブジェクトで送ってください' }, 400)
  const file = join(home, 'hub.json')
  let plan
  try {
    plan = planHubSettings(input, readJson<unknown>(file, null), cfg)
  } catch (e) {
    if (e instanceof SettingsError) return json({ ok: false, error: 'bad_args', message: e.message }, 400)
    throw e
  }
  try {
    writeJsonAtomic(file, plan.file)
  } catch (e) {
    return json({ ok: false, error: 'internal', message: `hub.json を保存できませんでした（設定は変わっていません）: ${(e as Error).message}` }, 500)
  }
  // apply in place: cfg keeps its resolved paths, only the edited fields change
  const n = plan.config
  // the persona and the free-text guidance reach a secretary through setupFor() at its next start (resume included)
  cfg.secretary.persona = { ...n.secretary.persona }
  cfg.secretary.routing_notes = n.secretary.routing_notes
  cfg.secretary.extra_instructions = n.secretary.extra_instructions
  cfg.secretary.contexts.max_active = n.secretary.contexts.max_active
  cfg.secretary.contexts.idle_minutes = n.secretary.contexts.idle_minutes
  secretaries.setMaxSessions(n.secretary.contexts.max_active)
  cfg.offline_queue.enabled = n.offline_queue.enabled
  cfg.offline_queue.ttl_minutes = n.offline_queue.ttl_minutes
  cfg.offline_queue.max_pending_per_worker = n.offline_queue.max_pending_per_worker
  queue.setLimits({ ttlMinutes: n.offline_queue.ttl_minutes, maxPendingPerWorker: n.offline_queue.max_pending_per_worker })
  for (const w of cfg.workers) {
    const x = n.workers.find(y => y.id === w.id)
    if (x) {
      w.display_name = x.display_name
      w.role = x.role
    }
  }
  if (plan.changed.length) events.record('settings_changed', { scope: 'hub', fields: plan.changed })
  return json({ ok: true, changed: plan.changed, applies: plan.applies })
}

async function saveWorkerSettings(b: { worker?: unknown; projects?: unknown } | null): Promise<Response> {
  if (!b || typeof b.worker !== 'string' || !ID_RE.test(b.worker) || !Array.isArray(b.projects))
    return json({ ok: false, error: 'bad_args', message: 'worker（ワーカー ID）と projects（配列）が必要です' }, 400)
  const worker = b.worker
  if (!knownWorker(worker)) return json({ ok: false, error: 'not_found', message: `ワーカー「${worker}」は登録されていません` }, 404)
  if (!isConnected(worker))
    return json({ ok: false, error: 'worker_offline', message: `ワーカー「${displayName(worker)}」がオフラインです。Mac でワーカーが動いているときに保存してください` }, 409)
  // never held in the offline queue: a settings change applies now or not at all
  const r = await sendCommand(worker, 'config_set', { projects: b.projects })
  if (!r.ok) {
    const status = r.error.code === 'bad_args' || r.error.code === 'project_in_use' ? 400 : r.error.code === 'worker_offline' ? 409 : 502
    const unknown = r.sent && (r.error.code === 'timeout' || r.error.code === 'worker_offline')
    return json(
      {
        ok: false,
        error: r.error.code,
        message: unknown ? `${r.error.message}。保存されたかどうか分かりません。設定画面を開き直して確認してください` : r.error.message,
      },
      status,
    )
  }
  const d = r.data as ConfigSetResult
  workerConn(worker).projects = withoutPaths(d.projects)
  events.record('settings_changed', { scope: 'worker', worker, projects: d.projects.map(p => p.id) })
  return json({ ok: true, worker, projects: d.projects, pm_restart_needed: d.pm_restart_needed ?? [] })
}

async function body<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T
  } catch {
    return null
  }
}

async function sessionAction(worker: string, session: string, action: 'interrupt' | 'stop') {
  if (worker === SECRETARY) {
    try {
      return { ok: true, status: action === 'interrupt' ? secretaries.interrupt(session) : secretaries.stop(session) }
    } catch (e) {
      const ce = e as CommandError
      return { ok: false, error: ce.code ?? 'internal', message: ce.message }
    }
  }
  const r = await sendCommand(worker, action === 'interrupt' ? 'session_interrupt' : 'session_stop', { session })
  return r.ok ? { ok: true, ...(r.data as object) } : { ok: false, error: r.error.code, message: r.error.message }
}

// latest known delivery state of a direct post
function directState(worker: string, session: string, message_id: string) {
  for (let i = events.events.length - 1; i >= 0; i--) {
    const e = events.events[i]!
    if (e.kind === 'direct_delivery_state' && e.worker === worker && e.session === session && e.message_id === message_id)
      return {
        target_delivery: e.target_delivery ?? null,
        pm_notice_delivery: e.pm_notice_delivery ?? null,
        pm_session: e.pm_session ?? null,
        expires_at: e.expires_at ?? null,
        operation_id: e.operation_id ?? null,
      }
  }
  return null
}

// POST /api/thread/send: a person's direct post to a PM or task thread (Q4/B). Not re-interpreted by a secretary.
async function threadSend(b: { worker?: unknown; session?: unknown; msg_id?: unknown; text?: unknown } | null): Promise<Response> {
  if (!cfg.webchat.threads.enabled || !cfg.webchat.threads.direct_send_enabled) return json({ error: 'forbidden', message: 'direct posts are disabled' }, 403)
  const worker = str(b?.worker)
  const session = str(b?.session)
  const msg_id = str(b?.msg_id)
  const text = str(b?.text)
  if (!ID_RE.test(worker) || !ID.test(session) || !ID.test(msg_id) || !text.trim()) return json({ error: 'bad_args', message: 'worker, session, msg_id (ids) and text are required' }, 400)
  if (!knownWorker(worker)) return json({ error: 'not_found', message: 'unknown worker' }, 404)
  const w = workerConn(worker)
  // never trust the caller's role / project / pm: use the hub's own inventory
  const s = w.sessions.get(session)
  if (!s) return json({ error: 'not_found', message: 'unknown session' }, 404)
  if (s.role !== 'pm' && s.role !== 'task') return json({ error: 'forbidden', message: 'only PM and task threads accept direct posts' }, 403)
  if (s.role === 'task' && !s.pm_session) return json({ error: 'orphan_task', message: 'this task has no PM; direct posts need a PM to notify' }, 409)
  if (events.hasKey(directKey(worker, session, msg_id)))
    return json({ status: 'duplicate_ignored', ...(directState(worker, session, msg_id) ?? {}) })
  const target_role = s.role
  const pm_session = s.role === 'task' ? s.pm_session : null
  events.record('user_direct', {
    worker,
    project: s.project,
    session,
    msg_id,
    message_id: msg_id,
    text,
    target_role,
    pm_session,
    target_delivery: null,
    pm_notice_delivery: null,
  })
  const operation_id = rid('op')
  const base = { worker, project: s.project, session, message_id: msg_id, pm_session }
  const noticeNa = (v: string) => (target_role === 'task' ? v : 'not_applicable')

  const holdOffline = (): Response => {
    if (!cfg.offline_queue.enabled) {
      recordDirect({ ...base, target_delivery: 'failed', pm_notice_delivery: noticeNa('failed'), reason: 'worker_offline' })
      return json({ status: 'failed', error: 'worker_offline', message: 'the worker is offline and the offline queue is disabled' }, 409)
    }
    try {
      const x = queue.enqueue({
        operation_id,
        kind: 'thread_direct_send',
        request_id: null,
        message_id: msg_id,
        worker,
        project: s.project,
        session,
        target_role,
        text,
        context_id: null,
      })
      recordQueueState(x)
      recordDirect({ ...base, target_delivery: 'pending_offline', pm_notice_delivery: noticeNa('pending_offline'), operation_id: x.operation_id, expires_at: x.expires_at })
      return json({ status: 'pending_offline', operation_id: x.operation_id, expires_at: x.expires_at }, 202)
    } catch (e) {
      const code = (e as CommandError).code ?? 'internal'
      recordDirect({ ...base, target_delivery: 'failed', pm_notice_delivery: noticeNa('failed'), reason: code })
      return json({ status: 'failed', error: code, message: (e as Error).message }, 409)
    }
  }

  if (!w.connected) return holdOffline()
  const expires_at = cfg.offline_queue.enabled ? new Date(Date.now() + cfg.offline_queue.ttl_minutes * 60000).toISOString() : null
  const r = await sendCommand(worker, 'thread_direct_send', { session, text, message_id: msg_id, target_role, expires_at, operation_id })
  if (r.ok) {
    const d = r.data as ThreadDirectSendResult
    recordDirect({ ...base, target_delivery: d.target_delivery, pm_notice_delivery: d.pm_notice_delivery, pm_session: d.pm_session ?? pm_session, operation_id })
    return json({ status: 'accepted', target_delivery: d.target_delivery, pm_notice_delivery: d.pm_notice_delivery, pm_session: d.pm_session ?? pm_session })
  }
  if (!r.sent) return holdOffline()
  if (unknownOutcome(r)) {
    recordDirect({ ...base, target_delivery: 'delivery_unknown', pm_notice_delivery: noticeNa('delivery_unknown'), reason: r.error.code, operation_id })
    return json({ status: 'delivery_unknown', error: r.error.code, message: r.error.message }, 202)
  }
  recordDirect({ ...base, target_delivery: 'failed', pm_notice_delivery: noticeNa('failed'), reason: r.error.code, operation_id })
  return json({ status: 'failed', error: r.error.code, message: r.error.message }, 409)
}

function threadHistoryRoute(url: URL): Response {
  if (!cfg.webchat.threads.enabled) return json({ error: 'forbidden', message: 'threads are disabled' }, 403)
  const worker = url.searchParams.get('worker') ?? ''
  const session = url.searchParams.get('session') ?? ''
  if (!ID_RE.test(worker) || !ID.test(session)) return json({ error: 'bad_args', message: 'worker and session are required' }, 400)
  const cap = cfg.log.max_thread_history_page
  const limit = Math.min(cap, Math.max(1, Number(url.searchParams.get('limit')) || cap))
  const before = Number(url.searchParams.get('before')) || null
  const after = Number(url.searchParams.get('after_seq') ?? url.searchParams.get('after')) || null
  const page = threadHistory(events.events, worker, session, { before, after, limit })
  const s = workers.get(worker)?.sessions.get(session)
  return json({
    worker,
    session,
    project: s?.project ?? null,
    role: s?.role ?? null,
    pm_session: s?.pm_session ?? null,
    state: s?.state ?? null,
    coverage: coverageOf(events.events, worker, session),
    ...page,
  })
}

function threadsRoute(): Response {
  if (!cfg.webchat.threads.enabled) return json({ error: 'forbidden', message: 'threads are disabled' }, 403)
  const coverage: Record<string, Coverage> = {}
  for (const e of events.events) if (e.kind === 'thread_entry') coverage[`${e.worker}/${e.session}`] = nextCoverage(coverage[`${e.worker}/${e.session}`], e)
  return json({
    direct_send_enabled: cfg.webchat.threads.direct_send_enabled,
    workers: buildThreads(threadWorkers()),
    secretaries: secretaryList(),
    coverage,
  })
}

const server: BunServer<WsData> = Bun.serve<WsData>({
  hostname: cfg.listen.host,
  port: cfg.listen.port,
  idleTimeout: 0,
  async fetch(req, srv) {
    const url = new URL(req.url)
    if (url.pathname === '/ws/worker') {
      if (srv.upgrade(req, { data: { kind: 'worker' } })) return
      return new Response('upgrade required', { status: 426 })
    }
    if (url.pathname === '/bridge') {
      const ip = srv.requestIP(req)?.address ?? ''
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return new Response('forbidden', { status: 403 })
      if (srv.upgrade(req, { data: { kind: 'bridge' } })) return
      return new Response('upgrade required', { status: 426 })
    }
    if (req.method === 'GET' && url.pathname === '/') {
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
    }
    if (url.pathname === '/health') return json({ ok: true })
    if (!url.pathname.startsWith('/api/')) return new Response('not found', { status: 404 })
    if (!authed(req, url)) {
      events.record('auth_rejected', { path: url.pathname })
      return json({ error: 'unauthorized' }, 401)
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      const since = Number(url.searchParams.get('since') ?? 0) || 0
      let unsub: (() => void) | undefined
      let ping: ReturnType<typeof setInterval> | undefined
      const stream = new ReadableStream({
        start(ctrl) {
          const push = (e: SeqEvent) => ctrl.enqueue(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`)
          for (const e of events.since(since, cfg.log.max_events_replay)) push(e)
          unsub = events.subscribe(push)
          ping = setInterval(() => ctrl.enqueue(': ping\n\n'), 25000)
          req.signal.addEventListener('abort', () => {
            unsub?.()
            clearInterval(ping)
          })
        },
        cancel() {
          unsub?.()
          clearInterval(ping)
        },
      })
      return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } })
    }
    if (req.method === 'GET' && url.pathname === '/api/state') return json(stateSnapshot())
    if (req.method === 'GET' && url.pathname === '/api/settings') return json(await settingsView())
    if (req.method === 'POST' && url.pathname === '/api/settings/hub') return saveHubSettings(await body(req))
    if (req.method === 'POST' && url.pathname === '/api/settings/worker') return saveWorkerSettings(await body(req))
    if (req.method === 'GET' && url.pathname === '/api/threads') return threadsRoute()
    if (req.method === 'GET' && url.pathname === '/api/thread/history') return threadHistoryRoute(url)
    if (req.method === 'POST' && url.pathname === '/api/thread/send') return threadSend(await body(req))
    if (req.method === 'GET' && url.pathname === '/api/offline-requests') return json({ requests: queue.list().map(offlineView) })

    if (req.method === 'POST' && url.pathname === '/api/offline-requests/cancel') {
      const b = await body<{ operation_id: string }>(req)
      const x = b && typeof b.operation_id === 'string' ? queue.get(b.operation_id) : undefined
      if (!x) return json({ error: 'not_found' }, 404)
      if (x.state !== 'pending_offline') return json({ error: 'invalid_state', message: `only held requests can be cancelled (state ${x.state})` }, 409)
      const y = markQ(x.operation_id, 'cancelled', 'webchat')
      if (y?.request_id) setRequestState(y.request_id, 'cancelled', { reason: 'webchat' })
      if (y?.kind === 'thread_direct_send' && y.session && y.message_id)
        recordDirect({ worker: y.worker, project: y.project, session: y.session, message_id: y.message_id, target_delivery: 'cancelled', pm_session: null, pm_notice_delivery: y.target_role === 'task' ? 'cancelled' : 'not_applicable', operation_id: y.operation_id })
      return json({ status: 'cancelled' })
    }

    if (req.method === 'POST' && url.pathname === '/api/send') {
      const b = await body<{ conv_id: string; msg_id: string; text: string }>(req)
      if (!b || typeof b.text !== 'string' || !b.text.trim() || !CONTEXT_ID_RE.test(b.conv_id ?? '') || !ID.test(b.msg_id ?? ''))
        return json({ error: 'conv_id, msg_id (ids) and text are required' }, 400)
      if (events.hasKey(msgKey(b.msg_id))) return json({ status: 'duplicate_ignored' })
      const e = events.record('user_message', { context_id: b.conv_id, conv_id: b.conv_id, msg_id: b.msg_id, text: b.text, source: 'webchat' })
      const delivery = deliverToContext(b.conv_id, b.text, { kind: 'user', message_id: b.msg_id, source: 'webchat', context_id: b.conv_id })
      return json({ status: 'accepted', seq: e.seq, delivery })
    }

    if (req.method === 'POST' && url.pathname === '/api/answer') {
      const b = await body<{ approval_id: string; choice: string | number }>(req)
      const a = b ? approvals.get(b.approval_id) : undefined
      if (!b || !a) return json({ error: 'unknown approval' }, 404)
      let r: { ok: boolean; status?: string; error?: string; message?: string }
      if (a.type === 'tool') {
        if (b.choice !== 'allow' && b.choice !== 'deny') return json({ error: 'choice must be allow or deny' }, 400)
        if (a.worker === SECRETARY) {
          try {
            r = { ok: true, status: secretaries.answerApproval(a.session, a.request_id!, b.choice) }
          } catch (e) {
            r = { ok: false, error: (e as CommandError).code, message: (e as Error).message }
          }
        } else {
          const x = await sendCommand(a.worker, 'approval_answer', { session: a.session, request_id: a.request_id, behavior: b.choice })
          r = x.ok ? { ok: true, ...(x.data as object) } : { ok: false, error: x.error.code, message: x.error.message }
        }
      } else {
        const option = Number(b.choice)
        if (!Number.isInteger(option)) return json({ error: 'choice must be an option index' }, 400)
        if (a.worker === SECRETARY) {
          try {
            r = { ok: true, status: secretaries.answerTerminal(a.session, a.prompt_id!, option) }
          } catch (e) {
            r = { ok: false, error: (e as CommandError).code, message: (e as Error).message }
          }
        } else {
          const x = await sendCommand(a.worker, 'terminal_answer', { session: a.session, prompt_id: a.prompt_id, option })
          r = x.ok ? { ok: true, ...(x.data as object) } : { ok: false, error: x.error.code, message: x.error.message }
        }
      }
      events.record('approval_answered', { approval_id: a.approval_id, choice: b.choice, ok: r.ok, error: r.error ?? null })
      if (!r.ok && (r.error === 'stale' || r.error === 'not_found')) closeApproval(x => x.approval_id === a.approval_id, 'stale', 'stale')
      return json(r, r.ok ? 200 : 409)
    }

    if (req.method === 'POST' && (url.pathname === '/api/session/interrupt' || url.pathname === '/api/session/stop')) {
      const b = await body<{ worker: string; session: string }>(req)
      if (!b || typeof b.worker !== 'string' || typeof b.session !== 'string') return json({ error: 'worker and session required' }, 400)
      const action = url.pathname.endsWith('interrupt') ? 'interrupt' : 'stop'
      const r = await sessionAction(b.worker, b.session, action)
      events.record('session_action', { worker: b.worker, session: b.session, action, ok: r.ok })
      return json(r, r.ok ? 200 : 409)
    }
    return json({ error: 'not found' }, 404)
  },
  websocket: {
    idleTimeout: 60,
    sendPings: true,
    message(ws, raw) {
      const s = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')
      if (ws.data.kind === 'bridge') secretaries.bridgeMessage(ws as unknown as BridgeSocket, s)
      else workerMessage(ws, s)
    },
    close(ws) {
      if (ws.data.kind === 'bridge') secretaries.bridgeClosed(ws as unknown as BridgeSocket)
      else workerClosed(ws)
    },
  },
})

// ---------------------------------------------------------------- startup
restoreInventory()
ledger.restore()
for (const x of queue.restore()) {
  recordQueueState(x)
  if (x.request_id) setRequestState(x.request_id, 'delivery_unknown', { reason: x.reason ?? null })
}
secretaries.restore()
// a Phase 2 single secretary has no conversation: it can never be routed to, so it is stopped (fail closed)
for (const s of secretaries.list()) {
  if (s.context_id == null && !ENDED.includes(s.state)) {
    secretaries.stop(s.key)
    events.record('notice', { level: 'info', text: `会話に属さない旧秘書セッション ${s.key.slice(0, 8)} を停止しました` })
  }
}
events.record('notice', { level: 'info', text: `ハブを起動しました（${cfg.listen.host}:${server.port}）` })
if (cfg.secretary.autostart) {
  // resume the secretaries of recently used conversations (secretaries are otherwise started by the first message)
  const recent = Date.now() - cfg.secretary.contexts.idle_minutes * 60000
  const ctxs = contexts
    .all()
    .filter(c => Date.parse(c.last_used_at) >= recent)
    .sort((a, b) => b.last_used_at.localeCompare(a.last_used_at))
    .slice(0, cfg.secretary.contexts.max_active)
  for (const c of ctxs) {
    try {
      ensureContextSecretary(c.context_id)
    } catch (e) {
      events.record('notice', { level: 'error', text: `会話 ${c.context_id} の秘書を起動できませんでした: ${(e as Error).message}` })
    }
  }
}
sweep()
setInterval(sweep, 30000)
setInterval(() => held.size && flushHeld(), 3000)
setInterval(idleSweep, 30000)
const base = cfg.public_url ?? `http://${cfg.listen.host}:${server.port}`
log(C, 'hub started', { url: base, workers: cfg.workers.length })
process.stderr.write(`WebChat: ${base}/#token=<secrets/webchat-token>\n`)

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log(C, 'hub stopping (secretaries keep running in tmux)', { signal: sig })
    secretaries.close()
    process.exit(0)
  })
}

