#!/usr/bin/env bun
// Fake Claude Code for automated tests. It imitates only what Hannigan relies on:
// - terminal dialogs (workspace trust, development channel warning) answered with arrow keys + Enter
// - spawning the channel server from --mcp-config and acting as its MCP client
// - channel notifications in, reply / session tools out, permission relay
// - an idle input box, a "working (esc to interrupt)" indicator, Esc to interrupt, /exit
// Behaviour is scripted by the message text (see handleWorker / handleSecretary).
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { z } from 'zod'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const argv = process.argv.slice(2)
const arg = (n: string) => {
  const i = argv.indexOf(n)
  return i >= 0 ? argv[i + 1] : undefined
}
const sessionId = arg('--session-id') ?? arg('--resume') ?? 'no-session'
const STATE = process.env.FAKE_CLAUDE_STATE ?? '/tmp/fake-claude'
mkdirSync(STATE, { recursive: true })
appendFileSync(join(STATE, 'argv.jsonl'), JSON.stringify({ sessionId, argv, cwd: process.cwd() }) + '\n')
const memFile = join(STATE, `mem-${sessionId}.json`)
const mem = existsSync(memFile) ? (JSON.parse(readFileSync(memFile, 'utf8')) as Record<string, string>) : {}
const saveMem = () => writeFileSync(memFile, JSON.stringify(mem))

const RULE = '─'.repeat(120)
let screen: string[] = []
let mode: 'dialog' | 'idle' | 'working' | 'permission' = 'idle'
let dialog: { lines: string[]; options: string[]; numbered: boolean; cursor: number; resolve: (i: number) => void } | null = null
let typed = ''
const history: string[] = []

function draw(): void {
  const out: string[] = ['\x1b[2J\x1b[H', ...history.slice(-20)]
  if (mode === 'dialog' && dialog) {
    out.push(RULE, ...dialog.lines.map(l => '  ' + l))
    dialog.options.forEach((o, i) => out.push(`  ${i === dialog!.cursor ? '❯' : ' '} ${dialog!.numbered ? `${i + 1}. ` : ''}${o}`))
    out.push('  Enter to confirm · Esc to cancel')
  } else if (mode === 'permission') {
    out.push(...screen)
  } else {
    if (mode === 'working') out.push('✻ Working… (3s · esc to interrupt)')
    out.push(RULE, '❯ ' + typed, RULE, '  fake-claude | ' + sessionId)
  }
  process.stdout.write(out.join('\r\n'))
}

function ask(lines: string[], options: string[], numbered: boolean): Promise<number> {
  return new Promise(resolve => {
    dialog = { lines, options, numbered, cursor: 0, resolve }
    mode = 'dialog'
    draw()
  })
}

let interrupted = false
process.stdin.setRawMode?.(true)
process.stdin.resume()
process.stdin.on('data', (buf: Buffer) => {
  const s = buf.toString('utf8')
  if (mode === 'dialog' && dialog) {
    if (s === '\x1b[B') dialog.cursor = Math.min(dialog.options.length - 1, dialog.cursor + 1)
    else if (s === '\x1b[A') dialog.cursor = Math.max(0, dialog.cursor - 1)
    else if (s === '\r' || s === '\n') {
      const d = dialog
      dialog = null
      mode = 'idle'
      d.resolve(d.cursor)
      return
    }
    draw()
    return
  }
  if (s === '\x1b') {
    if (mode === 'working') {
      interrupted = true
      history.push('  ⎿  Interrupted · What should Claude do instead?')
      mode = 'idle'
      draw()
    }
    return
  }
  if (s === '\r' || s === '\n') {
    if (typed.trim() === '/exit') {
      process.stdout.write('\r\nbye\r\n')
      process.exit(0)
    }
    typed = ''
    draw()
    return
  }
  if (s === '\x7f') typed = typed.slice(0, -1)
  else typed += s
  draw()
})

