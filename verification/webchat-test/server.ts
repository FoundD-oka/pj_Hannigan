#!/usr/bin/env bun
// webchat-test: verification-only Claude Code channel.
// - two-way chat bridge (reply tool) for a minimal WebChat UI
// - permission relay (claude/channel/permission)
// - append-only JSONL event log so a reconnecting browser can recover results
// - logs every MCP notification it receives, to see whether Computer Use app
//   approval ever reaches the channel
// - optional auxiliary stop path: sends Escape to the tmux pane hosting Claude Code
//   (this is a terminal operation, NOT a Channels feature, and is logged as such)
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { spawnSync } from 'child_process'

const HERE = import.meta.dir
const PORT = Number(process.env.WEBCHAT_PORT ?? 8790)
const HOST = process.env.WEBCHAT_HOST ?? '127.0.0.1'
const STATE_DIR = process.env.WEBCHAT_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'webchat-test')
const TOKEN_FILE = join(STATE_DIR, 'token')
const LOG_FILE = process.env.WEBCHAT_LOG ?? join(STATE_DIR, 'events.jsonl')
const TMUX_TARGET = process.env.WEBCHAT_TMUX_TARGET ?? ''

mkdirSync(STATE_DIR, { recursive: true })
const TOKEN = (process.env.WEBCHAT_TOKEN ?? (existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, 'utf8') : '')).trim()
if (!TOKEN) {
  process.stderr.write(`webchat-test: no token. Put one in ${TOKEN_FILE}\n`)
  process.exit(1)
}

// ---------------------------------------------------------------- event log
type Ev = { seq: number; ts: string; kind: string; [k: string]: unknown }
const events: Ev[] = []
let seq = 0
if (existsSync(LOG_FILE)) {
  for (const line of readFileSync(LOG_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line) as Ev
      events.push(e)
      seq = Math.max(seq, e.seq)
    } catch {}
  }
}
const subscribers = new Set<(e: Ev) => void>()
function record(kind: string, data: Record<string, unknown> = {}): Ev {
  const e: Ev = { seq: ++seq, ts: new Date().toISOString(), kind, ...data }
  events.push(e)
  appendFileSync(LOG_FILE, JSON.stringify(e) + '\n')
  for (const s of subscribers) s(e)
  return e
}

const seenMsgIds = new Set(events.filter(e => e.kind === 'user_message').map(e => String(e.msg_id)))
const openRequests = new Map<string, Ev>()
for (const e of events) {
  if (e.kind === 'permission_request') openRequests.set(String(e.request_id), e)
  if (e.kind === 'verdict_sent') openRequests.delete(String(e.request_id))
}
// requests from a previous process can never be answered
openRequests.clear()

const ppid = process.ppid
const envHints = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => /^CLAUDE/.test(k) && /SESSION|ENTRYPOINT|VERSION/.test(k)),
)
record('channel_started', {
  pid: process.pid,
  ppid,
  parent_cmd: spawnSync('ps', ['-o', 'command=', '-p', String(ppid)]).stdout?.toString().trim(),
  env_hints: envHints,
  env_claude_keys: Object.keys(process.env).filter(k => /^CLAUDE/.test(k)),
  tmux_target: TMUX_TARGET || null,
})

// ---------------------------------------------------------------- MCP server
const mcp = new Server(
  { name: 'webchat-test', version: '0.0.1' },
  {
    capabilities: {
      experimental: { 'claude/channel': {}, 'claude/channel/permission': {} },
      tools: {},
    },
    instructions:
      'Messages from the verification WebChat arrive as <channel source="webchat-test" chat_id="..." message_id="...">. ' +
      'The sender reads only the WebChat UI, never this terminal. Anything they should see must be sent with the reply tool, ' +
      'passing chat_id from the tag and in_reply_to set to the message_id you are answering. ' +
      'Several messages may arrive together; answer each one.',
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Send a message back to the WebChat conversation',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'chat_id from the <channel> tag' },
          text: { type: 'string', description: 'Message text' },
          in_reply_to: { type: 'string', description: 'message_id being answered' },
        },
        required: ['chat_id', 'text'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  if (req.params.name === 'reply') {
    const a = req.params.arguments as { chat_id: string; text: string; in_reply_to?: string }
    const e = record('assistant_reply', { conv_id: a.chat_id, text: a.text, in_reply_to: a.in_reply_to ?? null })
    return { content: [{ type: 'text', text: `sent (seq ${e.seq})` }] }
  }
  throw new Error(`unknown tool: ${req.params.name}`)
})

const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
})
mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  const e = record('permission_request', { ...params })
  openRequests.set(params.request_id, e)
})

