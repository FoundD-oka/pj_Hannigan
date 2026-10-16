// Secretary tools and instructions (docs/design/03-hub-worker-protocol.md §5, §6).
// One secretary session runs per WebChat conversation (Q6/B); all of them share these tools and instructions.
// Worker roles come from hub.json; changing them requires the secretaries to reconnect.
import type { HubConfig } from '../shared/config.ts'
import type { ToolDef } from '../shared/protocol.ts'

const str = (description: string) => ({ type: 'string', description })

export const SECRETARY_TOOLS: ToolDef[] = [
  {
    name: 'reply',
    description:
      'Send a message to the person on WebChat. This is the only way they see anything you say. Only the conversation you serve can be answered: chat_id must be the chat_id of the <channel> messages you receive.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: str('chat_id from the <channel> tag you are answering (always your own conversation)'),
        text: str('Message text'),
        in_reply_to: str('message_id being answered, if any'),
      },
      required: ['chat_id', 'text'],
    },
  },
  {
    name: 'project_pm_send',
    description:
      'Normal way to get work done: send a request to the project PM (a Claude Code session that manages one project on a worker). The hub issues a request_id; the PM decides whether to do the work itself or delegate it, and its report comes back later as <channel kind="worker_report" request_id="..."> to this conversation only. The result status only says whether the request reached the PM (delivered / worker_queued / resource_wait / pending_offline); it never means the work is done.',
    inputSchema: {
      type: 'object',
      properties: {
        worker: str('worker id'),
        project: str('project id on that worker (must have the PM enabled)'),
        text: str('complete, self-contained request for the PM; it sees only what you send'),
        chat_id: str('chat_id of your conversation (optional; must be your own)'),
      },
      required: ['worker', 'project', 'text'],
    },
  },
  {
    name: 'project_status',
    description:
      'Read the shared work-item ledger (structured status of tasks the PMs registered: title, status, summary) and the PM session state of each project. No conversation text is returned.',
    inputSchema: {
      type: 'object',
      properties: { worker: str('worker id (optional)'), project: str('project id (optional)') },
    },
  },
  {
    name: 'workers_status',
    description:
      'List workers (Macs), whether they are connected, their roles, projects (pm_enabled) and Claude Code sessions with role (pm / task), parent PM and state.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'session_create',
    description:
      'Low-level (Phase 2 path): start a plain Claude Code session for a project on a worker, bypassing the project PM. Use project_pm_send instead unless the person explicitly asks for a separate session. Returns immediately with the session key.',
    inputSchema: {
      type: 'object',
      properties: {
        worker: str('worker id'),
        project: str('project id on that worker'),
        name: str('short label for the session'),
        chat_id: str('chat_id of your conversation'),
      },
      required: ['worker', 'project'],
    },
  },
  {
    name: 'session_resume',
    description: 'Low-level: resume a stopped/exited worker session. History is kept.',
    inputSchema: {
      type: 'object',
      properties: { worker: str('worker id'), session: str('session key'), chat_id: str('chat_id of your conversation') },
      required: ['worker', 'session'],
    },
  },
  {
    name: 'session_send',
    description:
      'Low-level: send an instruction directly to a worker session created with session_create (a task without a project PM). PM sessions and tasks of a PM refuse it (invalid_state): use project_pm_send. Sessions another conversation drives are refused (forbidden_origin). Its report comes back as <channel kind="worker_report">. Prefer project_pm_send for normal requests.',
    inputSchema: {
      type: 'object',
      properties: {
        worker: str('worker id'),
        session: str('session key'),
        text: str('instruction for the worker Claude'),
        chat_id: str('chat_id of your conversation; the report will carry it'),
      },
      required: ['worker', 'session', 'text'],
    },
  },
  {
    name: 'session_stop',
    description: 'Low-level: end a worker session (sends /exit). It can be resumed later.',
    inputSchema: { type: 'object', properties: { worker: str('worker id'), session: str('session key') }, required: ['worker', 'session'] },
  },
  {
    name: 'session_interrupt',
    description: 'Low-level: interrupt the running work of a session (sends Esc). Partial work may have happened; verify afterwards.',
    inputSchema: { type: 'object', properties: { worker: str('worker id'), session: str('session key') }, required: ['worker', 'session'] },
  },
]

export function secretaryInstructions(cfg: HubConfig): string {
  const workers = cfg.workers.length
    ? cfg.workers.map(w => `- ${w.id}${w.display_name ? ` (${w.display_name})` : ''}: ${w.role || 'no role description'}`).join('\n')
    : '- (none configured)'
  return [
    'You are the secretary of the Hannigan system for ONE WebChat conversation. The person talks to you only through WebChat; nobody reads this terminal.',
    'Other conversations have their own secretaries. You never see them and must not try to answer them.',
    'You do not do the work yourself. You hand requests to the project PM on a worker Mac and report the results back.',
    '',
    'Incoming events arrive as <channel source="hannigan" kind="...">:',
    '- kind="user": a message from the person. Answer with reply(chat_id, text, in_reply_to=message_id).',
    '- kind="worker_report": a report from a project PM (attributes worker, project, session, request_id, chat_id). It answers a request you sent with project_pm_send. Summarise what matters and reply to that chat_id.',
    '- kind="worker_event": a session ended, a worker disconnected, or a held request expired without being executed. Tell the person if it affects their work.',
    '',
    'Workers and their roles:',
    workers,
    '',
    'How to route work:',
    '1. Decide which worker and project fit from the roles and the conversation. If unclear, ask the person with reply. workers_status lists projects and whether their PM is enabled.',
    '2. Send the request with project_pm_send(worker, project, text). Write a complete, self-contained request: the PM sees only what you send. Tell the person briefly what you delegated and where.',
    '3. The result comes back later as a worker_report carrying the same request_id. Until then the work is not done: "delivered" only means the PM received the request. "pending_offline" means the worker Mac is offline and the request is held until expires_at; it has NOT run yet. If it expires you get a worker_event saying it was not executed.',
    '4. When the worker_report arrives, reply with the result. Never invent or guess results you have not received, and never claim work is finished because a request was delivered.',
    '5. project_status shows the shared ledger of work items (structured status only) when the person asks how things stand.',
    '6. session_create / session_send / session_resume / session_stop / session_interrupt are low-level tools that bypass the PM. Use them only when the person explicitly asks for that.',
    '',
    'Reply only to the conversation you were asked from: always use the chat_id of the <channel> messages you received. Replies to any other chat_id are refused.',
    'The person can also post directly to PM and task threads in WebChat; those posts and their answers stay in the thread and are not sent to you.',
    'Tool approvals and terminal dialogs of worker sessions are shown to the person directly in WebChat as approval cards. Do not ask them to approve in chat; just wait for the report.',
    'Reply in the language the person uses. Keep replies short.',
    cfg.secretary.extra_instructions,
  ]
    .filter(s => s !== undefined)
    .join('\n')
}
