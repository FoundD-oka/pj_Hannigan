// hub/pairing.ts: one-time codes with a 10 minute life, one per worker, failure limits, ws url derivation
import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CODE_TTL_MS, MAX_CODE_FAILURES, MAX_GLOBAL_FAILURES, PairingError, PairingStore, normalizeCode, workerUrlFor } from '../../hub/pairing.ts'

const file = () => join(mkdtempSync(join(tmpdir(), 'hn-pair-')), 'pairing.json')
const clock = (start = 1_000_000) => {
  let t = start
  return { now: () => t, tick: (ms: number) => (t += ms) }
}

test('a code is 8 chars from the unambiguous alphabet, lives 10 minutes and is consumed by one success', () => {
  const c = clock()
  const s = new PairingStore(file(), c.now)
  const e = s.start({ worker: 'office', display_name: ' 仕事 Mac ', role: '仕事' })
  expect(e.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/)
  expect(e.display_name).toBe('仕事 Mac')
  expect(Date.parse(e.expires_at) - Date.parse(e.created_at)).toBe(CODE_TTL_MS)
  expect(s.list()).toEqual([expect.objectContaining({ worker: 'office', failures: 0 })])
  expect((s.list()[0] as any).code).toBeUndefined()
  const ok = s.verify(e.code, 'office')
  expect(ok.ok).toBe(true)
  // second use: gone
  const again = s.verify(e.code, 'office')
  expect(again).toMatchObject({ ok: false, reason: 'unknown_code' })
  expect(s.list()).toEqual([])
})

test('the code is accepted with spaces, lower case and dashes', () => {
  const s = new PairingStore(file())
  const e = s.start({ worker: 'w' })
  expect(normalizeCode(' ab-cd ')).toBe('ABCD')
  const r = s.verify(e.code.toLowerCase().slice(0, 4) + '-' + e.code.slice(4) + ' ', 'w')
  expect(r.ok).toBe(true)
})

test('expired codes are refused and dropped', () => {
  const c = clock()
  const s = new PairingStore(file(), c.now)
  const e = s.start({ worker: 'w' })
  c.tick(CODE_TTL_MS - 1)
  expect(s.list().length).toBe(1)
  c.tick(2)
  expect(s.verify(e.code, 'w')).toMatchObject({ ok: false, reason: 'unknown_code' })
  expect(s.list()).toEqual([])
})

test('a wrong worker id counts against the code; 5 failures kill it', () => {
  const s = new PairingStore(file())
  const e = s.start({ worker: 'w' })
  for (let i = 1; i < MAX_CODE_FAILURES; i++) {
    const r = s.verify(e.code, 'other')
    expect(r).toMatchObject({ ok: false, reason: 'worker_mismatch' })
    expect(s.list()[0]!.failures).toBe(i)
  }
  expect(s.verify(e.code, 'other')).toMatchObject({ ok: false, reason: 'too_many_failures' })
  expect(s.list()).toEqual([])
  expect(s.verify(e.code, 'w')).toMatchObject({ ok: false, reason: 'unknown_code' })
})

test('unknown codes lock /pair after 20 failures until a new code is issued', () => {
  const s = new PairingStore(file())
  const e = s.start({ worker: 'w' })
  for (let i = 0; i < MAX_GLOBAL_FAILURES; i++) expect(s.verify('ZZZZZZZZ', 'w')).toMatchObject({ ok: false, reason: 'unknown_code' })
  expect(s.verify(e.code, 'w')).toMatchObject({ ok: false, reason: 'locked' })
  const e2 = s.start({ worker: 'w' })
  expect(s.verify(e2.code, 'w').ok).toBe(true)
})

test('one open code per worker: starting again replaces the old one; cancel removes it', () => {
  const s = new PairingStore(file())
  const a = s.start({ worker: 'w' })
  const b = s.start({ worker: 'w' })
  expect(s.list().length).toBe(1)
  expect(s.verify(a.code, 'w')).toMatchObject({ ok: false, reason: 'unknown_code' })
  expect(s.cancel('w')).toBe(true)
  expect(s.cancel('w')).toBe(false)
  expect(s.verify(b.code, 'w')).toMatchObject({ ok: false, reason: 'unknown_code' })
})

test('bad ids and bad args are refused; the file is cleared at start and written on change', () => {
  const f = file()
  writeFileSync(f, JSON.stringify([{ code: 'LEFTOVER', worker: 'x' }]))
  const s = new PairingStore(f)
  expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual([])
  expect(() => s.start({ worker: 'bad id!' })).toThrow(PairingError)
  expect(s.verify(123, 'w')).toMatchObject({ ok: false, reason: 'bad_args' })
  expect(s.verify('ABCDEFGH', 'bad id!')).toMatchObject({ ok: false, reason: 'bad_args' })
  s.start({ worker: 'w' })
  expect(JSON.parse(readFileSync(f, 'utf8')).length).toBe(1)
})

test('workerUrlFor turns the public https url into wss and local http into ws', () => {
  expect(workerUrlFor('https://hannigan.found-d.com')).toBe('wss://hannigan.found-d.com/ws/worker')
  expect(workerUrlFor('https://hannigan.found-d.com/some/path?x=1')).toBe('wss://hannigan.found-d.com/ws/worker')
  expect(workerUrlFor('http://127.0.0.1:8800')).toBe('ws://127.0.0.1:8800/ws/worker')
})
