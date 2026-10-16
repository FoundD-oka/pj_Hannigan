import { expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CommandError } from '../../shared/protocol.ts'
import { ReceivedLedger, payloadHash } from '../../worker/received.ts'

const file = () => join(mkdtempSync(join(tmpdir(), 'hn-rcv-')), 'received.jsonl')

test('a repeated instruction is answered from the ledger, also after a restart', () => {
  const f = file()
  const a = new ReceivedLedger(f)
  const k = ReceivedLedger.pmKey('rq-1')
  const h = payloadHash('pm_send', 'p1', 'do it')
  expect(a.lookup(k, h)).toBeUndefined()
  a.record({ key: k, hash: h, result: { pm_session: 'pm' }, deliveries: ['dl-1'] })
  const b = new ReceivedLedger(f)
  expect(b.lookup(k, h)!.deliveries).toEqual(['dl-1'])
  expect(b.lookup(k, h)!.result.pm_session).toBe('pm')
})

test('the same id with another payload is refused', () => {
  const a = new ReceivedLedger(file())
  const k = ReceivedLedger.directKey('s1', 'm-1')
  a.record({ key: k, hash: payloadHash('direct', 's1', 'hello'), result: {}, deliveries: ['dl-1', 'dl-2'] })
  expect(() => a.lookup(k, payloadHash('direct', 's1', 'other'))).toThrow(CommandError)
  // the same message id for another session is another key
  expect(a.lookup(ReceivedLedger.directKey('s2', 'm-1'), payloadHash('direct', 's2', 'other'))).toBeUndefined()
})

test('old entries are dropped at load; a torn last line is ignored', () => {
  const f = file()
  let now = Date.now()
  const a = new ReceivedLedger(f, () => now)
  a.record({ key: 'pm_send:old', hash: 'h', result: {}, deliveries: [] })
  appendFileSync(f, '{"key":"pm_send:torn"')
  now += 15 * 24 * 3600 * 1000
  const b = new ReceivedLedger(f, () => now)
  expect(b.size).toBe(0)
})