// ------------------------------------------------------------ startup dialogs
const cwd = process.cwd()
const trustedFile = join(STATE, 'trusted.json')
const trusted = existsSync(trustedFile) ? (JSON.parse(readFileSync(trustedFile, 'utf8')) as string[]) : []
if (process.env.FAKE_TRUST_DIALOG === '1' && !trusted.includes(cwd)) {
  const c = await ask(
    ['Accessing workspace:', '', cwd, '', 'Quick safety check: Is this a project you created or one you trust?', ''],
    ['No, exit', 'Yes, I trust this folder'],
    false,
  )
  if (c !== 1) process.exit(1)
  trusted.push(cwd)
  writeFileSync(trustedFile, JSON.stringify(trusted))
}
const devFlag = arg('--dangerously-load-development-channels')
if (devFlag) {
  const c = await ask(
    ['WARNING: Loading development channels', '', '--dangerously-load-development-channels is for local channel development only.', '', `Channels: ${devFlag}`, ''],
    ['I am using this for local development', 'Exit'],
    true,
  )
  if (c !== 0) process.exit(1)
}

// ------------------------------------------------------------ MCP client to the channel
const cfg = JSON.parse(readFileSync(arg('--mcp-config')!, 'utf8')) as {
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>
}
const [serverName, server] = Object.entries(cfg.mcpServers)[0]!
const client = new Client({ name: 'fake-claude', version: '0.0.1' })
const env: Record<string, string> = {}
for (const [k, v] of Object.entries(process.env)) if (v != null) env[k] = v
let role: 'worker' | 'secretary' | 'pm' = 'worker'
let roleKnown = false

let verdictWaiter: ((b: string) => void) | null = null
client.setNotificationHandler(
  z.object({ method: z.literal('notifications/claude/channel/permission'), params: z.object({ request_id: z.string(), behavior: z.string() }) }),
  async ({ params }) => {
    verdictWaiter?.(params.behavior)
  },
)

type Ev = { content: string; meta: Record<string, string> }
const queue: Ev[] = []
let busy = false
client.setNotificationHandler(
  z.object({ method: z.literal('notifications/claude/channel'), params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()).optional() }) }),
  async ({ params }) => {
    queue.push({ content: params.content, meta: params.meta ?? {} })
    history.push(`← ${serverName}: ${params.content.slice(0, 80)}`)
    void pump()
  },
)

await client.connect(
  new StdioClientTransport({ command: server.command, args: server.args, env: { ...env, ...server.env, CLAUDE_CODE_SESSION_ID: sessionId } }),
)
const tools = (await client.listTools()).tools.map(t => t.name)
role = tools.includes('session_create') ? 'secretary' : tools.includes('task_create') ? 'pm' : 'worker'
roleKnown = true
history.push(`Channels (experimental) messages from server:${serverName} · fake role ${role}`)
mode = 'idle'
draw()
void pump()

async function pump(): Promise<void> {
  if (busy || !roleKnown) return
  busy = true
  while (queue.length) {
    const ev = queue.shift()!
    mode = 'working'
    interrupted = false
    draw()
    try {
      if (role === 'worker') await handleWorker(ev)
      else if (role === 'pm') await handlePm(ev)
      else await handleSecretary(ev)
    } catch (e) {
      history.push('error: ' + String(e))
    }
    await new Promise(r => setTimeout(r, 300))
    if (mode === 'working') mode = 'idle'
    draw()
  }
  busy = false
}

const call = async (name: string, args: Record<string, unknown>) => {
  const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean }
  return { text: r.content.map(c => c.text).join(''), isError: !!r.isError }
}
const letters = 'abcdefghijkmnopqrstuvwxyz'
const reqId = () => Array.from({ length: 5 }, () => letters[Math.floor(Math.random() * letters.length)]).join('')

