// Project PM / task routing on the worker (02 §3.4-3.6, §4, §4.1): pm_ensure, pm_send, thread_direct_send,
// the PM's local tools, task reports to the PM, and the events the hub uses for threads.
import { z } from 'zod'
import type { LoadedWorkerConfig, ProjectConfig } from '../shared/config.ts'
import {
  CommandError,
  cleanMeta,
  type BridgeSetup,
  type DeliveryStatus as WireDelivery,
  type DirectDelivery,
  type PmSendResult,
  type SessionInfo,
  type ThreadDirectSendResult,
  type WorkerEvent,
  type WorkItemStatus,
} from '../shared/protocol.ts'
import { TERMINAL_STATES, type SessionManager, type SessionRecord } from '../shared/session-manager.ts'
import { log, nowIso, readJson, rid, writeJsonAtomic } from '../shared/util.ts'
import { Dispatcher, type Delivery, type DeliveryStatus } from './dispatch.ts'
import { PM_TOOL_DEFS, TASK_REPLY_TOOL, noticeText, pmInstructions, taskInstructions } from './instructions.ts'
import { guardLaunch, type LeaseManager } from './lease.ts'
import { ReceivedLedger, payloadHash, type ReceivedEntry } from './received.ts'

type PmCtx = {
  requests: string[] // request_ids delivered to this PM (most recent last)
  directs: string[] // message_ids of direct posts delivered to this PM
  // most recent request / direct post delivered to this PM (task reports and notices do not change it)
  last: { request_id?: string | null; message_id?: string | null } | null
  answered?: string[] // request_ids / message_ids the PM already replied to (with the id)
}
type TaskCtx = { request_id: string | null; message_id: string | null }
type Contexts = { pms: Record<string, PmCtx>; tasks: Record<string, TaskCtx>; work_items: Record<string, { project: string; pm_session: string }> }

const KEEP_IDS = 200
const iso = z.string().refine(v => !Number.isNaN(Date.parse(v)), 'must be an ISO date-time')
const id64 = z.string().min(1).max(128)

export const ARGS = {
  pm_ensure: z.object({ project: z.string() }),
  pm_send: z.object({
    project: z.string(),
    text: z.string().min(1).max(100000),
    request_id: id64,
    expires_at: iso.nullish(),
    message_id: id64.nullish(),
    operation_id: id64.nullish(),
    work_item_id: id64.nullish(),
    context_id: z.string().max(200).nullish(),
    chat_id: z.string().max(64).nullish(),
  }),
  thread_direct_send: z.object({
    session: z.string(),
    text: z.string().min(1).max(100000),
    message_id: id64,
    expires_at: iso.nullish(),
    target_role: z.enum(['pm', 'task']).nullish(),
    operation_id: id64.nullish(),
  }),
  session_send: z.object({
    session: z.string(),
    text: z.string().min(1).max(100000),
    chat_id: z.string().max(64).nullish(),
    message_id: z.string().max(64).nullish(),
  }),
  session_resume: z.object({ session: z.string(), chat_id: z.string().max(64).nullish() }),
}

const WI_STATUS = z.enum(['open', 'in_progress', 'blocked', 'done'])
const TOOL_ARGS = {
  reply: z.object({ text: z.string(), request_id: z.string().max(128).nullish(), in_reply_to: z.string().max(128).nullish() }),
  session: z.object({ session: z.string() }),
  task_create: z.object({ name: z.string().max(80).nullish() }),
  task_send: z.object({ session: z.string(), text: z.string().min(1).max(100000) }),
  work_item_create: z.object({
    title: z.string().min(1).max(200),
    status: WI_STATUS.nullish(),
    summary: z.string().max(2000).nullish(),
    request_id: z.string().max(128).nullish(),
  }),
  work_item_update: z.object({
    work_item_id: z.string().min(1).max(128),
    status: WI_STATUS.nullish(),
    title: z.string().min(1).max(200).nullish(),
    summary: z.string().max(2000).nullish(),
    assignee: z.string().max(128).nullish(),
  }),
}

