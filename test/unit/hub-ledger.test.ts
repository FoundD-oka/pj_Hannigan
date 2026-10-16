// Shared work-item ledger (Q6/B): latest line wins, structured fields only, scope checks.
import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Ledger } from '../../hub/ledger.ts'

const file = () => join(mkdtempSync(join(tmpdir(), 'hn-ledger-')), 'work-items.jsonl')

test('create, update, restore: latest line per work_item_id wins', () => {
  const f = file()
  let t = Date.parse('2026-10-16T00:00:00Z')
  const a = new Ledger(f, () => t)
  const c = a.created('w1', { project: 'p1', work_item_id: 'wi-1', title: 'Fix login', status: 'open', summary: 'short', request_id: 'rq-1' }, 'conv-a')
  expect(c.ok).toBe(true)
  t += 1000
  const u = a.updated('w1', { project: 'p1', work_item_id: 'wi-1', status: 'in_progress', assignee: 'task-1' })
  expect(u.ok && u.item.status).toBe('in_progress')
  t += 1000
  a.updated('w1', { project: 'p1', work_item_id: 'wi-1', status: 'done', summary: 'merged' })
  expect(readFileSync(f, 'utf8').trim().split('\n').length).toBe(3)
  const b = new Ledger(f)
  b.restore()
  const items = b.query()
  expect(items.length).toBe(1)
  expect(items[0]).toMatchObject({ worker: 'w1', project: 'p1', title: 'Fix login', status: 'done', summary: 'merged', assignee: 'task-1', request_id: 'rq-1', context_id: 'conv-a' })
  expect(items[0]!.created_at).toBe('2026-10-16T00:00:00.000Z')
  expect(items[0]!.updated_at).toBe('2026-10-16T00:00:02.000Z')
})

test('duplicate create, unknown item, other project and bad status are refused', () => {
  const a = new Ledger(file())
  expect(a.created('w1', { project: 'p1', work_item_id: 'wi-1', title: 'A', status: 'open' }).ok).toBe(true)
  expect(a.created('w1', { project: 'p1', work_item_id: 'wi-1', title: 'B', status: 'open' })).toEqual({ ok: false, reason: 'duplicate' })
  expect(a.updated('w1', { project: 'p1', work_item_id: 'nope', status: 'done' })).toEqual({ ok: false, reason: 'unknown_work_item' })
  expect(a.updated('w1', { project: 'p2', work_item_id: 'wi-1', status: 'done' })).toEqual({ ok: false, reason: 'project_mismatch' })
  expect(a.updated('w2', { project: 'p1', work_item_id: 'wi-1', status: 'done' })).toEqual({ ok: false, reason: 'unknown_work_item' })
  expect(a.updated('w1', { project: 'p1', work_item_id: 'wi-1', status: 'weird' as never })).toEqual({ ok: false, reason: 'bad_status' })
  expect(a.created('w1', { project: 'p1', work_item_id: '../x', title: 'A', status: 'open' })).toEqual({ ok: false, reason: 'bad_id' })
  // same id on another worker is a different item
  expect(a.created('w2', { project: 'p1', work_item_id: 'wi-1', title: 'C', status: 'open' }).ok).toBe(true)
  expect(a.query({ worker: 'w1' }).map(i => i.title)).toEqual(['A'])
  expect(a.query({ project: 'p1' }).length).toBe(2)
})

test('long fields are clipped', () => {
  const a = new Ledger(file())
  const r = a.created('w1', { project: 'p1', work_item_id: 'wi-1', title: 'x'.repeat(500), status: 'open', summary: 'y'.repeat(5000) })
  expect(r.ok && r.item.title.length).toBe(200)
  expect(r.ok && r.item.summary.length).toBe(1000)
})
