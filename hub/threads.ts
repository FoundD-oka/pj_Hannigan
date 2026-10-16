// WebChat thread view (Q4/B): hierarchy worker -> project -> PM -> tasks and per-session history.
// docs/design/03-hub-worker-protocol.md §4, §4.1, §4.3; 02-worker-daemon.md §3.6-3.7.
// Pure functions over the inventory and the hub event log so they can be tested without a hub.
import type { ProjectInfo, SessionInfo } from '../shared/protocol.ts'
import type { SeqEvent } from '../shared/util.ts'

export type WorkerView = {
  id: string
  display_name: string
  connected: boolean
  projects: ProjectInfo[]
  sessions: SessionInfo[]
}

// hannigan_only: no transcript observed (yet); transcript / partial / unavailable: the worker's transcript
// adapter's own verdict (02 §3.7 available / partial / unavailable), carried by a thread_entry of entry_kind 'coverage'
export type Coverage = 'hannigan_only' | 'transcript' | 'partial' | 'unavailable'
const COVERAGE_VALUES: Coverage[] = ['transcript', 'partial', 'unavailable']

// a later ordinary transcript entry does not override the adapter's verdict (partial stays partial)
export function nextCoverage(prev: Coverage | undefined, e: SeqEvent): Coverage {
  if (e.entry_kind === 'coverage' && COVERAGE_VALUES.includes(e.text as Coverage)) return e.text as Coverage
  if (prev && prev !== 'hannigan_only') return prev
  return e.source === 'transcript' ? 'transcript' : 'hannigan_only'
}

export type ThreadSession = {
  session: string
  name: string
  role: SessionInfo['role']
  state: SessionInfo['state']
  pm_session: string | null
  updated_at: string
}

export type ThreadProject = {
  id: string
  description: string
  pm_enabled: boolean
  pm: ThreadSession | null
  tasks: ThreadSession[] // children of the PM
  other_sessions: ThreadSession[] // Phase 2 tasks without a PM, or tasks whose PM is unknown
}

export type ThreadWorker = { worker: string; display_name: string; connected: boolean; projects: ThreadProject[] }

const view = (s: SessionInfo): ThreadSession => ({
  session: s.key,
  name: s.name,
  role: s.role,
  state: s.state,
  pm_session: s.pm_session ?? null,
  updated_at: s.updated_at,
})

const ENDED = ['stopped', 'exited', 'failed']

export function buildThreads(workers: WorkerView[]): ThreadWorker[] {
  return workers.map(w => {
    const ids = new Set([...w.projects.map(p => p.id), ...w.sessions.map(s => s.project)])
    const projects: ThreadProject[] = []
    for (const id of ids) {
      const info = w.projects.find(p => p.id === id)
      const mine = w.sessions.filter(s => s.project === id)
      // one PM per project; prefer a running one, then the most recently updated
      const pms = mine
        .filter(s => s.role === 'pm')
        .sort((a, b) => Number(ENDED.includes(a.state)) - Number(ENDED.includes(b.state)) || b.updated_at.localeCompare(a.updated_at))
      const pm = pms[0] ?? null
      const pmKeys = new Set(pms.map(p => p.key))
      const tasks = mine.filter(s => s.role === 'task' && s.pm_session && pmKeys.has(s.pm_session))
      const others = mine.filter(s => s.role !== 'pm' && !tasks.includes(s))
      projects.push({
        id,
        description: info?.description ?? '',
        pm_enabled: info?.pm_enabled ?? false,
        pm: pm ? view(pm) : null,
        tasks: tasks.map(view),
        other_sessions: [...others.map(view), ...pms.slice(1).map(view)],
      })
    }
    return { worker: w.id, display_name: w.display_name, connected: w.connected, projects }
  })
}

// event kinds that belong to a session thread (keyed by worker + session)
export const THREAD_KINDS = new Set([
  'user_direct',
  'direct_delivery_state',
  'user_direct_notice',
  'worker_report',
  'report_unrouted',
  'thread_entry',
  'session_state',
  'approval_open',
  'delivery',
  'offline_request_state',
  'request_expired',
  'resource_wait',
  'session_action',
])

export function inThread(e: SeqEvent, worker: string, session: string): boolean {
  if (e.worker !== worker) return false
  if (e.kind === 'task_event') return e.pm_session === session || e.task_session === session
  if (e.kind === 'user_direct_notice') return e.session === session || e.pm_session === session
  if (e.kind === 'request_state') return e.pm_session === session
  return THREAD_KINDS.has(e.kind) && e.session === session
}

// what the thread history is able to show: only what Hannigan saw, or also the native transcript
export function coverageOf(events: SeqEvent[], worker: string, session: string): Coverage {
  let c: Coverage | undefined
  for (const e of events) if (e.kind === 'thread_entry' && e.worker === worker && e.session === session) c = nextCoverage(c, e)
  return c ?? 'hannigan_only'
}

export type HistoryPage = { items: SeqEvent[]; has_more: boolean; next_before: number | null }

// newest-last page. `before`: only events with seq < before (older pages); `after`: seq > after (catch up)
export function threadHistory(
  events: SeqEvent[],
  worker: string,
  session: string,
  o: { before?: number | null; after?: number | null; limit: number },
): HistoryPage {
  const approvalIds = new Set<string>()
  const all: SeqEvent[] = []
  for (const e of events) {
    let hit = inThread(e, worker, session)
    if (e.kind === 'approval_open' && hit) approvalIds.add(String(e.approval_id))
    if (e.kind === 'approval_closed' && approvalIds.has(String(e.approval_id))) hit = true
    if (hit) all.push(e)
  }
  let sel = all
  if (o.before) sel = sel.filter(e => e.seq < o.before!)
  if (o.after) {
    sel = sel.filter(e => e.seq > o.after!)
    const items = sel.slice(0, o.limit)
    return { items, has_more: sel.length > items.length, next_before: null }
  }
  const items = sel.slice(Math.max(0, sel.length - o.limit))
  const has_more = sel.length > items.length
  return { items, has_more, next_before: has_more && items.length ? items[0]!.seq : null }
}