function parse<T>(schema: z.ZodType<T>, args: unknown): T {
  const r = schema.safeParse(args ?? {})
  if (!r.success) throw new CommandError('bad_args', r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '))
  return r.data
}

const toWire = (s: DeliveryStatus): WireDelivery =>
  s === 'pending' ? 'worker_queued' : s === 'resource_wait' ? 'resource_wait' : s === 'delivered' ? 'delivered' : s === 'expired' ? 'expired' : 'delivery_unknown'
const toDirect = (s: DeliveryStatus | undefined): DirectDelivery =>
  !s ? 'not_applicable' : s === 'pending' || s === 'sending' ? 'queued' : s === 'failed' ? 'delivery_unknown' : s

export type RouterDeps = {
  cfg: LoadedWorkerConfig
  stateDir: string
  emit: (e: WorkerEvent) => void
  inventory: () => void
  leases: LeaseManager
  received: ReceivedLedger
  manager: () => SessionManager // late-bound (the manager needs the router's callbacks)
  dispatcher: () => Dispatcher
}

export class Router {
  private ctx: Contexts
  private ctxFile: string
  private syncing = new Set<string>() // delivery keys inside a running command: no duplicate events

  constructor(private d: RouterDeps) {
    this.ctxFile = `${d.stateDir}/pm-context.json`
    this.ctx = readJson<Contexts>(this.ctxFile, { pms: {}, tasks: {}, work_items: {} })
    this.ctx.work_items ??= {}
  }

  private get m(): SessionManager {
    return this.d.manager()
  }
  private get q(): Dispatcher {
    return this.d.dispatcher()
  }
  private saveCtx(): void {
    writeJsonAtomic(this.ctxFile, this.ctx)
  }
  private pmCtx(key: string): PmCtx {
    const c = (this.ctx.pms[key] ??= { requests: [], directs: [], last: null })
    c.answered ??= []
    return c
  }
  private project(id: string): ProjectConfig {
    const p = this.d.cfg.projects.find(x => x.id === id)
    if (!p) throw new CommandError('not_found', `no project "${id}". known: ${this.d.cfg.projects.map(x => x.id).join(', ')}`)
    return p
  }
  private info(key: string): SessionInfo {
    return this.m.list().find(s => s.key === key)!
  }

  // ------------------------------------------------------------ PM lookup (02 §3.4: one PM per (worker, project))
  findPm(projectId: string): SessionRecord | undefined {
    const pms = this.m.records().filter(r => r.role === 'pm' && r.project === projectId)
    const live = pms.filter(r => !TERMINAL_STATES.includes(r.state))
    const pick = (a: SessionRecord[]) => [...a].sort((x, y) => y.updated_at.localeCompare(x.updated_at))[0]
    if (pms.length > 1) log('worker', 'more than one PM record for a project; using one', { project: projectId, count: pms.length })
    return pick(live) ?? pick(pms)
  }

  // the PM record, created when missing; resumed only when `resume` (pm_send leaves that to the dispatcher)
  private ensurePmRecord(p: ProjectConfig, resume: boolean): SessionRecord {
    if (!p.pm.enabled) throw new CommandError('pm_disabled', `project "${p.id}" has its project PM disabled`)
    const pm = this.findPm(p.id)
    if (!pm) {
      const s = this.m.create({ project: p.id, cwd: p.path, name: `${p.id} PM`, role: 'pm', pm_session: null })
      this.d.inventory()
      return this.m.find(s.key)!
    }
    if (resume && TERMINAL_STATES.includes(pm.state)) {
      this.m.resume(pm.key)
      this.d.inventory()
    }
    return pm
  }

  pmEnsure(args: unknown): { session: SessionInfo } {
    const a = parse(ARGS.pm_ensure, args)
    const pm = this.ensurePmRecord(this.project(a.project), true)
    return { session: this.info(pm.key) }
  }

  // ------------------------------------------------------------ pm_send
  pmSend(args: unknown): PmSendResult {
    const a = parse(ARGS.pm_send, args)
    const p = this.project(a.project)
    if (!p.pm.enabled) throw new CommandError('pm_disabled', `project "${p.id}" has its project PM disabled`)
    const hash = payloadHash('pm_send', a.project, a.text, a.work_item_id)
    const rkey = ReceivedLedger.pmKey(a.request_id)
    const prev = this.d.received.lookup(rkey, hash)
    if (prev) return this.pmResult(prev)
    if (a.expires_at && Date.parse(a.expires_at) <= Date.now()) {
      this.d.emit({ kind: 'delivery', request_id: a.request_id, operation_id: a.operation_id ?? null, project: p.id, status: 'expired', reason: 'deadline_expired' })
      throw new CommandError('deadline_expired', `expires_at ${a.expires_at} has passed; not delivered`)
    }
    const pm = this.ensurePmRecord(p, false)
    const d = this.delivery({
      origin: 'pm_send',
      target: pm.key,
      kind: 'task',
      content: a.text,
      meta: { kind: 'task', project: p.id, request_id: a.request_id, work_item_id: a.work_item_id, message_id: a.message_id },
      lease: true,
      resume: true,
      expires_at: a.expires_at ?? null,
      request_id: a.request_id,
      message_id: a.message_id ?? null,
      operation_id: a.operation_id ?? null,
    })
    this.d.received.record({ key: rkey, hash, result: { pm_session: pm.key, operation_id: a.operation_id ?? null }, deliveries: [d.key] })
    this.sync([d], () => this.q.enqueue(d))
    return this.pmResult(this.d.received.lookup(rkey, hash)!)
  }

  private pmResult(e: ReceivedEntry): PmSendResult {
    const d = this.q.get(e.deliveries[0] ?? '')
    const base = { pm_session: String(e.result.pm_session), operation_id: (e.result.operation_id as string | null) ?? null }
    if (!d) {
      const last = e.result.status as PmSendResult['status'] | undefined
      if (last) return { ...base, status: last }
      throw new CommandError('delivery_unknown', 'this request was accepted before but its delivery record is gone; not re-sent')
    }
    if (d.status === 'expired') throw new CommandError('deadline_expired', 'the request expired before it reached the PM')
    if (d.status === 'delivery_unknown' || d.status === 'failed' || d.status === 'sending')
      throw new CommandError('delivery_unknown', `delivery outcome unknown (${d.reason ?? d.status}); not re-sent automatically`)
    const status = d.status === 'delivered' ? 'delivered' : d.status === 'resource_wait' ? 'resource_wait' : 'worker_queued'
    return { ...base, status, ...(status === 'resource_wait' ? { reason: d.wait_reason ?? 'workspace_busy' } : {}) }
  }

  // ------------------------------------------------------------ Phase 2 low-level commands
  // session_send: only for tasks without a PM (Phase 2). PM and PM-task sessions are driven through pm_send /
  // thread_direct_send so that ordering, request attribution and the write lease apply. The orphan task goes
  // through the same dispatcher and lease as everything else.
  sessionSend(args: unknown): { status: 'delivered' | 'queued' | 'resource_wait' } {
    const a = parse(ARGS.session_send, args)
    const t = this.m.find(a.session)
    if (!t) throw new CommandError('not_found', `no session ${a.session}`)
    if (t.role === 'pm') throw new CommandError('invalid_state', 'this is a project PM: use pm_send (secretary: project_pm_send) or a direct thread post')
    if (t.role === 'task' && t.pm_session)
      throw new CommandError('invalid_state', 'this task belongs to a project PM: send through the PM (pm_send) or post to its thread (thread_direct_send)')
    if (t.role !== 'task') throw new CommandError('forbidden', 'only task sessions accept session_send')
    if (TERMINAL_STATES.includes(t.state) || t.state === 'stopping') throw new CommandError('invalid_state', `session is ${t.state}; resume it first`)
    const d = this.delivery({
      origin: 'session_send',
      target: t.key,
      kind: 'task',
      content: a.text,
      meta: { kind: 'task', chat_id: a.chat_id, message_id: a.message_id },
      lease: true,
      resume: false,
      expires_at: null,
      request_id: null,
      message_id: a.message_id ?? null,
      operation_id: rid('op', 8),
      chat_id: a.chat_id ?? null,
    })
    this.sync([d], () => this.q.enqueue(d))
    const now = this.q.get(d.key)!
    if (now.status === 'delivery_unknown' || now.status === 'failed')
      throw new CommandError('delivery_unknown', `delivery outcome unknown (${now.reason ?? now.status}); not re-sent automatically`)
    return { status: now.status === 'delivered' ? 'delivered' : now.status === 'resource_wait' ? 'resource_wait' : 'queued' }
  }

  // session_resume of a PM is pm_ensure (one PM per project, 02 §3.4); tasks resume as before
  sessionResume(args: unknown): { session: SessionInfo } {
    const a = parse(ARGS.session_resume, args)
    const t = this.m.find(a.session)
    if (!t) throw new CommandError('not_found', `no session ${a.session}`)
    if (t.role === 'pm') return this.pmEnsure({ project: t.project })
    const s = this.m.resume(a.session, a.chat_id)
    this.d.inventory()
    return { session: s }
  }

  // ------------------------------------------------------------ thread_direct_send (02 §3.6)
  threadDirectSend(args: unknown): ThreadDirectSendResult {
    const a = parse(ARGS.thread_direct_send, args)
    const t = this.m.find(a.session)
    if (!t) throw new CommandError('not_found', `no session ${a.session}`)
    if (t.role === 'secretary') throw new CommandError('forbidden', 'direct posts go to a PM or a task session')
    if (a.target_role && a.target_role !== t.role) throw new CommandError('forbidden', `target_role ${a.target_role} does not match the session (${t.role})`)
    const p = this.project(t.project)
    const hash = payloadHash('direct', a.session, a.text)
    const rkey = ReceivedLedger.directKey(a.session, a.message_id)
    const prev = this.d.received.lookup(rkey, hash)
    if (prev) return this.directResult(prev)
    let pm: SessionRecord | undefined
    if (t.role === 'task') {
      pm = t.pm_session ? this.m.find(t.pm_session) : undefined
      if (!pm || pm.role !== 'pm' || pm.project !== t.project)
        throw new CommandError('orphan_task', 'this task session has no valid project PM; direct posts to it are refused')
    }
    if (a.expires_at && Date.parse(a.expires_at) <= Date.now()) {
      this.d.emit({
        kind: 'direct_delivery_state',
        session: t.key,
        project: t.project,
        message_id: a.message_id,
        target_delivery: 'expired',
        pm_session: pm?.key ?? null,
        pm_notice_delivery: pm ? 'expired' : 'not_applicable',
        reason: 'deadline_expired',
      })
      throw new CommandError('deadline_expired', `expires_at ${a.expires_at} has passed; not delivered`)
    }
    const target = this.delivery({
      origin: 'direct',
      target: t.key,
      kind: 'user_direct',
      content: a.text,
      meta: { kind: 'user_direct', project: p.id, session: t.key, message_id: a.message_id },
      lease: true,
      resume: true,
      expires_at: a.expires_at ?? null,
      request_id: null,
      message_id: a.message_id,
      operation_id: a.operation_id ?? null,
    })
    const ds = [target]
    if (pm) {
      const notice = this.delivery({
        origin: 'direct_notice',
        target: pm.key,
        kind: 'user_direct_notice',
        content: noticeText(t.name, t.key, a.message_id, a.text),
        meta: { kind: 'user_direct_notice', project: p.id, session: t.key, task_session: t.key, pm_session: pm.key, message_id: a.message_id },
        lease: false, // a notice is not work (02 §3.6)
        resume: true,
        expires_at: null, // held until the PM runs again; never dropped
        request_id: null,
        message_id: a.message_id,
        operation_id: a.operation_id ?? null,
      })
      target.pair = notice.key
      notice.pair = target.key
      ds.push(notice)
    }
    // one journal record for the post and its notice before any delivery starts
    this.d.received.record({ key: rkey, hash, result: { pm_session: pm?.key ?? null }, deliveries: ds.map(x => x.key) })
    this.sync(ds, () => this.q.enqueue(...ds))
    const r = this.directResult(this.d.received.lookup(rkey, hash)!)
    if (pm) this.emitNotice(this.q.get(ds[1]!.key)!)
    this.emitDirectState(this.q.get(target.key)!)
    return r
  }

  private directResult(e: ReceivedEntry): ThreadDirectSendResult {
    const [tk, nk] = e.deliveries
    const t = this.q.get(tk ?? '')
    const n = nk ? this.q.get(nk) : undefined
    return {
      target_delivery: t ? toDirect(t.status) : 'delivery_unknown',
      pm_notice_delivery: nk ? (n ? toDirect(n.status) : 'delivery_unknown') : 'not_applicable',
      pm_session: (e.result.pm_session as string | null) ?? null,
    }
  }

  private delivery(
    x: Omit<Delivery, 'key' | 'pair' | 'status' | 'reason' | 'created_at' | 'updated_at' | 'meta'> & {
      meta: Record<string, string | null | undefined>
    },
  ): Delivery {
    const key = Dispatcher.newKey()
    return {
      ...x,
      key,
      meta: cleanMeta({ ...x.meta, delivery_id: key }),
      pair: null,
      status: 'pending',
      reason: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    }
  }

  private sync(ds: Delivery[], fn: () => void): void {
    for (const d of ds) this.syncing.add(d.key)
    try {
      fn()
    } finally {
      for (const d of ds) this.syncing.delete(d.key)
    }
  }

  // ------------------------------------------------------------ delivery status -> events / contexts
  prepare(d: Delivery): void {
    if (d.origin === 'direct_notice' && d.pair) d.meta.target_delivery = toDirect(this.q.get(d.pair)?.status)
  }

  onDeliveryStatus(d: Delivery, _prev: DeliveryStatus): void {
    if (d.status === 'sending') return
    const sync = this.syncing.has(d.key)
    const s = this.m.find(d.target)
    if (d.status === 'resource_wait' && s) {
      this.d.emit({
        kind: 'resource_wait',
        session: s.key,
        project: s.project,
        resource_id: this.d.leases.resourceFor(s.cwd).resource_id,
        reason: d.wait_reason ?? 'workspace_busy',
        operation_id: d.operation_id,
        request_id: d.request_id,
        message_id: d.message_id,
      })
    }
    if (d.status === 'delivered') this.noteDelivered(d)
    switch (d.origin) {
      case 'pm_send':
        if (!sync)
          this.d.emit({
            kind: 'delivery',
            request_id: d.request_id,
            message_id: d.message_id,
            operation_id: d.operation_id,
            session: d.target,
            project: s?.project ?? null,
            status: toWire(d.status),
            reason: d.status === 'resource_wait' ? (d.wait_reason ?? null) : d.reason,
          })
        return
      case 'direct':
        if (!sync) this.emitDirectState(d)
        return
      case 'direct_notice':
        if (!sync) {
          this.emitNotice(d)
          const t = d.pair ? this.q.get(d.pair) : undefined
          if (t) this.emitDirectState(t)
        }
        return
    }
  }

  private noteDelivered(d: Delivery): void {
    if (d.origin === 'pm_send' && d.request_id) {
      const c = this.pmCtx(d.target)
      c.requests = [...c.requests.filter(x => x !== d.request_id), d.request_id].slice(-KEEP_IDS)
      c.last = { request_id: d.request_id }
    } else if (d.origin === 'direct' && d.message_id) {
      const s = this.m.find(d.target)
      if (s?.role === 'pm') {
        const c = this.pmCtx(d.target)
        c.directs = [...c.directs, d.message_id].slice(-KEEP_IDS)
        c.last = { message_id: d.message_id }
      } else {
        // the task now works on the person's post: its next reply answers that post, not the PM's request
        // (02 §3.6: a direct-post answer is not counted again as an answer to the secretary's request)
        this.ctx.tasks[d.target] = { request_id: null, message_id: d.message_id }
      }
    } else if (d.origin === 'task_send') {
      this.ctx.tasks[d.target] = { request_id: d.request_id, message_id: null }
    } else return
    // a task_report does not change the PM's `last`: the report is about the task, not a new request
    this.saveCtx()
  }

  private emitDirectState(t: Delivery): void {
    const s = this.m.find(t.target)
    const n = t.pair ? this.q.get(t.pair) : undefined
    this.d.emit({
      kind: 'direct_delivery_state',
      session: t.target,
      project: s?.project ?? '',
      message_id: t.message_id ?? '',
      target_delivery: toDirect(t.status),
      pm_session: n?.target ?? null,
      pm_notice_delivery: n ? toDirect(n.status) : 'not_applicable',
      reason: t.status === 'resource_wait' ? (t.wait_reason ?? null) : t.reason,
    })
  }

  private emitNotice(n: Delivery): void {
    const pm = this.m.find(n.target)
    this.d.emit({
      kind: 'user_direct_notice',
      session: n.meta.task_session ?? '',
      pm_session: n.target,
      project: pm?.project ?? n.meta.project ?? '',
      message_id: n.message_id ?? '',
      status: toDirect(n.status),
    })
  }

  // ------------------------------------------------------------ bridge setup / launch
  setupFor(s: SessionInfo & { cwd: string }): BridgeSetup {
    const p = this.d.cfg.projects.find(x => x.id === s.project)
    if (s.role === 'pm' && p)
      return { t: 'setup', server_name: 'hannigan', role: 'pm', tools: PM_TOOL_DEFS, instructions: pmInstructions(this.d.cfg.worker_id, p) }
    return {
      t: 'setup',
      server_name: 'hannigan',
      role: s.role,
      tools: [TASK_REPLY_TOOL],
      instructions: taskInstructions(this.d.cfg.worker_id, p, s),
    }
  }

  // sessions whose transcript is observed for the thread view: PMs and tasks of a PM
  static observed(s: { role: string; pm_session: string | null }): boolean {
    return s.role === 'pm' || (s.role === 'task' && !!s.pm_session)
  }

  // the write-lease guard goes into every worker session, Phase 2 orphan tasks included
  launchExtras(s: SessionRecord): { args: string[]; env: Record<string, string> } | null {
    const l = this.d.leases.ensure(s.cwd)
    return guardLaunch(this.d.stateDir, this.d.cfg.bun_bin, s.key, l.workspace_real, this.d.leases.leaseFile(l.resource_id))
  }

  // ------------------------------------------------------------ tools
  async onToolCall(s: SessionRecord, name: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
    try {
      if (s.role === 'pm') return { ok: true, text: this.pmTool(s, name, args) }
      if (name !== 'reply') return { ok: false, text: `unknown tool ${name}` }
      return { ok: true, text: this.taskReply(s, args) }
    } catch (e) {
      if (e instanceof CommandError) return { ok: false, text: `${e.code}: ${e.message}` }
      log('worker', 'tool error', { session: s.key, tool: name, err: String(e) })
      return { ok: false, text: `internal: ${(e as Error).message}` }
    }
  }

  // a task of `pm`: same project, pm_session == pm (02 §4.1 権限境界)
  private ownTask(pm: SessionRecord, key: string): SessionRecord {
    const t = this.m.find(key)
    if (!t) throw new CommandError('not_found', `no session ${key}`)
    if (t.role !== 'task' || t.pm_session !== pm.key || t.project !== pm.project)
      throw new CommandError('forbidden_scope', 'that session is not one of your task sessions in this project')
    return t
  }

  private pmTool(pm: SessionRecord, name: string, args: Record<string, unknown>): string {
    const c = this.pmCtx(pm.key)
    switch (name) {
      case 'reply':
        return this.pmReply(pm, args)
      case 'task_list':
        return JSON.stringify({
          tasks: this.m
            .records()
            .filter(t => t.role === 'task' && t.pm_session === pm.key && t.project === pm.project)
            .map(t => ({ session: t.key, name: t.name, state: t.state, created_at: t.created_at })),
        })
      case 'task_create': {
        const a = parse(TOOL_ARGS.task_create, args)
        const s = this.m.create({ project: pm.project, cwd: pm.cwd, name: a.name ?? undefined, role: 'task', pm_session: pm.key })
        this.d.emit({ kind: 'task_event', project: pm.project, pm_session: pm.key, task_session: s.key, action: 'created', text: s.name, request_id: c.last?.request_id ?? null })
        this.d.inventory()
        return JSON.stringify({ session: s.key, name: s.name, state: s.state })
      }
      case 'task_resume': {
        const t = this.ownTask(pm, parse(TOOL_ARGS.session, args).session)
        const s = this.m.resume(t.key)
        this.d.inventory()
        return JSON.stringify({ session: s.key, state: s.state })
      }
      case 'task_send': {
        const a = parse(TOOL_ARGS.task_send, args)
        const t = this.ownTask(pm, a.session)
        if (TERMINAL_STATES.includes(t.state) || t.state === 'stopping')
          throw new CommandError('invalid_state', `task session is ${t.state}; resume it first with task_resume`)
        const request_id = c.last?.request_id ?? null
        const d = this.delivery({
          origin: 'task_send',
          target: t.key,
          kind: 'task',
          content: a.text,
          meta: { kind: 'task', project: pm.project, pm_session: pm.key, request_id },
          lease: true,
          resume: false,
          expires_at: null,
          request_id,
          message_id: null,
          operation_id: rid('op', 8), // Mac-issued operation id for a local instruction (Q16/A 1)
        })
        this.sync([d], () => this.q.enqueue(d))
        const now = this.q.get(d.key)!
        this.d.emit({ kind: 'task_event', project: pm.project, pm_session: pm.key, task_session: t.key, action: 'sent', text: a.text, request_id })
        return JSON.stringify({ status: toWire(now.status), operation_id: d.operation_id, ...(now.status === 'resource_wait' ? { reason: now.wait_reason } : {}) })
      }
      case 'task_interrupt': {
        const t = this.ownTask(pm, parse(TOOL_ARGS.session, args).session)
        return JSON.stringify({ status: this.m.interrupt(t.key) })
      }
      case 'task_stop': {
        const t = this.ownTask(pm, parse(TOOL_ARGS.session, args).session)
        return JSON.stringify({ status: this.m.stop(t.key) })
      }
      case 'work_item_create': {
        const a = parse(TOOL_ARGS.work_item_create, args)
        const work_item_id = rid('wi', 8)
        this.ctx.work_items[work_item_id] = { project: pm.project, pm_session: pm.key }
        this.saveCtx()
        this.d.emit({
          kind: 'work_item_created',
          project: pm.project,
          pm_session: pm.key,
          work_item_id,
          title: a.title,
          status: (a.status ?? 'open') as WorkItemStatus,
          summary: a.summary ?? null,
          request_id: a.request_id ?? c.last?.request_id ?? null,
        })
        return JSON.stringify({ work_item_id })
      }
      case 'work_item_update': {
        const a = parse(TOOL_ARGS.work_item_update, args)
        const w = this.ctx.work_items[a.work_item_id]
        if (!w) throw new CommandError('not_found', `no work item ${a.work_item_id}`)
        if (w.project !== pm.project) throw new CommandError('forbidden_scope', 'that work item belongs to another project')
        this.d.emit({
          kind: 'work_item_updated',
          project: pm.project,
          pm_session: pm.key,
          work_item_id: a.work_item_id,
          ...(a.title ? { title: a.title } : {}),
          ...(a.status ? { status: a.status as WorkItemStatus } : {}),
          ...(a.summary != null ? { summary: a.summary } : {}),
          ...(a.assignee != null ? { assignee: a.assignee } : {}),
          request_id: c.last?.request_id ?? null,
        })
        return JSON.stringify({ work_item_id: a.work_item_id, status: 'updated' })
      }
      default:
        throw new CommandError('unknown_command', `unknown tool ${name}`)
    }
  }

  // PM reply attribution (02 §3.6 返信の振り分け). In order:
  //  1. in_reply_to of a direct post this PM received -> that post (user_direct)
  //  2. request_id this PM received -> that request (also when in_reply_to was not a known post)
  //  3. no usable id: the latest instruction if it is a direct post not answered yet; else the one open
  //     request (received, not answered with its id yet). Two or more open requests: nothing is guessed,
  //     the reply stays in the PM thread (origin null, reason ambiguous_request).
  private pmReply(pm: SessionRecord, args: Record<string, unknown>): string {
    const a = parse(TOOL_ARGS.reply, args)
    if (!a.text.trim()) throw new CommandError('bad_args', 'text is required')
    const c = this.pmCtx(pm.key)
    const answered = c.answered!
    let origin: 'request' | 'user_direct' | null = null
    let request_id: string | null = null
    let in_reply_to: string | null = a.in_reply_to ?? null
    let reason: string | null = null
    if (a.in_reply_to && c.directs.includes(a.in_reply_to)) {
      origin = 'user_direct'
    } else if (a.request_id && c.requests.includes(a.request_id)) {
      origin = 'request'
      request_id = a.request_id
    } else if (a.request_id || a.in_reply_to) {
      reason = 'unknown_id'
      log('worker', 'PM reply names an id it never received; kept in the PM thread only', { session: pm.key })
    } else if (c.last?.message_id && !answered.includes(c.last.message_id)) {
      origin = 'user_direct'
      in_reply_to = c.last.message_id
    } else {
      const open = c.requests.filter(r => !answered.includes(r))
      if (open.length === 1) {
        origin = 'request'
        request_id = open[0]!
      } else if (open.length > 1) {
        reason = 'ambiguous_request'
        log('worker', 'PM reply without request_id while several requests are open; kept in the PM thread only', { session: pm.key, open: open.length })
      }
    }
    const done = origin === 'request' ? request_id : origin === 'user_direct' ? in_reply_to : null
    if (done && !answered.includes(done)) {
      c.answered = [...answered, done].slice(-KEEP_IDS * 2)
      this.saveCtx()
    }
    this.d.emit({
      kind: 'session_report',
      session: pm.key,
      project: pm.project,
      role: 'pm',
      pm_session: null,
      text: a.text,
      request_id,
      in_reply_to,
      origin,
      ...(reason ? { reason } : {}),
    })
    if (origin === 'request') return `sent (request ${request_id})`
    if (origin === 'user_direct') return 'sent to the person (direct thread)'
    if (reason === 'ambiguous_request')
      return 'recorded in your thread only: several requests are open, so say which one with request_id (reply again with request_id to send it)'
    return 'recorded in your thread'
  }

  // task reply: to its PM as task_report (queued / PM resumed when needed) + a thread record (02 §4.1)
  private taskReply(s: SessionRecord, args: Record<string, unknown>): string {
    const text = typeof args.text === 'string' ? args.text : ''
    if (!text.trim()) throw new CommandError('bad_args', 'text is required')
    if (!s.pm_session) {
      // Phase 2 orphan task: as before
      this.d.emit({ kind: 'session_report', session: s.key, project: s.project, role: s.role, pm_session: null, text, chat_id: s.last_chat_id })
      return 'sent to the secretary'
    }
    const tc = this.ctx.tasks[s.key] ?? { request_id: null, message_id: null }
    this.d.emit({
      kind: 'session_report',
      session: s.key,
      project: s.project,
      role: 'task',
      pm_session: s.pm_session,
      text,
      request_id: tc.request_id,
      in_reply_to: tc.message_id,
      origin: 'task_report',
    })
    const pm = this.m.find(s.pm_session)
    if (!pm || pm.role !== 'pm' || pm.project !== s.project) return 'recorded; your PM session is gone'
    const d = this.delivery({
      origin: 'task_report',
      target: pm.key,
      kind: 'task_report',
      content: text,
      meta: { kind: 'task_report', project: s.project, session: s.key, task_session: s.key, pm_session: pm.key, request_id: tc.request_id },
      lease: true, // the PM may act on the report (review fixes): it takes the lease after the task released it
      resume: true,
      expires_at: null,
      request_id: tc.request_id,
      message_id: null,
      operation_id: rid('op', 8),
    })
    this.q.enqueue(d)
    this.d.emit({ kind: 'task_event', project: s.project, pm_session: pm.key, task_session: s.key, action: 'reported', text, request_id: tc.request_id })
    return 'sent to your PM'
  }
}