async function permission(tool: string, preview: string): Promise<string> {
  const request_id = reqId()
  mode = 'permission'
  screen = [RULE, ' Bash command', '', '   ' + preview, '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel · Tab to amend']
  draw()
  const verdict = new Promise<string>(r => (verdictWaiter = r))
  await client.notification({
    method: 'notifications/claude/channel/permission_request',
    params: { request_id, tool_name: tool, description: `fake ${tool} call`, input_preview: JSON.stringify({ command: preview }) },
  } as never)
  const b = await verdict
  verdictWaiter = null
  mode = 'working'
  draw()
  return b
}

async function handleWorker(ev: Ev): Promise<void> {
  const c = ev.content.trim()
  if (ev.meta.kind === 'user_direct') {
    await call('reply', { text: `task direct: ${c}` })
  } else if (c.startsWith('remember:')) {
    mem.word = c.slice(9)
    saveMem()
    await call('reply', { text: `remembered ${mem.word}` })
  } else if (c === 'recall') {
    await call('reply', { text: `recall: ${mem.word ?? 'unknown'}` })
  } else if (c.startsWith('bash:')) {
    const b = await permission('Bash', c.slice(5))
    await call('reply', { text: b === 'allow' ? `bash allowed: ${c.slice(5)}` : `bash denied: ${c.slice(5)}` })
  } else if (c.startsWith('slow:')) {
    const until = Date.now() + Number(c.slice(5)) * 1000
    while (Date.now() < until && !interrupted) await new Promise(r => setTimeout(r, 100))
    if (!interrupted) await call('reply', { text: `slow done ${c.slice(5)}` })
  } else {
    await call('reply', { text: `echo: ${c}` })
  }
}

// project PM (role=pm): scripted by the request text; replies carry request_id / in_reply_to like a real PM should
let pmLastRequest = ''
async function handlePm(ev: Ev): Promise<void> {
  const kind = ev.meta.kind
  const c = ev.content.trim()
  if (kind === 'task' && ev.meta.request_id) pmLastRequest = ev.meta.request_id
  const say = (text: string, extra: Record<string, unknown> = {}) => call('reply', { text, ...extra })
  const sayReq = (text: string) => say(text, { request_id: ev.meta.request_id || pmLastRequest || undefined })
  // a task report carries the request it belongs to in meta (none when the task answered a direct post)
  if (kind === 'task_report') return void (await say(`pm report: ${c}`, { request_id: ev.meta.request_id || undefined }))
  if (kind === 'user_direct') return void (await say(`pm direct: ${c}`, { in_reply_to: ev.meta.message_id }))
  if (kind === 'user_direct_notice') {
    const notices = JSON.parse(mem.notices ?? '[]') as { message_id: string; task_session: string }[]
    notices.push({ message_id: ev.meta.message_id ?? '', task_session: ev.meta.task_session ?? '' })
    mem.notices = JSON.stringify(notices)
    saveMem()
    return void (await say(`noticed ${ev.meta.message_id}`, { in_reply_to: ev.meta.message_id }))
  }
  if (c.startsWith('direct:')) {
    await sayReq(`pm did: ${c.slice(7)}`)
  } else if (c.startsWith('delegate:')) {
    const r = await call('task_create', { name: 'fake task' })
    if (r.isError) return void (await sayReq(`task_create failed: ${r.text}`))
    const key = (JSON.parse(r.text) as { session: string }).session
    mem.lastTask = key
    saveMem()
    const s = await call('task_send', { session: key, text: c.slice(9) })
    if (s.isError) await sayReq(`task_send failed: ${s.text}`)
  } else if (c.startsWith('item:')) {
    const r = await call('work_item_create', { title: c.slice(5), request_id: ev.meta.request_id })
    await sayReq(`item ${r.isError ? 'failed: ' + r.text : JSON.parse(r.text).work_item_id}`)
  } else if (c.startsWith('slow:')) {
    const until = Date.now() + Number(c.slice(5)) * 1000
    while (Date.now() < until && !interrupted) await new Promise(r => setTimeout(r, 100))
    if (!interrupted) await sayReq(`slow done ${c.slice(5)}`)
  } else if (c.startsWith('silent:')) {
    // takes the request and does not answer (it stays open)
  } else if (c.startsWith('noid:')) {
    // answers without naming the request (attribution is left to the worker)
    await say(`noid: ${c.slice(5)}`)
  } else if (c.startsWith('call:')) {
    // call:<tool> <json args>  -> reply with the raw tool result (scope tests)
    const [tool, ...rest] = c.slice(5).split(' ')
    const r = await call(tool!, JSON.parse(rest.join(' ') || '{}'))
    await sayReq(`call ${tool}: ${r.isError ? 'error' : 'ok'} ${r.text}`)
  } else {
    await sayReq(`pm echo: ${c}`)
  }
}

