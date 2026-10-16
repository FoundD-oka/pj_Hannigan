// Persistent received ledger (02 §5, §16): the business ids of hub instructions (pm_send request_id,
// thread_direct_send session+message_id) -> the result given the first time. A repeated instruction,
// even under a new WSS command id or after a daemon restart, is answered from here and never delivered twice.
import { createHash } from 'crypto'
import { CommandError } from '../shared/protocol.ts'
import { KeyedJournal } from './journal.ts'

export type ReceivedEntry = {
  key: string // 'pm_send:<request_id>' | 'direct:<session>:<message_id>'
  hash: string // sha256 of the payload; the same key with another payload is refused
  result: Record<string, unknown>
  deliveries: string[] // delivery-queue keys created for this instruction
  at: string
}

const KEEP_MS = 14 * 24 * 3600 * 1000

export const payloadHash = (...parts: (string | null | undefined)[]) =>
  createHash('sha256')
    .update(parts.map(p => p ?? '').join('\u0000'))
    .digest('hex')

export class ReceivedLedger {
  private j: KeyedJournal<ReceivedEntry>

  constructor(file: string, now: () => number = Date.now) {
    this.j = new KeyedJournal<ReceivedEntry>(file, r => now() - Date.parse(r.at) < KEEP_MS)
  }

  static pmKey(request_id: string): string {
    return `pm_send:${request_id}`
  }
  static directKey(session: string, message_id: string): string {
    return `direct:${session}:${message_id}`
  }

  // previous entry for a repeated instruction; throws when the same id comes with a different payload
  lookup(key: string, hash: string): ReceivedEntry | undefined {
    const e = this.j.get(key)
    if (e && e.hash !== hash) throw new CommandError('bad_args', `${key.split(':')[0]} id reused with a different payload; refused`)
    return e
  }

  record(e: Omit<ReceivedEntry, 'at'>): ReceivedEntry {
    const full = { ...e, at: new Date().toISOString() }
    this.j.put(full)
    return full
  }

  get size(): number {
    return this.j.size
  }
}
