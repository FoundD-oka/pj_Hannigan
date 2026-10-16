// Persistent outbox: events are written before sending and dropped only after the hub acks them.
// docs/design/03-hub-worker-protocol.md §2.2
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import type { WorkerEvent, WorkerEventMsg } from '../shared/protocol.ts'
import { log, nowIso, readJson, writeJsonAtomic } from '../shared/util.ts'

// On overflow these go first (oldest first): transcript lines can be re-read, the thread view tolerates gaps.
const DROP_FIRST: WorkerEvent['kind'][] = ['thread_entry']
// Never dropped while anything droppable remains: results, delivery outcomes and lease state the hub acts on.
const KEEP: WorkerEvent['kind'][] = ['session_report', 'delivery', 'direct_delivery_state', 'resource_lease_state']

// indexes (into items) to drop so that at most `max` remain: thread_entry oldest first, then other droppable
// kinds oldest first, and the protected kinds only when nothing else is left
export function overflowVictims(items: { event: { kind: string } }[], max: number): Set<number> {
  const out = new Set<number>()
  let need = items.length - max
  for (const tier of [(k: string) => DROP_FIRST.includes(k as never), (k: string) => !KEEP.includes(k as never), () => true]) {
    for (let i = 0; i < items.length && need > 0; i++) {
      if (out.has(i) || !tier(items[i]!.event.kind)) continue
      out.add(i)
      need--
    }
  }
  return out
}

export class Outbox {
  private items: WorkerEventMsg[] = []
  private nextSeq = 1
  private metaFile: string

  constructor(
    private file: string,
    private maxEvents: number,
  ) {
    this.metaFile = file + '.meta.json'
    const meta = readJson<{ next_seq: number }>(this.metaFile, { next_seq: 1 })
    this.nextSeq = meta.next_seq
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const m = JSON.parse(line) as WorkerEventMsg
          this.items.push(m)
          this.nextSeq = Math.max(this.nextSeq, m.seq + 1)
        } catch {}
      }
    }
  }

  get next(): number {
    return this.nextSeq
  }

  push(event: WorkerEvent): WorkerEventMsg {
    const m: WorkerEventMsg = { t: 'event', seq: this.nextSeq++, ts: nowIso(), event }
    this.items.push(m)
    appendFileSync(this.file, JSON.stringify(m) + '\n', { mode: 0o600 })
    writeJsonAtomic(this.metaFile, { next_seq: this.nextSeq })
    if (this.items.length > this.maxEvents) {
      // the hub sees a gap and the inventory event resynchronises session state
      const drop = overflowVictims(this.items, this.maxEvents)
      const kinds: Record<string, number> = {}
      for (const i of drop) kinds[this.items[i]!.event.kind] = (kinds[this.items[i]!.event.kind] ?? 0) + 1
      log('worker', 'outbox full; events dropped', { max: this.maxEvents, kinds })
      this.items = this.items.filter((_, i) => !drop.has(i))
      this.rewrite()
    }
    return m
  }

  ack(seq: number): void {
    const before = this.items.length
    this.items = this.items.filter(m => m.seq > seq)
    if (this.items.length !== before) this.rewrite()
  }

  after(seq: number): WorkerEventMsg[] {
    return this.items.filter(m => m.seq > seq)
  }

  get size(): number {
    return this.items.length
  }

  // tmp + rename: a crash mid-write never leaves a truncated outbox
  private rewrite(): void {
    const tmp = `${this.file}.tmp-${process.pid}`
    writeFileSync(tmp, this.items.map(m => JSON.stringify(m)).join('\n') + (this.items.length ? '\n' : ''), { mode: 0o600 })
    renameSync(tmp, this.file)
  }
}
