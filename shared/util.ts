import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { createHash, randomBytes } from 'crypto'

export const nowIso = () => new Date().toISOString()

export function rid(prefix: string, bytes = 8): string {
  return `${prefix}-${randomBytes(bytes).toString('hex')}`
}

export function log(component: string, msg: string, extra?: Record<string, unknown>): void {
  // structured stderr log; never pass secrets in extra
  process.stderr.write(JSON.stringify({ ts: nowIso(), c: component, msg, ...(extra ?? {}) }) + '\n')
}

export function ensureDir(d: string): string {
  if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 })
  return d
}

export function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

export function writeJsonAtomic(file: string, data: unknown): void {
  ensureDir(dirname(file))
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// Absolute local paths in text that leaves the Mac become `<path:xxxxxx>` (a stable short hash, so the same
// path reads the same everywhere without revealing user or folder names). Callers replace the project
// folder and the home folder with readable placeholders first.
const ABS_PATH = /(?<![\w.~<>-])\/(?:Users|Volumes|private|tmp|var|opt|etc|home|root|Library|Applications|System)(?:\/[^\s"'`<>|;,()[\]{}]*)?/g
export function maskAbsPaths(s: string): string {
  return s.replace(ABS_PATH, p => `<path:${createHash('sha256').update(p).digest('hex').slice(0, 6)}>`)
}

export class Backoff {
  private n = 0
  constructor(private min = 1000, private max = 30000) {}
  next(): number {
    const d = Math.min(this.max, this.min * 2 ** this.n)
    this.n++
    return d
  }
  reset(): void {
    this.n = 0
  }
}

// Append-only JSONL log with a monotonically increasing seq. `keyOf` names events that must be found again
// by key (e.g. a WebChat msg_id for duplicate detection): `hasKey` answers from a Set instead of a scan.
// The file and the in-memory list grow without bound (no rotation yet).
export type SeqEvent = { seq: number; ts: string; kind: string; [k: string]: unknown }
export class EventLog {
  readonly events: SeqEvent[] = []
  seq = 0
  private subs = new Set<(e: SeqEvent) => void>()
  private keys = new Set<string>()
  constructor(
    private file: string,
    private keyOf: (e: SeqEvent) => string | null = () => null,
  ) {
    ensureDir(dirname(file))
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const e = JSON.parse(line) as SeqEvent
          this.events.push(e)
          this.index(e)
          this.seq = Math.max(this.seq, e.seq)
        } catch {}
      }
    }
  }
  private index(e: SeqEvent): void {
    const k = this.keyOf(e)
    if (k != null) this.keys.add(k)
  }
  hasKey(key: string): boolean {
    return this.keys.has(key)
  }
  record(kind: string, data: Record<string, unknown> = {}): SeqEvent {
    const e: SeqEvent = { seq: ++this.seq, ts: nowIso(), kind, ...data }
    this.events.push(e)
    this.index(e)
    appendFileSync(this.file, JSON.stringify(e) + '\n', { mode: 0o600 })
    for (const s of this.subs) {
      try {
        s(e)
      } catch {}
    }
    return e
  }
  since(seq: number, limit: number): SeqEvent[] {
    const out = this.events.filter(e => e.seq > seq)
    return out.length > limit ? out.slice(out.length - limit) : out
  }
  subscribe(fn: (e: SeqEvent) => void): () => void {
    this.subs.add(fn)
    return () => this.subs.delete(fn)
  }
}
