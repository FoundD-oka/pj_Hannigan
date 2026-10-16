// Message shapes. See docs/design/03-hub-worker-protocol.md and 02-worker-daemon.md §4-5.
// PROTO 2: roles (secretary / pm / task), request_id routing, offline delivery states and resource events.
// A peer with a different proto is refused at hello (03 §2.1).
export const PROTO = 2
export const VERSION = '0.1.0'

export type ToolDef = { name: string; description: string; inputSchema: Record<string, unknown> }

// secretary: hub-side per-conversation session; pm: project PM on a worker; task: worker session (child of a PM)
export type SessionRole = 'secretary' | 'pm' | 'task'
export const SESSION_ROLES: SessionRole[] = ['secretary', 'pm', 'task']

// ---- daemon/hub <-> bridge (§3)
export type BridgeHello = { t: 'hello'; token: string; session_key: string; claude_session_id: string | null; pid: number }
// role is informational for the bridge; authorization always uses the daemon's own session_key -> role record
export type BridgeSetup = { t: 'setup'; server_name: string; instructions: string; tools: ToolDef[]; role?: SessionRole }
export type BridgeDeliver = { t: 'deliver'; id: string; content: string; meta: Record<string, string> }
export type BridgeVerdict = { t: 'verdict'; request_id: string; behavior: 'allow' | 'deny' }
export type BridgeToolCall = { t: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
export type BridgeToolResult = { t: 'tool_result'; id: string; ok: boolean; text: string }
export type BridgePermissionRequest = {
  t: 'permission_request'
  request_id: string
  tool_name: string
  description: string
  input_preview: string
}
export type BridgeDelivered = { t: 'delivered'; id: string }

export type ToBridge = BridgeSetup | BridgeDeliver | BridgeVerdict | BridgeToolResult | { t: 'bye'; reason: string }
export type FromBridge = BridgeHello | BridgeToolCall | BridgePermissionRequest | BridgeDelivered | { t: 'ready' }

// values of deliver.meta.kind (03 §3, §5)
export type DeliverKind =
  | 'user' // person -> secretary
  | 'worker_report' // PM report -> secretary (with request_id)
  | 'worker_event' // session ended / worker disconnected -> secretary
  | 'task' // instruction to a worker session (session_send, pm_send, task_send)
  | 'task_report' // task reply -> its PM
  | 'user_direct' // WebChat direct post to a PM or task
  | 'user_direct_notice' // notice to the PM that its task got a direct post (not a new request)

// PM-only local tools served by the daemon (02 §4.1); reply is shared with tasks
export const PM_TOOLS = [
  'reply',
  'task_list',
  'task_create',
  'task_resume',
  'task_send',
  'task_interrupt',
  'task_stop',
  'work_item_create',
  'work_item_update',
] as const
export type PmToolName = (typeof PM_TOOLS)[number]

// ---- delivery and resource states
// result/event status of a pm_send / thread_direct_send as seen by the hub (03 §2.3, §2.3.1, §16)
export type DeliveryStatus =
  | 'accepted' // hub accepted the request (online path, before the worker answered)
  | 'queued' // worker holds it until the bridge connects (Phase 2 meaning of session_send)
  | 'delivered' // written to the channel; NOT processed by Claude
  | 'expired' // expires_at passed before it reached the channel
  | 'delivery_unknown' // could not tell whether it reached the bridge; never re-sent automatically
  | 'worker_queued' // worker persisted it and waits (max_sessions, PM not ready)
  | 'resource_wait' // worker persisted it and waits for a resource (cu_busy / workspace_busy)

// per-target state of a thread_direct_send (02 §4 table, 03 §4.1)
export type DirectDelivery = 'queued' | 'delivered' | 'not_applicable' | 'resource_wait' | 'expired' | 'delivery_unknown'

export type ResourceWaitReason = 'cu_busy' | 'workspace_busy' | 'resource_unknown'

// write lease of a workspace (03 §18-19)
export type LeaseState = 'held' | 'release_pending' | 'released' | 'resource_unknown'
export type RecoveryStatus = 'checking' | 'verified' | 'manual_review_required'

// hub offline queue states (03 §4.3 offline_request_state)
export type OfflineRequestState =
  | 'pending_offline'
  | 'dispatching'
  | 'worker_queued'
  | 'resource_wait'
  | 'delivered'
  | 'expired'
  | 'cancelled'
  | 'delivery_unknown'
  | 'failed'

export type WorkItemStatus = 'open' | 'in_progress' | 'blocked' | 'done'

// ---- worker <-> hub (§2)
export type WorkerEvent =
  | {
      kind: 'session_state'
      session: string
      project: string
      role: SessionRole
      pm_session?: string | null
      state: SessionState
      detail?: string
    }
  | {
      kind: 'session_report'
      session: string
      project: string
      role: SessionRole
      pm_session?: string | null
      text: string
      request_id?: string | null // set on a PM report answering a hub-issued request
      in_reply_to?: string | null // message_id of a direct post being answered
      origin?: 'request' | 'user_direct' | 'task_report' | null
      chat_id?: string | null // Phase 2 compatibility; never used for routing PM reports
      // why a PM reply has no origin: ambiguous_request (no id, several requests open), unknown_id
      reason?: string | null
    }
  | {
      kind: 'work_item_created'
      project: string
      pm_session: string
      work_item_id: string
      title: string
      status: WorkItemStatus
      summary?: string | null
      request_id?: string | null
    }
  | {
      kind: 'work_item_updated'
      project: string
      pm_session: string
      work_item_id: string
      title?: string
      status?: WorkItemStatus
      summary?: string | null
      assignee?: string | null
      request_id?: string | null
    }
  | {
      // 02 §5 thread_entry; the doc's `kind` field is `entry_kind` here because `kind` is the union tag
      kind: 'thread_entry'
      session: string
      project: string
      role: SessionRole
      pm_session?: string | null
      entry_id: string
      entry_kind: 'user_direct' | 'assistant_message' | 'tool_summary' | 'report' | string
      source: string
      text?: string | null
      message_id?: string | null
      ts: string
    }
  | {
      kind: 'direct_delivery_state'
      session: string
      project: string
      message_id: string
      target_delivery: DirectDelivery
      pm_session?: string | null
      pm_notice_delivery: DirectDelivery
      reason?: string | null
    }
  | {
      // a direct post to a task was also announced to its PM (pairs with direct_delivery_state)
      kind: 'user_direct_notice'
      session: string // the task
      pm_session: string
      project: string
      message_id: string
      status: DirectDelivery // delivery of the notice to the PM
    }
  | {
      // delivery progress of a hub request after the command result (worker_queued -> delivered, expired, ...)
      kind: 'delivery'
      request_id?: string | null // pm_send
      message_id?: string | null // thread_direct_send
      operation_id?: string | null
      session?: string | null
      project?: string | null
      status: DeliveryStatus
      reason?: ResourceWaitReason | string | null
    }
  | {
      kind: 'resource_wait'
      session: string
      project?: string | null
      resource_id: string // opaque id, never a local path
      reason: ResourceWaitReason // 03 calls this the wait kind
      operation_id?: string | null
      request_id?: string | null
      message_id?: string | null
    }
  | {
      kind: 'resource_lease_state'
      resource_id: string
      session?: string | null // owner
      operation_id?: string | null
      lease_epoch: number // grows with every new ownership
      state: LeaseState
      reason?: string | null
      verified_at?: string | null
      incident_id?: string | null
      recovery_status?: RecoveryStatus | null
      last_checked_at?: string | null
    }
  | {
      // PM <-> task delegation inside a worker, for thread display
      kind: 'task_event'
      project: string
      pm_session: string
      task_session: string
      action: 'created' | 'sent' | 'reported'
      text?: string | null
      request_id?: string | null
    }
  | {
      kind: 'permission_request'
      session: string
      project: string
      request_id: string
      tool_name: string
      description: string
      input_preview: string
    }
  | { kind: 'permission_closed'; session: string; request_id: string; reason: string }
  | {
      kind: 'terminal_prompt'
      session: string
      project: string
      prompt_id: string
      prompt_kind: string
      title: string
      body: string
      options: string[]
      cursor: number
    }
  | { kind: 'terminal_prompt_closed'; session: string; prompt_id: string; reason: string }
  | { kind: 'inventory'; projects: ProjectInfo[]; sessions: SessionInfo[] }

export type WorkerEventKind = WorkerEvent['kind']

export type SessionState =
  | 'starting'
  | 'awaiting_terminal'
  | 'ready'
  | 'working'
  | 'awaiting_approval'
  | 'stopping'
  | 'stopped'
  | 'exited'
  | 'failed'

export type ProjectInfo = {
  id: string
  description: string
  pm_enabled: boolean
  execution_policy?: 'delegate_only' | 'hybrid' | 'direct_first'
}
export type SessionInfo = {
  key: string
  project: string
  name: string
  role: SessionRole
  pm_session: string | null // task -> its PM's key; null for pm / secretary / orphan Phase 2 tasks
  context_id?: string | null // secretary -> the conversation context it serves
  state: SessionState
  created_at: string
  updated_at: string
  conversation_id: string
}

export type WorkerHello = {
  t: 'hello'
  proto: number
  worker_id: string
  key: string
  version: string
  next_seq: number
}
export type HubWelcome = { t: 'welcome'; proto: number; hub_version: string; last_seq: number }
export type WorkerEventMsg = { t: 'event'; seq: number; ts: string; event: WorkerEvent }
export type HubAck = { t: 'ack'; seq: number }
export type HubCommand = { t: 'command'; id: string; name: CommandName; args: Record<string, unknown> }
export type WorkerResult =
  | { t: 'result'; id: string; ok: true; data: unknown }
  | { t: 'result'; id: string; ok: false; error: { code: ErrorCode; message: string } }

export type CommandName =
  | 'list'
  | 'pm_ensure'
  | 'pm_send'
  | 'thread_direct_send'
  | 'session_create'
  | 'session_resume'
  | 'session_send'
  | 'session_interrupt'
  | 'session_stop'
  | 'approval_answer'
  | 'terminal_answer'

export const COMMANDS: CommandName[] = [
  'list',
  'pm_ensure',
  'pm_send',
  'thread_direct_send',
  'session_create',
  'session_resume',
  'session_send',
  'session_interrupt',
  'session_stop',
  'approval_answer',
  'terminal_answer',
]

// only these may be held in the hub's offline queue (Q12/C)
export const OFFLINE_QUEUEABLE: CommandName[] = ['pm_send', 'thread_direct_send']

// ---- command arguments / results (02 §4)
export type PmEnsureArgs = { project: string }
export type PmEnsureResult = { session: SessionInfo }

export type PmSendArgs = {
  project: string
  text: string
  request_id: string // hub-issued, required; the PM's report carries it back
  expires_at?: string | null // ISO UTC; the worker refuses with deadline_expired once past
  message_id?: string | null
  operation_id?: string | null // hub offline-queue id when the request was held
  work_item_id?: string | null
  context_id?: string | null // opaque hub id; 03 §4.6 says the worker never needs it, hubs may omit it
  chat_id?: string | null // Phase 2 compatibility only
}
export type PmSendResult = {
  pm_session: string
  status: 'delivered' | 'worker_queued' | 'resource_wait'
  operation_id?: string | null
  reason?: ResourceWaitReason | null
}

export type ThreadDirectSendArgs = {
  session: string
  text: string
  message_id: string
  expires_at?: string | null
  target_role?: 'pm' | 'task' // hint from the hub; the worker re-checks against its own records
  operation_id?: string | null
}
export type ThreadDirectSendResult = {
  target_delivery: DirectDelivery
  pm_notice_delivery: DirectDelivery // not_applicable when the target is a PM
  pm_session?: string | null
}

export type ErrorCode =
  | 'bad_args'
  | 'unknown_command'
  | 'not_found'
  | 'busy' // max_sessions reached
  | 'invalid_state'
  | 'stale'
  | 'worker_offline' // hub: worker not connected and the request cannot be held
  | 'timeout' // hub: no result in time
  | 'deadline_expired' // expires_at passed before delivery (03 §2.3)
  | 'expired' // alias kept for callers that name the state; prefer deadline_expired for errors
  | 'delivery_unknown' // bridge delivery outcome unknown; not retried automatically
  | 'queue_full' // a persistent queue cannot accept more
  | 'pm_disabled' // projects[].pm.enabled=false
  | 'unauthorized' // WebChat caller may not read / post
  | 'orphan_task' // direct post to a task without a valid PM
  | 'resource_busy' // CU or workspace in use and the request could not be persisted
  | 'workspace_busy' // the workspace write lease is held by another session
  | 'resource_unknown' // lease / CU owner unknown; fail closed
  | 'forbidden' // generic refusal (role / origin)
  | 'forbidden_scope' // PM touching another project's or worker's session
  | 'forbidden_origin' // request origin cannot be attributed
  | 'internal'

export const ERROR_CODES: ErrorCode[] = [
  'bad_args',
  'unknown_command',
  'not_found',
  'busy',
  'invalid_state',
  'stale',
  'worker_offline',
  'timeout',
  'deadline_expired',
  'expired',
  'delivery_unknown',
  'queue_full',
  'pm_disabled',
  'unauthorized',
  'orphan_task',
  'resource_busy',
  'workspace_busy',
  'resource_unknown',
  'forbidden',
  'forbidden_scope',
  'forbidden_origin',
  'internal',
]

export class CommandError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
  }
}

