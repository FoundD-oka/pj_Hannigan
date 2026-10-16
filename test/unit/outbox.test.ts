import { expect, test } from 'bun:test'
import { mkdtempSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Outbox } from '../../worker/outbox.ts'

const ev = (n: number) => ({ kind: 'session_report' as const, session: 's', project: 'p', role: 'task' as const, text: `r${n}` })

test('persists until acked and keeps numbering across restarts', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'hn-ob-')), 'outbox.jsonl')
  const a = new Outbox(f, 100)
  a.push(ev(1)); a.push(ev(2)); a.push(ev(3))
  a.ack(1)
  const b = new Outbox(f, 100)
  expect(b.after(0).map(m => m.seq)).toEqual([2, 3])
  expect(b.next).toBe(4)
  b.ack(3)
  const c = new Outbox(f, 100)
  expect(c.size).toBe(0)
  expect(c.next).toBe(4) // numbering continues after everything was acked
})

test('drops the oldest beyond the limit', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'hn-ob-')), 'outbox.jsonl')
  const a = new Outbox(f, 100)
  for (let i = 0; i < 105; i++) a.push(ev(i))
  expect(a.size).toBe(100)
  expect(a.after(0)[0]!.seq).toBe(6)
})

test('overflow drops thread_entry first, then other kinds; reports and delivery outcomes are kept', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'hn-ob-')), 'outbox.jsonl')
  const a = new Outbox(f, 6)
  const entry = (n: number) => ({ kind: 'thread_entry' as const, session: 's', project: 'p', role: 'task' as const, pm_session: null, entry_id: `e${n}`, entry_kind: 'assistant_message' as const, source: 'transcript' as const, text: `t${n}`, ts: 'x' })
  const state = (n: number) => ({ kind: 'session_state' as const, session: `s${n}`, project: 'p', role: 'task' as const, state: 'ready' as const })
  a.push(ev(1)) // report
  a.push(entry(1))
  a.push(state(1))
  a.push(entry(2))
  a.push({ kind: 'delivery', request_id: 'rq-1', status: 'delivered' } as any)
  a.push(entry(3))
  a.push(ev(2)) // 7 > 6: the oldest thread_entry goes
  expect(a.after(0).map(m => (m.event as any).entry_id ?? (m.event as any).text ?? m.event.kind)).toEqual(['r1', 'session_state', 'e2', 'delivery', 'e3', 'r2'])
  const kinds = () => a.after(0).map(m => (m.event as any).entry_id ?? (m.event as any).text ?? m.event.kind)
  a.push(ev(3))
  expect(kinds()).toEqual(['r1', 'session_state', 'delivery', 'e3', 'r2', 'r3'])
  a.push(ev(4))
  expect(kinds()).toEqual(['r1', 'session_state', 'delivery', 'r2', 'r3', 'r4'])
  // no thread entry left: the next droppable kind (session_state) goes, never the report or the delivery
  a.push(ev(5))
  expect(kinds()).toEqual(['r1', 'delivery', 'r2', 'r3', 'r4', 'r5'])
  // only protected kinds left: then the oldest of them goes
  a.push(ev(6))
  expect(kinds()).toEqual(['delivery', 'r2', 'r3', 'r4', 'r5', 'r6'])
  // the file on disk matches (rewritten atomically, no tmp left behind)
  const b = new Outbox(f, 6)
  expect(b.after(0).map(m => m.seq)).toEqual(a.after(0).map(m => m.seq))
  expect(readdirSync(join(f, '..')).some((n: string) => n.includes('.tmp-'))).toBe(false)
})