// Log any other notification Claude Code sends us (e.g. an unknown CU approval method)
mcp.fallbackNotificationHandler = async n => {
  record('unknown_notification', { method: n.method, params: n.params ?? null })
}

await mcp.connect(new StdioServerTransport())

// ---------------------------------------------------------------- HTTP
const html = readFileSync(join(HERE, 'index.html'), 'utf8')

function authed(req: Request, url: URL): boolean {
  const h = req.headers.get('authorization') ?? ''
  const t = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token') ?? ''
  return t.length > 0 && t === TOKEN
}
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })

Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (req.method === 'GET' && url.pathname === '/') {
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
    if (!url.pathname.startsWith('/api/')) return new Response('not found', { status: 404 })
    if (!authed(req, url)) {
      record('auth_rejected', { path: url.pathname, remote: req.headers.get('x-forwarded-for') ?? null })
      return json({ error: 'unauthorized' }, 401)
    }
    const ua = req.headers.get('user-agent') ?? ''
    const client = req.headers.get('x-client-id') ?? url.searchParams.get('client') ?? ''

    if (req.method === 'GET' && url.pathname === '/api/events') {
      const since = Number(url.searchParams.get('since') ?? 0)
      let unsub: (() => void) | undefined
      const stream = new ReadableStream({
        start(ctrl) {
          const push = (e: Ev) => ctrl.enqueue(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`)
          for (const e of events) if (e.seq > since) push(e)
          ctrl.enqueue(`event: open_requests\ndata: ${JSON.stringify([...openRequests.keys()])}\n\n`)
          subscribers.add(push)
          unsub = () => subscribers.delete(push)
          record('browser_connected', { client, ua, since })
          req.signal.addEventListener('abort', () => {
            unsub?.()
            record('browser_disconnected', { client })
          })
        },
        cancel() {
          unsub?.()
        },
      })
      return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } })
    }

    if (req.method === 'POST' && url.pathname === '/api/send') {
      const b = (await req.json()) as { conv_id: string; msg_id: string; text: string }
      if (!b.conv_id || !b.msg_id || !b.text) return json({ error: 'conv_id, msg_id, text required' }, 400)
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(b.conv_id) || !/^[A-Za-z0-9_-]{1,64}$/.test(b.msg_id))
        return json({ error: 'bad id' }, 400)
      if (seenMsgIds.has(b.msg_id)) {
        record('duplicate_send_ignored', { conv_id: b.conv_id, msg_id: b.msg_id })
        return json({ status: 'duplicate_ignored' })
      }
      seenMsgIds.add(b.msg_id)
      const e = record('user_message', { conv_id: b.conv_id, msg_id: b.msg_id, text: b.text, client, ua })
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: { content: b.text, meta: { chat_id: b.conv_id, message_id: b.msg_id } },
      })
      // resolves when written to stdio, NOT when Claude processed it
      record('written_to_channel', { conv_id: b.conv_id, msg_id: b.msg_id })
      return json({ status: 'accepted_and_written_to_channel', seq: e.seq })
    }

    if (req.method === 'POST' && url.pathname === '/api/verdict') {
      const b = (await req.json()) as { request_id: string; behavior: 'allow' | 'deny' }
      if (!/^[a-km-z]{5}$/.test(b.request_id ?? '') || !['allow', 'deny'].includes(b.behavior))
        return json({ error: 'bad verdict' }, 400)
      const known = openRequests.has(b.request_id)
      await mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: { request_id: b.request_id, behavior: b.behavior },
      })
      openRequests.delete(b.request_id)
      record('verdict_sent', { request_id: b.request_id, behavior: b.behavior, known_open: known, client, ua })
      return json({ status: 'verdict_written', known_open: known })
    }

    if (req.method === 'POST' && url.pathname === '/api/interrupt') {
      if (!TMUX_TARGET) {
        record('interrupt_unavailable', { reason: 'WEBCHAT_TMUX_TARGET not set', client })
        return json({ status: 'unavailable' }, 409)
      }
      const r = spawnSync('tmux', ['send-keys', '-t', TMUX_TARGET, 'Escape'])
      const e = record('interrupt_key_sent', {
        path: 'auxiliary:tmux send-keys Escape (terminal input, not Channels)',
        tmux_target: TMUX_TARGET,
        exit: r.status,
        stderr: r.stderr?.toString() ?? '',
        client,
      })
      return json({ status: r.status === 0 ? 'key_sent_unconfirmed' : 'failed', seq: e.seq })
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      return json({ pid: process.pid, ppid, seq, open_requests: [...openRequests.keys()], tmux_target: TMUX_TARGET || null })
    }
    return json({ error: 'not found' }, 404)
  },
})
record('http_listening', { host: HOST, port: PORT })