// ---- hub-side records shared by hub modules and tests
// one line of hub/offline-requests.jsonl (latest line per operation_id wins), 01 §20, 03 §2.3.1
export type OfflineRequest = {
  operation_id: string // hub-issued, stable across retries; FIFO tie-breaker after accepted_at
  kind: 'pm_send' | 'thread_direct_send'
  request_id: string | null // pm_send
  message_id: string | null // thread_direct_send (dedup key with worker + session)
  worker: string
  project: string | null
  session: string | null // thread_direct_send target
  target_role?: 'pm' | 'task' | null
  text: string
  context_id: string | null // originating secretary conversation (pm_send) or null
  origin_route_id?: string | null
  work_item_id?: string | null
  accepted_at: string // ISO UTC at the hub
  expires_at: string // accepted_at + ttl_minutes; never extended
  state: OfflineRequestState
  reason?: string | null
  updated_at: string
}

// shared work-item ledger entry (hub/work-items.jsonl, 01 §14.4): structured fields only, no conversation text
export type WorkItem = {
  work_item_id: string
  worker: string
  project: string
  title: string
  status: WorkItemStatus
  summary: string
  assignee?: string | null
  request_id?: string | null // source request when created by project_pm_send
  context_id?: string | null
  created_at: string
  updated_at: string
}

export function parseJson<T>(raw: string | Buffer): T | null {
  try {
    return JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')) as T
  } catch {
    return null
  }
}

// meta keys must be identifiers; Claude Code silently drops others
export function cleanMeta(meta: Record<string, string | null | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(meta)) if (/^[A-Za-z0-9_]+$/.test(k) && v != null) out[k] = String(v)
  return out
}
