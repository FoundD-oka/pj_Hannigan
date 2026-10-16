// Hub offline queue (Q12/C, Q13/C, Q14/B): TTL boundary, FIFO, restore, queue_full, dedup.
import { expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CommandError } from '../../shared/protocol.ts'
import { OfflineQueue, type EnqueueInput } from '../../hub/offline-queue.ts'

const T0 = Date.parse('2026-10-16T00:00:00.000Z')
const file = () => join(mkdtempSync(join(tmpdir(), 'hn-oq-')), 'offline-requests.jsonl')
const req = (n: number, extra: Partial<EnqueueInput> = {}): EnqueueInput => ({
  kind: 'pm_send',
  request_id: `rq-${n}`,
  message_id: null,
  worker: 'w1',
  project: 'p1',
  session: null,
  target_role: 'pm',
  text: `t${n}`,
  context_id: 'conv-a',
  ...extra,
})

function q(f: string, clock: { now: number }, max = 100) {
  return new OfflineQueue({ file: f, ttlMinutes: 1440, maxPendingPerWorker: max, now: () => clock.now })
}

test('expires_at = accepted_at + 24h; 23:59:59 is still deliverable, exactly 24h is expired', () => {
  const clock = { now: T0 }
  const a = q(file(), clock)
  const r = a.enqueue(req(1))
  expect(r.accepted_at).toBe('2026-10-16T00:00:00.000Z')
  expect(r.expires_at).toBe('2026-10-17T00:00:00.000Z')
  expect(r.state).toBe('pending_offline')
  expect(a.isExpired(r, T0 + 24 * 3600_000 - 1000)).toBe(false)
  expect(a.expireDue(T0 + 24 * 3600_000 - 1000)).toEqual([])
  expect(a.isExpired(r, T0 + 24 * 3600_000)).toBe(true)
  const ex = a.expireDue(T0 + 24 * 3600_000)
  expect(ex.map(x => x.operation_id)).toEqual([r.operation_id])
  expect(a.get(r.operation_id)!.state).toBe('expired')
  // expired once: a second sweep does not report it again, and it cannot be revived
  expect(a.expireDue(T0 + 48 * 3600_000)).toEqual([])
  expect(a.markState(r.operation_id, 'pending_offline')).toBeNull()
  expect(a.pendingFor('w1')).toEqual([])
})

test('FIFO by accepted_at, then operation_id; other workers are separate', () => {
  const clock = { now: T0 }
  const a = q(file(), clock)
  const r1 = a.enqueue(req(1, { operation_id: 'op-b' }))
  const r2 = a.enqueue(req(2, { operation_id: 'op-a' })) // same ms, smaller operation_id goes first
  clock.now += 1000
  const r3 = a.enqueue(req(3))
  const other = a.enqueue(req(4, { worker: 'w2' }))
  expect(a.pendingFor('w1').map(x => x.operation_id)).toEqual([r2.operation_id, r1.operation_id, r3.operation_id])
  expect(a.pendingFor('w2').map(x => x.operation_id)).toEqual([other.operation_id])
  a.markState(r2.operation_id, 'delivered')
  expect(a.pendingFor('w1').map(x => x.operation_id)).toEqual([r1.operation_id, r3.operation_id])
})

test('restore keeps expires_at and order; dispatching becomes delivery_unknown (never re-sent)', () => {
  const f = file()
  const clock = { now: T0 }
  const a = q(f, clock)
  const r1 = a.enqueue(req(1))
  clock.now += 5000
  const r2 = a.enqueue(req(2))
  a.markState(r1.operation_id, 'dispatching')
  clock.now = T0 + 10 * 3600_000 // the hub restarts 10h later
  const b = q(f, clock)
  const changed = b.restore()
  expect(changed.map(x => x.operation_id)).toEqual([r1.operation_id])
  expect(b.get(r1.operation_id)!.state).toBe('delivery_unknown')
  expect(b.get(r2.operation_id)!.expires_at).toBe(r2.expires_at)
  expect(b.get(r2.operation_id)!.accepted_at).toBe(r2.accepted_at)
  expect(b.pendingFor('w1').map(x => x.operation_id)).toEqual([r2.operation_id])
  // a retry of the same request_id does not extend the deadline
  const again = b.enqueue(req(2))
  expect(again.operation_id).toBe(r2.operation_id)
  expect(again.expires_at).toBe(r2.expires_at)
})

test('queue_full when a worker holds max_pending_per_worker; nothing old is dropped', () => {
  const clock = { now: T0 }
  const a = q(file(), clock, 2)
  a.enqueue(req(1))
  a.enqueue(req(2))
  let err: unknown
  try {
    a.enqueue(req(3))
  } catch (e) {
    err = e
  }
  expect(err).toBeInstanceOf(CommandError)
  expect((err as CommandError).code).toBe('queue_full')
  expect(a.pendingFor('w1').length).toBe(2)
  // another worker still has room
  expect(a.enqueue(req(4, { worker: 'w2' })).state).toBe('pending_offline')
  // items handed to the worker no longer count against the hub's limit
  a.markState(a.pendingFor('w1')[0]!.operation_id, 'worker_queued')
  expect(a.enqueue(req(5)).state).toBe('pending_offline')
})

test('direct posts dedupe by (worker, session, message_id)', () => {
  const clock = { now: T0 }
  const a = q(file(), clock)
  const d = { kind: 'thread_direct_send' as const, request_id: null, message_id: 'm1', session: 's1', target_role: 'task' as const, context_id: null }
  const x = a.enqueue(req(0, d))
  clock.now += 60000
  const y = a.enqueue(req(0, d))
  expect(y.operation_id).toBe(x.operation_id)
  expect(y.expires_at).toBe(x.expires_at)
  expect(a.findByMessage('w1', 's1', 'm1')!.operation_id).toBe(x.operation_id)
})

test('the sweeper expires only pending_offline: an item being dispatched is left to its result', () => {
  const clock = { now: T0 }
  const a = q(file(), clock)
  const r1 = a.enqueue(req(1))
  const r2 = a.enqueue(req(2))
  a.markState(r1.operation_id, 'dispatching')
  const late = T0 + 25 * 3600_000
  expect(a.expireDue(late).map(x => x.operation_id)).toEqual([r2.operation_id])
  expect(a.get(r1.operation_id)!.state).toBe('dispatching')
  // the worker's answer still lands on the dispatching item
  expect(a.markState(r1.operation_id, 'delivered')!.state).toBe('delivered')
})
