// Pairing codes (docs/design/04-vps-deployment.md WP1, 01 §6): the hub issues a short-lived one-time code from
// the settings screen; the new worker Mac presents it on POST /pair (the only route without the WebChat token)
// and receives its key. Pure logic with an injectable clock; hub.ts does the key / hub.json writes.
import { randomInt } from 'crypto'
import { existsSync } from 'fs'
import { ID_RE } from '../shared/config.ts'
import { safeEqual } from '../shared/secrets.ts'
import { readJson, writeJsonAtomic } from '../shared/util.ts'

export const CODE_TTL_MS = 10 * 60 * 1000 // 10 minutes
export const CODE_LENGTH = 8
export const MAX_CODE_FAILURES = 5 // wrong worker id for an existing code
export const MAX_GLOBAL_FAILURES = 20 // unknown codes within the window: then every /pair is refused until a code is issued again
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O, 1/I

export type PairingEntry = {
  code: string
  worker: string
  display_name: string | null
  role: string
  created_at: string
  expires_at: string
  failures: number
}

export type PairingVerify =
  | { ok: true; entry: PairingEntry }
  | { ok: false; reason: 'bad_args' | 'unknown_code' | 'expired' | 'worker_mismatch' | 'too_many_failures' | 'locked'; message: string }

export class PairingError extends Error {}

export function newCode(): string {
  let s = ''
  for (let i = 0; i < CODE_LENGTH; i++) s += ALPHABET[randomInt(ALPHABET.length)]
  return s
}

export const normalizeCode = (c: string) => c.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')

// Codes live in hub/pairing.json so the settings screen can show the open ones; the file is cleared at hub
// start (a restart ends every pairing in progress; the screen says so).
export class PairingStore {
  private entries: PairingEntry[] = []
  private globalFailures: { at: number }[] = []

  constructor(
    private file: string,
    private now: () => number = () => Date.now(),
  ) {
    if (existsSync(file)) writeJsonAtomic(file, []) // fail closed: nothing survives a restart
  }

  private save(): void {
    writeJsonAtomic(this.file, this.entries)
  }
  private prune(): void {
    const t = this.now()
    const before = this.entries.length
    this.entries = this.entries.filter(e => Date.parse(e.expires_at) > t && e.failures < MAX_CODE_FAILURES)
    this.globalFailures = this.globalFailures.filter(f => t - f.at < CODE_TTL_MS)
    if (this.entries.length !== before) this.save()
  }

  // one open code per worker id: starting again replaces the previous one
  start(o: { worker: string; display_name?: string | null; role?: string }): PairingEntry {
    if (!ID_RE.test(o.worker)) throw new PairingError('ワーカー ID は英数字と - _ で 1〜32 文字にしてください')
    this.prune()
    this.entries = this.entries.filter(e => e.worker !== o.worker)
    const t = this.now()
    const entry: PairingEntry = {
      code: newCode(),
      worker: o.worker,
      display_name: o.display_name?.trim() || null,
      role: (o.role ?? '').slice(0, 2000),
      created_at: new Date(t).toISOString(),
      expires_at: new Date(t + CODE_TTL_MS).toISOString(),
      failures: 0,
    }
    this.entries.push(entry)
    this.globalFailures = [] // a fresh code lifts a lock
    this.save()
    return entry
  }

  // the open codes, without the code itself (for the settings screen)
  list(): Omit<PairingEntry, 'code'>[] {
    this.prune()
    return this.entries.map(({ code: _c, ...rest }) => rest)
  }

  cancel(worker: string): boolean {
    const n = this.entries.length
    this.entries = this.entries.filter(e => e.worker !== worker)
    if (this.entries.length !== n) this.save()
    return this.entries.length !== n
  }

  // one attempt from POST /pair. A success consumes the code.
  verify(rawCode: unknown, rawWorker: unknown): PairingVerify {
    this.prune()
    if (typeof rawCode !== 'string' || typeof rawWorker !== 'string' || !ID_RE.test(rawWorker))
      return { ok: false, reason: 'bad_args', message: 'code（8 文字）と worker（ワーカー ID）が必要です' }
    if (this.globalFailures.length >= MAX_GLOBAL_FAILURES)
      return { ok: false, reason: 'locked', message: '失敗が続いたのでペアリングを止めています。設定画面でコードを発行し直してください' }
    const code = normalizeCode(rawCode)
    const t = this.now()
    // constant-time over every entry so the response time does not say which codes exist
    let hit: PairingEntry | null = null
    for (const e of this.entries) if (safeEqual(e.code, code)) hit = e
    if (!hit || code.length !== CODE_LENGTH) {
      this.globalFailures.push({ at: t })
      return { ok: false, reason: 'unknown_code', message: 'コードが違うか、期限が切れています' }
    }
    if (Date.parse(hit.expires_at) <= t) {
      this.entries = this.entries.filter(e => e !== hit)
      this.save()
      return { ok: false, reason: 'expired', message: 'コードの期限が切れています。設定画面で発行し直してください' }
    }
    if (hit.worker !== rawWorker) {
      hit.failures++
      const out: PairingVerify =
        hit.failures >= MAX_CODE_FAILURES
          ? { ok: false, reason: 'too_many_failures', message: 'ワーカー ID の間違いが続いたのでこのコードを無効にしました。発行し直してください' }
          : { ok: false, reason: 'worker_mismatch', message: `このコードはワーカー「${hit.worker}」用です` }
      this.prune()
      this.save()
      return out
    }
    this.entries = this.entries.filter(e => e !== hit)
    this.save()
    return { ok: true, entry: hit }
  }
}

// ws(s) URL a worker should use for a hub reachable at `base` (https://host -> wss://host/ws/worker)
export function workerUrlFor(base: string): string {
  const u = new URL(base)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  u.pathname = '/ws/worker'
  u.search = ''
  u.hash = ''
  return u.toString()
}

export function readPairingFile(file: string): PairingEntry[] {
  return readJson<PairingEntry[]>(file, [])
}
