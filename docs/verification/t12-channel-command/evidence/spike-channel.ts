import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { appendFileSync } from 'fs'
const LOG = process.env.SPIKE_LOG!
const log = (o: any) => appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n')
const mcp = new Server({ name: 'spike', version: '0.0.1' }, {
  capabilities: { experimental: { 'claude/channel': {}, 'claude/channel/permission': {} }, tools: {} },
  instructions: 'Messages arrive as <channel source="spike" chat_id="...">. Answer with the reply tool, passing chat_id.',
})
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'reply', description: 'reply', inputSchema: { type: 'object', properties: { chat_id: { type: 'string' }, text: { type: 'string' } }, required: ['chat_id', 'text'] } }] }))
mcp.setRequestHandler(CallToolRequestSchema, async req => { log({ kind: 'reply', args: req.params.arguments }); return { content: [{ type: 'text', text: 'sent' }] } })
mcp.fallbackNotificationHandler = async n => log({ kind: 'notif', method: n.method, params: n.params })
await mcp.connect(new StdioServerTransport())
log({ kind: 'started', env: Object.keys(process.env).filter(k => k.startsWith('CLAUDE')) })
// read commands from a fifo-like file poll
import { readFileSync, existsSync, writeFileSync } from 'fs'
setInterval(async () => {
  const f = process.env.SPIKE_IN!
  if (!existsSync(f)) return
  const txt = readFileSync(f, 'utf8'); writeFileSync(f + '.done', txt); require('fs').unlinkSync(f)
  const o = JSON.parse(txt)
  await mcp.notification(o)
  log({ kind: 'sent', o })
}, 500)
