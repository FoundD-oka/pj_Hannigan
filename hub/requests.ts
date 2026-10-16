// project_pm_send requests (Q6/B): request_id -> originating context. docs/design/03-hub-worker-protocol.md §4.6.
// A PM report is delivered only to the context recorded here; nothing is guessed from chat_id or recency.
// Also remembers which context last drove a Phase 2 session (session_create / send / resume) so that
// session ended / worker disconnected notices reach that conversation only.
import { readJson, writeJsonAtomic } from '../shared/util.ts'

export type RequestState =
  | 'accepted'
  | 'pending_offline'
  | 'dispatching'
  | 'delivered'
  | 'worker_queued'
  | 'resource_wait'
  | 'delivery_unknown'
  | 'expired'
  | 'cancelled'
  | 'failed'

export type PmRequest = {
  request_id: string
  context_id: string
  worker: string
  project: string
  operation_id: string
  pm_session: string | null
  state: RequestState
  reason: string | null
  expires_at: string | null
  created_at: string
  updated_at: string
  reports: number // PM reports routed back so far
}

// requests whose PM may still report back and that should hear about the worker going away
export const OPEN_REQUEST_STATES: RequestState[] = ['accepted', 'dispatching', 'delivered', 'worker_queued', 'resource_wait', 'delivery_unknown']

export class RequestStore {
  private map: Record<string, PmRequest>
  private owners: Record<string, string> // `${worker}/${session}` -> context_id
  constructor(
    private file: string,
    private ownersFile: string,
  ) {
    this.map = readJson<Record<string, PmRequest>>(file, {})
    this.owners = readJson<Record<string, string>>(ownersFile, {})
  }

  private save(): void {
    writeJsonAtomic(this.file, this.map)
  }

  get(request_id: string): PmRequest | undefined {
    return Object.hasOwn(this.map, request_id) ? this.map[request_id] : undefined
  }

  all(): PmRequest[] {
    return Object.values(this.map)
  }

  add(r: Omit<PmRequest, 'created_at' | 'updated_at' | 'reports' | 'reason' | 'pm_session'> & { pm_session?: string | null }): PmRequest {
    const now = new Date().toISOString()
    const x: PmRequest = { pm_session: null, reason: null, ...r, created_at: now, updated_at: now, reports: 0 }
    this.map[x.request_id] = x
    this.save()
    return x
  }

  update(request_id: string, patch: Partial<Pick<PmRequest, 'state' | 'reason' | 'pm_session' | 'expires_at' | 'reports'>>): PmRequest | undefined {
    const r = this.get(request_id)
    if (!r) return undefined
    Object.assign(r, patch, { updated_at: new Date().toISOString() })
    this.save()
    return r
  }

  // open requests on a worker (optionally for one PM session)
  open(worker: string, pm_session?: string): PmRequest[] {
    return this.all().filter(
      r => r.worker === worker && OPEN_REQUEST_STATES.includes(r.state) && r.reports === 0 && (!pm_session || r.pm_session === pm_session),
    )
  }

  setOwner(worker: string, session: string, context_id: string): void {
    this.owners[`${worker}/${session}`] = context_id
    writeJsonAtomic(this.ownersFile, this.owners)
  }

  ownerOf(worker: string, session: string): string | undefined {
    const k = `${worker}/${session}`
    return Object.hasOwn(this.owners, k) ? this.owners[k] : undefined
  }

  ownedOn(worker: string): { session: string; context_id: string }[] {
    const p = `${worker}/`
    return Object.entries(this.owners)
      .filter(([k]) => k.startsWith(p))
      .map(([k, context_id]) => ({ session: k.slice(p.length), context_id }))
  }
}
