// Thread hierarchy and history paging (Q4/B).
import { expect, test } from 'bun:test'
import type { SessionInfo } from '../../shared/protocol.ts'
import type { SeqEvent } from '../../shared/util.ts'
import { buildThreads, coverageOf, threadHistory } from '../../hub/threads.ts'

const s = (key: string, role: SessionInfo['role'], pm: string | null, project = 'p1', state: SessionInfo['state'] = 'ready'): SessionInfo => ({
  key,
  project,
  name: key,
  role,
  pm_session: pm,
  state,
  created_at: '2026-10-16T00:00:00Z',
  updated_at: '2026-10-16T00:00:00Z',
  conversation_id: key,
})

test('hierarchy: worker -> project -> PM -> tasks; Phase 2 tasks without a PM are listed separately', () => {
  const t = buildThreads([
    {
      id: 'w1',
      display_name: 'W1',
      connected: true,
      projects: [
        { id: 'p1', description: 'one', pm_enabled: true },
        { id: 'p2', description: 'two', pm_enabled: false },
      ],
      sessions: [s('pm1', 'pm', null), s('t1', 'task', 'pm1'), s('t2', 'task', 'pm1'), s('old', 'task', null), s('x', 'task', null, 'p2')],
    },
  ])
  expect(t[0]!.worker).toBe('w1')
  const p1 = t[0]!.projects.find(p => p.id === 'p1')!
  expect(p1.pm!.session).toBe('pm1')
  expect(p1.tasks.map(x => x.session)).toEqual(['t1', 't2'])
  expect(p1.other_sessions.map(x => x.session)).toEqual(['old'])
  const p2 = t[0]!.projects.find(p => p.id === 'p2')!
  expect(p2.pm).toBeNull()
  expect(p2.pm_enabled).toBe(false)
  expect(p2.other_sessions.map(x => x.session)).toEqual(['x'])
})

test('history: only the session, paged newest-last with before; coverage from thread_entry source', () => {
  const evs: SeqEvent[] = []
  let seq = 0
  const add = (kind: string, d: Record<string, unknown>) => evs.push({ seq: ++seq, ts: '', kind, ...d })
  add('user_direct', { worker: 'w1', session: 'pm1', msg_id: 'm1', text: 'hi' })
  add('worker_report', { worker: 'w1', session: 'pm1', text: 'r1' })
  add('worker_report', { worker: 'w1', session: 't1', text: 'other thread' })
  add('worker_report', { worker: 'w2', session: 'pm1', text: 'other worker' })
  add('approval_open', { worker: 'w1', session: 'pm1', approval_id: 'ap-1' })
  add('approval_closed', { approval_id: 'ap-1' })
  add('approval_closed', { approval_id: 'ap-other' })
  add('task_event', { worker: 'w1', pm_session: 'pm1', task_session: 't1', action: 'created' })
  add('user_message', { conv_id: 'conv-a', text: 'secretary chat is never in a thread' })
  add('thread_entry', { worker: 'w1', session: 'pm1', entry_id: 'e1', source: 'bridge' })
  const all = threadHistory(evs, 'w1', 'pm1', { limit: 100 })
  expect(all.items.map(e => e.seq)).toEqual([1, 2, 5, 6, 8, 10])
  expect(all.has_more).toBe(false)
  const p1 = threadHistory(evs, 'w1', 'pm1', { limit: 2 })
  expect(p1.items.map(e => e.seq)).toEqual([8, 10])
  expect(p1.next_before).toBe(8)
  const p2 = threadHistory(evs, 'w1', 'pm1', { limit: 2, before: p1.next_before })
  expect(p2.items.map(e => e.seq)).toEqual([5, 6])
  const p3 = threadHistory(evs, 'w1', 'pm1', { limit: 2, before: p2.next_before })
  expect(p3.items.map(e => e.seq)).toEqual([1, 2])
  expect(p3.has_more).toBe(false)
  expect(p3.next_before).toBeNull()
  expect(threadHistory(evs, 'w1', 'pm1', { limit: 10, after: 5 }).items.map(e => e.seq)).toEqual([6, 8, 10])
  expect(coverageOf(evs, 'w1', 'pm1')).toBe('hannigan_only')
  add('thread_entry', { worker: 'w1', session: 'pm1', entry_id: 'e2', source: 'transcript' })
  expect(coverageOf(evs, 'w1', 'pm1')).toBe('transcript')
  expect(coverageOf(evs, 'w1', 't1')).toBe('hannigan_only')
  // the worker's transcript adapter states its own verdict; later ordinary entries do not override it
  add('thread_entry', { worker: 'w1', session: 'pm1', entry_id: 'c1', source: 'transcript', entry_kind: 'coverage', text: 'partial' })
  add('thread_entry', { worker: 'w1', session: 'pm1', entry_id: 'e3', source: 'transcript', entry_kind: 'assistant_message', text: 'hi' })
  expect(coverageOf(evs, 'w1', 'pm1')).toBe('partial')
  add('thread_entry', { worker: 'w1', session: 't1', entry_id: 'c2', source: 'transcript', entry_kind: 'coverage', text: 'unavailable' })
  expect(coverageOf(evs, 'w1', 't1')).toBe('unavailable')
})
