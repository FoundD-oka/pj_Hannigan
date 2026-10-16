// Persistent delivery queue for instructions to pm / task sessions (02 §3.4, §3.6, §16-19).
// Everything that must survive a daemon restart goes through here: pm_send, task_send, task_report,
// direct posts and PM notices. A delivery is written to the bridge only when
//   - it has not expired (re-checked right before the write),
//   - its target is running (stopped PMs / direct-post targets are resumed),
//   - the target holds (or can take) the workspace write lease when the delivery needs it,
//   - the target's bridge is ready.
// `delivered` means written to the channel, not processed by Claude (03 §3).
import type { DeliverKind, ResourceWaitReason } from '../shared/protocol.ts'
import { CommandError } from '../shared/protocol.ts'
import { TERMINAL_STATES, type SessionManager, type SessionRecord } from '../shared/session-manager.ts'
import { log, nowIso, rid } from '../shared/util.ts'
import { KeyedJournal } from './journal.ts'
import type { LeaseManager } from './lease.ts'

// session_send: the Phase 2 low-level path, kept for tasks without a PM (it takes the lease like the others)
export type DeliveryOrigin = 'pm_send' | 'direct' | 'direct_notice' | 'task_send' | 'task_report' | 'session_send'
export type DeliveryStatus = 'pending' | 'resource_wait' | 'sending' | 'delivered' | 'expired' | 'delivery_unknown' | 'failed'

export type Delivery = {
  key: string // 'dl-…'
  origin: DeliveryOrigin
  target: string // session key
  kind: DeliverKind
  content: string
  meta: Record<string, string>
  lease: boolean // needs the workspace write lease of the target
  resume: boolean // a stopped target may be resumed for it
  expires_at: string | null
  request_id: string | null
  message_id: string | null
  operation_id: string | null
  pair: string | null // direct post <-> its PM notice
  chat_id?: string | null // session_send: the conversation the orphan task reports to (last_chat_id)
  status: DeliveryStatus
  reason: string | null
  wait_reason?: ResourceWaitReason | null
  created_at: string
  updated_at: string
}

export const OPEN: DeliveryStatus[] = ['pending', 'resource_wait']
const DONE_KEEP_MS = 24 * 3600 * 1000

export type DispatcherOptions = {
  file: string
  manager: SessionManager
  leases: LeaseManager
  // status changes (including the synchronous ones inside a command)
  onStatus: (d: Delivery, prev: DeliveryStatus) => void
  // a lease-needing delivery is about to take the lease: descendants of the target at grant time
  baseline: (target: SessionRecord) => number[]
  // last chance to refresh content / meta right before the write (e.g. the notice's target_delivery)
  prepare?: (d: Delivery) => void
  now?: () => number
}

export class Dispatcher {
  private j: KeyedJournal<Delivery>
  private pumping = false
  private again = false
  private now: () => number

  constructor(private o: DispatcherOptions) {
    this.now = o.now ?? Date.now
    this.j = new KeyedJournal<Delivery>(o.file, d => OPEN.includes(d.status) || d.status === 'sending' || this.now() - Date.parse(d.updated_at) < DONE_KEEP_MS)
  }

  static newKey(): string {
    return rid('dl', 8)
  }

  // daemon start: a delivery caught between "sending" and "delivered" is unknown and never re-sent (02 §16)
  restore(): void {
    for (const d of this.j.values()) if (d.status === 'sending') this.set(d, 'delivery_unknown', 'daemon_restarted_while_sending')
  }

  get(key: string): Delivery | undefined {
    return this.j.get(key)
  }

  open(): Delivery[] {
    return this.j.values().filter(d => OPEN.includes(d.status))
  }

  // accepted together in one journal write (a direct post and its PM notice, 02 §3.6), then pumped
  enqueue(...ds: Delivery[]): void {
    this.j.put(...ds)
    this.pump()
  }

  pump(): void {
    if (this.pumping) {
      this.again = true
      return
    }
    this.pumping = true
    try {
      do {
        this.again = false
        this.pumpOnce()
      } while (this.again)
    } finally {
      this.pumping = false
    }
  }

  private pumpOnce(): void {
    const blockedTargets = new Set<string>() // keep FIFO per target
    const blockedResources = new Set<string>() // keep FIFO per workspace among lease waiters
    for (const d of this.open()) {
      if (blockedTargets.has(d.target)) continue
      if (d.expires_at && Date.parse(d.expires_at) <= this.now()) {
        this.set(d, 'expired', 'deadline_expired')
        continue
      }
      const s = this.o.manager.find(d.target)
      if (!s) {
        this.set(d, 'failed', 'not_found')
        continue
      }
      if (TERMINAL_STATES.includes(s.state)) {
        blockedTargets.add(d.target)
        if (d.resume) {
          try {
            this.o.manager.resume(s.key)
            log('worker', 'resumed a stopped session for a queued delivery', { session: s.key, delivery: d.key })
          } catch (e) {
            // busy (max_sessions) etc.: stays queued and retried on the next pump
            if (!(e instanceof CommandError)) throw e
          }
        }
        continue
      }
      if (s.state === 'stopping') {
        blockedTargets.add(d.target)
        continue
      }
      let resource: string | null = null
      if (d.lease) {
        const l = this.o.leases.ensure(s.cwd)
        resource = l.resource_id
        const c = this.o.leases.check(resource, s.key)
        if (c === 'busy' || c === 'unknown' || (c === 'free' && blockedResources.has(resource))) {
          blockedTargets.add(d.target)
          blockedResources.add(resource)
          if (d.status !== 'resource_wait' || d.wait_reason !== (c === 'unknown' ? 'resource_unknown' : 'workspace_busy')) {
            d.wait_reason = c === 'unknown' ? 'resource_unknown' : 'workspace_busy'
            this.set(d, 'resource_wait', d.wait_reason)
          }
          continue
        }
      }
      if (!this.o.manager.isBridgeReady(s.key)) {
        blockedTargets.add(d.target)
        if (resource) blockedResources.add(resource)
        continue
      }
      if (resource && !this.o.leases.acquire(resource, s.key, d.operation_id ?? d.request_id ?? d.message_id ?? d.key, this.o.baseline(s))) {
        blockedTargets.add(d.target)
        continue
      }
      this.o.prepare?.(d)
      this.set(d, 'sending', null)
      try {
        this.o.manager.send(s.key, d.content, d.meta, d.chat_id ?? null)
        this.set(d, 'delivered', null)
      } catch (e) {
        this.set(d, 'delivery_unknown', String((e as Error).message ?? e))
      }
    }
  }

  private set(d: Delivery, status: DeliveryStatus, reason: string | null): void {
    const prev = d.status
    d.status = status
    d.reason = reason
    d.updated_at = nowIso()
    this.j.put(d)
    if (prev !== status || status === 'resource_wait') this.o.onStatus(d, prev)
  }
}
