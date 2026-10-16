// Bridge setups (instructions + tools) per role. 02 §3.5, §4.1; 00 §4.1.1; 01 §4.2.
import type { ExecutionPolicy, ProjectConfig } from '../shared/config.ts'
import type { ToolDef } from '../shared/protocol.ts'

const str = (description: string) => ({ type: 'string', description })
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required })

export const TASK_REPLY_TOOL: ToolDef = {
  name: 'reply',
  description:
    'Report back. Use it for the final result, for progress worth knowing, and for questions that block you. The terminal is not watched.',
  inputSchema: obj({ text: str('The report. Plain text, concise, in the language of the task.') }, ['text']),
}

export const PM_TOOL_DEFS: ToolDef[] = [
  {
    name: 'reply',
    description:
      'Report to the secretary / the person. For a request (<channel kind="task" request_id=…>) pass its request_id; for a direct post (<channel kind="user_direct" message_id=…>) pass in_reply_to=message_id instead. Several replies per request are fine (progress, questions, final result).',
    inputSchema: obj(
      {
        text: str('The report. Plain text, concise, in the language of the request.'),
        request_id: str('request_id of the request this answers (from the channel tag).'),
        in_reply_to: str('message_id of the direct post this answers.'),
      },
      ['text'],
    ),
  },
  {
    name: 'task_list',
    description: 'List the task sessions of this project that belong to you (key, name, state).',
    inputSchema: obj({}),
  },
  {
    name: 'task_create',
    description:
      'Start a new task session (a separate Claude Code session in the same project folder). Returns its session key. Then send it work with task_send.',
    inputSchema: obj({ name: str('Short display name for the task session.') }),
  },
  {
    name: 'task_resume',
    description: 'Resume one of your stopped task sessions (same conversation).',
    inputSchema: obj({ session: str('Task session key.') }, ['session']),
  },
  {
    name: 'task_send',
    description:
      'Send an instruction to one of your task sessions. Write a complete, self-contained instruction. Its report comes back to you as <channel kind="task_report" task_session=…>.',
    inputSchema: obj({ session: str('Task session key.'), text: str('The instruction.') }, ['session', 'text']),
  },
  {
    name: 'task_interrupt',
    description: 'Interrupt (Esc) one of your task sessions. It does not tell how far the running tool got.',
    inputSchema: obj({ session: str('Task session key.') }, ['session']),
  },
  {
    name: 'task_stop',
    description: 'Stop one of your task sessions (/exit). It can be resumed later.',
    inputSchema: obj({ session: str('Task session key.') }, ['session']),
  },
  {
    name: 'work_item_create',
    description:
      'Register a new tracked work item for this project in the shared ledger. Structured fields only; never paste conversation or logs.',
    inputSchema: obj(
      {
        title: str('Short title.'),
        status: { type: 'string', enum: ['open', 'in_progress', 'blocked', 'done'] },
        summary: str('One or two sentences.'),
        request_id: str('request_id of the request it belongs to, if any.'),
      },
      ['title'],
    ),
  },
  {
    name: 'work_item_update',
    description: 'Update a work item of this project (status, title, summary).',
    inputSchema: obj(
      {
        work_item_id: str('Id returned by work_item_create.'),
        status: { type: 'string', enum: ['open', 'in_progress', 'blocked', 'done'] },
        title: str('New title.'),
        summary: str('New summary.'),
        assignee: str('Task session key or a short name.'),
      },
      ['work_item_id'],
    ),
  },
]

const POLICY: Record<ExecutionPolicy, string> = {
  delegate_only:
    'Execution policy: delegate_only. You investigate, plan, instruct and review. Every change to files is done by a task session (task_create + task_send).',
  hybrid:
    'Execution policy: hybrid. Do small things yourself with your built-in tools: a short investigation, a small independent fix, a simple test. Delegate to a task session (task_create + task_send) long, multi-step or parallel work.',
  direct_first:
    'Execution policy: direct_first. Do what you can yourself with your built-in tools first; delegate to a task session when the work grows complex or should run in parallel.',
}

const LEASE_NOTE =
  'Only one session may write in this folder at a time (write lease). If a tool is blocked with "write lease not held", do not retry it: finish your turn (reply if needed). Hannigan delivers the next instruction when the folder is free.'

export function pmInstructions(workerId: string, p: ProjectConfig): string {
  return [
    `You are the project PM (project manager) Claude Code session of project "${p.id}" on worker "${workerId}" (${p.path}).`,
    p.description ? `Project notes: ${p.description}` : '',
    'Requests arrive as <channel source="hannigan" kind="task" request_id="…">. They come from a secretary Claude that talks to the person through WebChat or Discord.',
    POLICY[p.pm.execution_policy],
    'Always delegate GUI work and anything that needs computer use to a task session. Before delegating, write down the current state and the exact scope so no work is done twice. If direct work grows, hand the rest over to a task session with what is already changed.',
    'Task sessions work in the same folder. Their reports arrive as <channel kind="task_report" task_session="…">. Check the result (files, tests) before you report.',
    'Report with the reply tool and pass the request_id of the request you answer. One request may get several replies: progress, a blocking question, the final result.',
    '<channel kind="user_direct" message_id="…">: the person wrote to you directly in WebChat. Answer with reply(in_reply_to=message_id) and no request_id.',
    '<channel kind="user_direct_notice" task_session="…" message_id="…">: NOT a new request. The person wrote directly to one of your task sessions and that task already receives the text itself. Do not task_send it again. Update your plan or review points if needed.',
    'Track work in the shared ledger with work_item_create (new item) and work_item_update (status changes). Only short structured fields.',
    LEASE_NOTE,
    'Nobody watches this terminal. Tool approvals are relayed to the person automatically; just call the tool and wait.',
    p.pm.extra_instructions,
  ]
    .filter(Boolean)
    .join('\n')
}

export function taskInstructions(workerId: string, p: ProjectConfig | undefined, s: { project: string; cwd: string; pm_session: string | null }): string {
  const withPm = !!s.pm_session
  return [
    `You are a task Claude Code session on worker "${workerId}", project "${s.project}" (${s.cwd}).`,
    p?.description ? `Project notes: ${p.description}` : '',
    withPm
      ? 'Instructions arrive as <channel source="hannigan" kind="task" …> from your project PM (another Claude session). <channel kind="user_direct" message_id="…"> is the person writing to you directly in WebChat; your PM is told about it.'
      : 'Tasks arrive as <channel source="hannigan" kind="task" ...>. They come from a secretary Claude that talks to the person through WebChat.',
    withPm
      ? 'Everything you report with the reply tool goes to your PM, who reviews it and reports to the person. Report the result when you finish (what you did, what changed, test results, what is left) and ask with reply when you are blocked.'
      : 'Nobody watches this terminal. Everything the person should know must be sent with the reply tool: the result when you finish, and a question when you are blocked. Keep reports short and concrete (what you did, what changed, what is left).',
    withPm ? LEASE_NOTE : '',
    'Tool approvals are relayed to the person automatically; just call the tool and wait.',
  ]
    .filter(Boolean)
    .join('\n')
}

export function noticeText(taskName: string, taskKey: string, messageId: string, text: string): string {
  return [
    `Notice (not a new request): the person posted directly to your task session "${taskName}" (${taskKey}), message_id ${messageId}.`,
    'The task receives the text itself. Do not task_send it again. Update your plan, contradictions or review points if needed.',
    '',
    'Posted text:',
    text,
  ].join('\n')
}