let lastChat = ''
async function handleSecretary(ev: Ev): Promise<void> {
  const kind = ev.meta.kind
  const chat = ev.meta.chat_id ?? lastChat
  if (chat) lastChat = chat
  const say = (text: string) => call('reply', { chat_id: chat || 'unknown', text, in_reply_to: ev.meta.message_id })
  if (kind === 'worker_report')
    return void (await say(`report: ${ev.content}${ev.meta.request_id ? ` (request_id=${ev.meta.request_id})` : ''}`))
  if (kind === 'worker_event') return void (await say(`event: ${ev.content}`))
  const [cmd, worker, a, ...rest] = ev.content.trim().split(' ')
  if (cmd === 'pm') {
    // pm <worker> <project> <text...> -> project_pm_send (Phase 3 normal path)
    const r = await call('project_pm_send', { worker, project: a, text: rest.join(' ') })
    await say(r.isError ? `pm failed: ${r.text}` : `pm ${r.text}`)
  } else if (cmd === 'items') {
    // items [worker] [project] -> project_status
    const r = await call('project_status', { ...(worker ? { worker } : {}), ...(a ? { project: a } : {}) })
    await say(r.isError ? `items failed: ${r.text}` : `items ${r.text.replace(/\s+/g, ' ')}`)
  } else if (cmd === 'replyto') {
    // replyto <chat_id> <text...>: reply to another conversation (must be refused), then report the outcome here
    const r = await call('reply', { chat_id: worker, text: [a, ...rest].join(' ') })
    await say(`replyto ${r.isError ? 'refused' : 'sent'}: ${r.text}`)
  } else if (cmd === 'task') {
    const r = await call('session_create', { worker, project: a, chat_id: chat })
    if (r.isError) return void (await say(`create failed: ${r.text}`))
    const key = (JSON.parse(r.text) as { session: { key: string } }).session.key
    const s = await call('session_send', { worker, session: key, text: rest.join(' '), chat_id: chat })
    await say(`delegated ${key} ${s.isError ? 'send failed: ' + s.text : s.text}`)
  } else if (cmd === 'send') {
    const s = await call('session_send', { worker, session: a, text: rest.join(' '), chat_id: chat })
    await say(s.isError ? `send failed: ${s.text}` : `sent ${s.text}`)
  } else if (cmd === 'resume') {
    const r = await call('session_resume', { worker, session: a, chat_id: chat })
    if (r.isError) return void (await say(`resume failed: ${r.text}`))
    const s = await call('session_send', { worker, session: a, text: rest.join(' '), chat_id: chat })
    await say(`resumed ${a} ${s.text}`)
  } else if (cmd === 'stop') {
    const r = await call('session_stop', { worker, session: a })
    await say(`stop ${r.text}`)
  } else if (cmd === 'status') {
    const r = await call('workers_status', {})
    await say(`status ${r.text.replace(/\s+/g, ' ')}`)
  } else {
    await say(`hello: ${ev.content}`)
  }
}
