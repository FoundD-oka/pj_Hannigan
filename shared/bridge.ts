#!/usr/bin/env bun
// Channel bridge: the MCP channel server that Claude Code spawns over stdio.
// It holds no role-specific logic. It connects to the local daemon (worker) or hub (secretary),
// receives instructions and tool definitions in `setup`, and relays both directions.
// See docs/design/02-worker-daemon.md §2.1 and 03-hub-worker-protocol.md §3.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { readFileSync } from 'fs'
import type { BridgeSetup, FromBridge, ToBridge } from './protocol.ts'
import { parseJson } from './protocol.ts'
import { Backoff, rid } from './util.ts'

const URL_ = process.env.HANNIGAN_BRIDGE_URL
const TOKEN_FILE = process.env.HANNIGAN_BRIDGE_TOKEN_FILE
const SESSION_KEY = process.env.HANNIGAN_SESSION_KEY
if (!URL_ || !TOKEN_FILE || !SESSION_KEY) {
  process.stderr.write('hannigan bridge: HANNIGAN_BRIDGE_URL, HANNIGAN_BRIDGE_TOKEN_FILE, HANNIGAN_SESSION_KEY are required\n')
  process.exit(1)
}
const TOKEN = readFileSync(TOKEN_FILE, 'utf8').trim()

const err = (m: string) => process.stderr.write(`hannigan bridge: ${m}\n`)

let ws: WebSocket | null = null
let open = false
let mcp: Server | null = null
let mcpReady = false
const earlyDeliveries: Extract<ToBridge, { t: 'deliver' }>[] = []
const pendingCalls = new Map<string, (r: { ok: boolean; text: string }) => void>()
const outQueue: FromBridge[] = [] // permission requests raised while disconnected
let resolveSetup: (s: BridgeSetup) => void
const setupP = new Promise<BridgeSetup>(r => (resolveSetup = r))
const backoff = new Backoff(500, 10000)

function send(m: FromBridge): boolean {
  if (ws && open) {
    ws.send(JSON.stringify(m))
    return true
  }
  return false
}

function connect(): void {
  const sock = new WebSocket(URL_!)
  ws = sock
  sock.onopen = () => {
    open = true
    backoff.reset()
    sock.send(
      JSON.stringify({
        t: 'hello',
        token: TOKEN,
        session_key: SESSION_KEY!,
        claude_session_id: process.env.CLAUDE_CODE_SESSION_ID ?? null,
        pid: process.pid,
      } satisfies FromBridge),
    )
    while (outQueue.length) sock.send(JSON.stringify(outQueue.shift()))
    if (mcpReady) sock.send(JSON.stringify({ t: 'ready' } satisfies FromBridge))
  }
  sock.onmessage = ev => {
    const m = parseJson<ToBridge>(String(ev.data))
    if (m) void onMessage(m)
  }
  sock.onclose = () => {
    open = false
    if (ws === sock) ws = null
    // fail in-flight tool calls; Claude sees an error and can retry
    for (const [id, done] of pendingCalls) {
      done({ ok: false, text: 'hannigan: connection to daemon lost; retry shortly' })
      pendingCalls.delete(id)
    }
    setTimeout(connect, backoff.next())
  }
  sock.onerror = () => {}
}

async function onMessage(m: ToBridge): Promise<void> {
  switch (m.t) {
    case 'setup':
      resolveSetup(m)
      return
    case 'deliver':
      if (!mcpReady) {
        earlyDeliveries.push(m)
        return
      }
      await mcp!.notification({ method: 'notifications/claude/channel', params: { content: m.content, meta: m.meta } })
      send({ t: 'delivered', id: m.id })
      return
    case 'verdict':
      if (!mcpReady) return
      await mcp!.notification({
        method: 'notifications/claude/channel/permission',
        params: { request_id: m.request_id, behavior: m.behavior },
      })
      return
    case 'tool_result': {
      const done = pendingCalls.get(m.id)
      pendingCalls.delete(m.id)
      done?.({ ok: m.ok, text: m.text })
      return
    }
    case 'bye':
      err(`daemon closed the bridge: ${m.reason}`)
      process.exit(0)
  }
}

connect()
const setup = await Promise.race([
  setupP,
  new Promise<null>(r => setTimeout(() => r(null), 25000)),
])
if (!setup) {
  err(`no setup from ${URL_} within 25s`)
  process.exit(1)
}

mcp = new Server(
  { name: setup.server_name, version: '0.1.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {}, 'claude/channel/permission': {} },
      tools: {},
    },
    instructions: setup.instructions,
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: setup.tools }))
mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const id = rid('k')
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  const r = await new Promise<{ ok: boolean; text: string }>(resolve => {
    if (!send({ t: 'tool_call', id, name: req.params.name, args })) {
      resolve({ ok: false, text: 'hannigan: not connected to daemon; retry shortly' })
      return
    }
    pendingCalls.set(id, resolve)
    setTimeout(() => {
      if (pendingCalls.delete(id)) resolve({ ok: false, text: 'hannigan: tool call timed out' })
    }, 120000)
  })
  return { content: [{ type: 'text', text: r.text }], isError: !r.ok }
})

mcp.setNotificationHandler(
  z.object({
    method: z.literal('notifications/claude/channel/permission_request'),
    params: z.object({
      request_id: z.string(),
      tool_name: z.string(),
      description: z.string(),
      input_preview: z.string(),
    }),
  }),
  async ({ params }) => {
    const m: FromBridge = { t: 'permission_request', ...params }
    if (!send(m)) outQueue.push(m)
  },
)

// Deliver only after the client finished the MCP handshake (notifications/initialized), plus a short
// grace period: a notification written before Claude Code registered its channel listener is dropped silently.
mcp.oninitialized = () => {
  setTimeout(async () => {
    mcpReady = true
    send({ t: 'ready' })
    for (const m of earlyDeliveries.splice(0)) await onMessage(m)
  }, Number(process.env.HANNIGAN_BRIDGE_READY_DELAY_MS ?? 1000))
}
await mcp.connect(new StdioServerTransport())
