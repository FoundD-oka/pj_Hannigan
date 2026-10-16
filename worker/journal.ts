// Append-only JSONL journal keyed by `key`: the latest line per key wins. Used for the received ledger
// and the delivery queue so that a restart restores exactly what was accepted (02 §5, §16).
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { ensureDir } from '../shared/util.ts'

export class KeyedJournal<T extends { key: string }> {
  private map = new Map<string, T>()
  private lines = 0

  constructor(
    private file: string,
    private keep: (r: T) => boolean = () => true, // false: dropped at load / compaction
  ) {
    ensureDir(dirname(file))
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const r = JSON.parse(line) as T & { _deleted?: boolean }
          if (r._deleted) this.map.delete(r.key)
          else this.map.set(r.key, r)
          this.lines++
        } catch {
          // a torn last line after a crash: ignored
        }
      }
    }
    for (const [k, r] of this.map) if (!this.keep(r)) this.map.delete(k)
    if (this.lines > this.map.size) this.compact()
  }

  get(key: string): T | undefined {
    return this.map.get(key)
  }

  values(): T[] {
    return [...this.map.values()]
  }

  get size(): number {
    return this.map.size
  }

  // several records in one write (a direct post and its PM notice are accepted together, 02 §3.6)
  put(...recs: T[]): void {
    if (!recs.length) return
    appendFileSync(this.file, recs.map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 })
    for (const r of recs) this.map.set(r.key, r)
    this.lines += recs.length
    if (this.lines > 2 * this.map.size + 200) this.compact()
  }

  compact(): void {
    for (const [k, r] of this.map) if (!this.keep(r)) this.map.delete(k)
    const tmp = `${this.file}.tmp-${process.pid}`
    const vals = [...this.map.values()]
    writeFileSync(tmp, vals.map(r => JSON.stringify(r)).join('\n') + (vals.length ? '\n' : ''), { mode: 0o600 })
    renameSync(tmp, this.file)
    this.lines = vals.length
  }
}
