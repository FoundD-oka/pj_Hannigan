// Hub offline queue (Q12/C, Q13/C, Q14/B). docs/design/03-hub-worker-protocol.md §2.3.1, 01-config-schema.md §20-21.
// Append-only JSONL: one line per state change, the latest line per operation_id wins.
// expires_at is computed once at enqueue (accepted_at + ttl) and never extended, also not by restore.
import { appendFileSync, existsSync, readFileSync } from 'fs'
import { dirname } from 'path'
import { CommandError, type OfflineRequest, type OfflineRequestState } from '../shared/protocol.ts'
import { ensureDir, rid } from '../shared/util.ts'

// states in which the request is still held by the hub (not yet handed to the worker)
export const HELD_STATES: OfflineRequestState[] = ['pending_offline', 'dispatching']
// no further transition is accepted from these
export const FINAL_STATES: OfflineRequestState[] = ['delivered', 'expired', 'cancelled', 'failed']

export type EnqueueInput = Omit<OfflineRequest, 'operation_id' | 'accepted_at' | 'expires_at' | 'state' | 'updated_at' | 'reason'> & {
  operation_id?: string
}

export type QueueOptions = {
  file: string
  ttlMinutes: number
  maxPendingPerWorker: number
  now?: () => number
}

export class OfflineQueue {
  private items = new Map<string, OfflineRequest>()
  private now: () => number

  constructor(private o: QueueOptions) {
    this.now = o.now ?? Date.now
  }

  // settings screen: new limits apply to requests accepted from now on; expires_at of held ones never changes
  setLimits(l: { ttlMinutes: number; maxPendingPerWorker: number }): void {
    this.o.ttlMinutes = l.ttlMinutes
    this.o.maxPendingPerWorker = l.maxPendingPerWorker
  }

  // Reload from disk. Items left in `dispatching` (the hub stopped while sending) cannot be told apart
  // from sent ones, so they become delivery_unknown and are never re-sent automatically. Returns those.
  restore(): OfflineRequest[] {
    this.items.clear()
    if (existsSync(this.o.file)) {
      for (const line of readFileSync(this.o.file, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const r = JSON.parse(line) as OfflineRequest
          if (r && typeof r.operation_id === 'string') this.items.set(r.operation_id, r)
        } catch {}
      }
    }
    const changed: OfflineRequest[] = []
    for (const r of this.items.values()) {
      if (r.state === 'dispatching') {
        const x = this.markState(r.operation_id, 'delivery_unknown', 'hub_restarted_while_dispatching')
        if (x) changed.push(x)
      }
    }
    return changed
  }

  private write(r: OfflineRequest): void {
    ensureDir(dirname(this.o.file))
    appendFileSync(this.o.file, JSON.stringify(r) + '\n', { mode: 0o600 })
    this.items.set(r.operation_id, r)
  }

  get(operation_id: string): OfflineRequest | undefined {
    return this.items.get(operation_id)
  }

  list(): OfflineRequest[] {
    return [...this.items.values()].sort(fifo)
  }

  findByRequest(request_id: string): OfflineRequest | undefined {
    for (const r of this.items.values()) if (r.request_id === request_id) return r
    return undefined
  }

  findByMessage(worker: string, session: string, message_id: string): OfflineRequest | undefined {
    for (const r of this.items.values()) if (r.worker === worker && r.session === session && r.message_id === message_id) return r
    return undefined
  }

  // Accept a request for an offline worker. A retry of the same request_id / (worker, session, message_id)
  // returns the existing record unchanged (same expires_at).
  enqueue(input: EnqueueInput): OfflineRequest {
    const dup =
      input.kind === 'pm_send' && input.request_id
        ? this.findByRequest(input.request_id)
        : input.session && input.message_id
          ? this.findByMessage(input.worker, input.session, input.message_id)
          : undefined
    if (dup) return dup
    const held = [...this.items.values()].filter(r => r.worker === input.worker && HELD_STATES.includes(r.state)).length
    if (held >= this.o.maxPendingPerWorker)
      throw new CommandError('queue_full', `offline queue for "${input.worker}" is full (${this.o.maxPendingPerWorker})`)
    const at = this.now()
    const iso = new Date(at).toISOString()
    const r: OfflineRequest = {
      ...input,
      operation_id: input.operation_id ?? rid('op'),
      accepted_at: iso,
      expires_at: new Date(at + this.o.ttlMinutes * 60000).toISOString(),
      state: 'pending_offline',
      reason: null,
      updated_at: iso,
    }
    this.write(r)
    return r
  }

  // pending requests of a worker in delivery order: accepted_at, then operation_id (Q14/B)
  pendingFor(worker: string): OfflineRequest[] {
    return [...this.items.values()].filter(r => r.worker === worker && r.state === 'pending_offline').sort(fifo)
  }

  // returns the updated record, or null when unknown / already final / unchanged
  markState(operation_id: string, state: OfflineRequestState, reason?: string | null): OfflineRequest | null {
    const r = this.items.get(operation_id)
    if (!r) return null
    if (FINAL_STATES.includes(r.state)) return null
    if (r.state === state && (reason ?? null) === (r.reason ?? null)) return null
    const next: OfflineRequest = { ...r, state, reason: reason ?? null, updated_at: new Date(this.now()).toISOString() }
    this.write(next)
    return next
  }

  isExpired(r: OfflineRequest, now = this.now()): boolean {
    return now >= Date.parse(r.expires_at)
  }

  // mark every request still waiting in the hub (pending_offline) whose deadline passed; returns them (each
  // expires once). A `dispatching` item is being handed to the worker right now: the sweeper leaves it to the
  // dispatcher (its result decides), and a hub restart turns a stuck one into delivery_unknown (restore).
  expireDue(now = this.now()): OfflineRequest[] {
    const out: OfflineRequest[] = []
    for (const r of [...this.items.values()]) {
      if (r.state !== 'pending_offline' || !this.isExpired(r, now)) continue
      const x = this.markState(r.operation_id, 'expired', 'ttl_elapsed')
      if (x) out.push(x)
    }
    return out
  }
}

function fifo(a: OfflineRequest, b: OfflineRequest): number {
  return a.accepted_at < b.accepted_at ? -1 : a.accepted_at > b.accepted_at ? 1 : a.operation_id < b.operation_id ? -1 : a.operation_id > b.operation_id ? 1 : 0
}
