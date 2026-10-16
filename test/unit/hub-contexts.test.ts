// Per-conversation secretary contexts (Q6/B): validated ids, persistence, idle / eviction selection.
import { expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ContextStore, evictionCandidate, idleContexts } from '../../hub/contexts.ts'

const dir = () => mkdtempSync(join(tmpdir(), 'hn-ctx-'))

test('context ids are validated before they become paths', () => {
  const d = dir()
  const s = new ContextStore(join(d, 'contexts.json'), join(d, 'contexts'))
  expect(s.dirFor('conv-a')).toBe(join(d, 'contexts', 'conv-a'))
  for (const bad of ['', '../x', 'a/b', '.', 'x'.repeat(65), 'a b']) {
    expect(() => s.dirFor(bad)).toThrow()
    expect(() => s.ensure(bad)).toThrow()
  }
  expect(s.get('__proto__')).toBeUndefined()
})

test('mapping persists: context -> session key, last_used_at', () => {
  const d = dir()
  const f = join(d, 'contexts.json')
  const a = new ContextStore(f, join(d, 'contexts'))
  a.ensure('conv-a', '2026-10-16T00:00:00.000Z')
  a.setSession('conv-a', 'key-a')
  a.touch('conv-a', '2026-10-16T01:00:00.000Z')
  const b = new ContextStore(f, join(d, 'contexts'))
  expect(b.get('conv-a')).toMatchObject({ context_id: 'conv-a', session_key: 'key-a', created_at: '2026-10-16T00:00:00.000Z', last_used_at: '2026-10-16T01:00:00.000Z' })
  expect(b.byKey('key-a')!.context_id).toBe('conv-a')
  expect(b.byKey('key-x')).toBeUndefined()
})

test('idle selection: only ready, unused for idle_minutes, nothing open', () => {
  const now = Date.parse('2026-10-16T01:00:00Z')
  const c = (id: string, key: string | null, last: string) => ({ context_id: id, source: 'webchat' as const, session_key: key, created_at: last, last_used_at: last })
  const contexts = [
    c('old-ready', 'k1', '2026-10-16T00:00:00Z'),
    c('old-working', 'k2', '2026-10-16T00:00:00Z'),
    c('fresh', 'k3', '2026-10-16T00:59:00Z'),
    c('old-approval', 'k4', '2026-10-16T00:00:00Z'),
    c('never-started', null, '2026-10-16T00:00:00Z'),
  ]
  const states: Record<string, string> = { k1: 'ready', k2: 'working', k3: 'ready', k4: 'ready' }
  const r = idleContexts({ contexts, stateOf: k => states[k], busy: (_c, k) => k === 'k4', now, idleMs: 30 * 60000 })
  expect(r.map(x => x.context_id)).toEqual(['old-ready'])
  const ev = evictionCandidate({ contexts, stateOf: k => states[k], busy: (_c, k) => k === 'k4', except: 'old-ready' })
  expect(ev!.context_id).toBe('fresh')
  expect(evictionCandidate({ contexts, stateOf: () => 'working', busy: () => false, except: 'x' })).toBeUndefined()
})
