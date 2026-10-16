// Shared work-item ledger (Q6/B). docs/design/03-hub-worker-protocol.md §4.6, 01-config-schema.md §14.4.
// Append-only JSONL (hub/work-items.jsonl); the latest line per work_item_id wins.
// Only structured fields are kept: never conversation text, tool logs or raw instructions.
import { appendFileSync, existsSync, readFileSync } from 'fs'
import { dirname } from 'path'
import type { WorkItem, WorkItemStatus } from '../shared/protocol.ts'
import { ensureDir } from '../shared/util.ts'

const ID = /^[A-Za-z0-9_-]{1,64}$/
const STATUSES: WorkItemStatus[] = ['open', 'in_progress', 'blocked', 'done']
const TITLE_MAX = 200
const SUMMARY_MAX = 1000

export type LedgerCreate = {
  project: string
  work_item_id: string
  title: string
  status: WorkItemStatus
  summary?: string | null
  request_id?: string | null
}
export type LedgerUpdate = {
  project: string
  work_item_id: string
  title?: string
  status?: WorkItemStatus
  summary?: string | null
  assignee?: string | null
  request_id?: string | null
}
export type LedgerResult = { ok: true; item: WorkItem; action: 'created' | 'updated' } | { ok: false; reason: string }

const clip = (s: unknown, n: number) => (typeof s === 'string' ? s.slice(0, n) : '')

export class Ledger {
  private items = new Map<string, WorkItem>()
  constructor(
    private file: string,
    private now: () => number = Date.now,
  ) {}

  restore(): void {
    this.items.clear()
    if (!existsSync(this.file)) return
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const w = JSON.parse(line) as WorkItem
        if (w && typeof w.work_item_id === 'string') this.items.set(key(w.worker, w.work_item_id), w)
      } catch {}
    }
  }

  private write(w: WorkItem): void {
    ensureDir(dirname(this.file))
    appendFileSync(this.file, JSON.stringify(w) + '\n', { mode: 0o600 })
    this.items.set(key(w.worker, w.work_item_id), w)
  }

  get(worker: string, work_item_id: string): WorkItem | undefined {
    return this.items.get(key(worker, work_item_id))
  }

  // a duplicate create (same worker + work_item_id) is ignored (03 §4.3 "重複登録を防止")
  created(worker: string, e: LedgerCreate, context_id: string | null = null): LedgerResult {
    if (!ID.test(e.work_item_id ?? '') || !ID.test(e.project ?? '')) return { ok: false, reason: 'bad_id' }
    if (!STATUSES.includes(e.status)) return { ok: false, reason: 'bad_status' }
    if (this.get(worker, e.work_item_id)) return { ok: false, reason: 'duplicate' }
    const at = new Date(this.now()).toISOString()
    const w: WorkItem = {
      work_item_id: e.work_item_id,
      worker,
      project: e.project,
      title: clip(e.title, TITLE_MAX),
      status: e.status,
      summary: clip(e.summary, SUMMARY_MAX),
      assignee: null,
      request_id: e.request_id ?? null,
      context_id,
      created_at: at,
      updated_at: at,
    }
    this.write(w)
    return { ok: true, item: w, action: 'created' }
  }

  // updates are accepted only for an existing item of the same worker and project
  updated(worker: string, e: LedgerUpdate): LedgerResult {
    const cur = this.get(worker, e.work_item_id ?? '')
    if (!cur) return { ok: false, reason: 'unknown_work_item' }
    if (cur.project !== e.project) return { ok: false, reason: 'project_mismatch' }
    if (e.status !== undefined && !STATUSES.includes(e.status)) return { ok: false, reason: 'bad_status' }
    const w: WorkItem = {
      ...cur,
      ...(e.title !== undefined ? { title: clip(e.title, TITLE_MAX) } : {}),
      ...(e.status !== undefined ? { status: e.status } : {}),
      ...(e.summary !== undefined ? { summary: clip(e.summary, SUMMARY_MAX) } : {}),
      ...(e.assignee !== undefined ? { assignee: e.assignee === null ? null : clip(e.assignee, 64) } : {}),
      ...(e.request_id ? { request_id: e.request_id } : {}),
      updated_at: new Date(this.now()).toISOString(),
    }
    this.write(w)
    return { ok: true, item: w, action: 'updated' }
  }

  query(f: { worker?: string; project?: string } = {}): WorkItem[] {
    return [...this.items.values()]
      .filter(w => (!f.worker || w.worker === f.worker) && (!f.project || w.project === f.project))
      .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
  }
}

const key = (worker: string, id: string) => `${worker}\u0000${id}`
