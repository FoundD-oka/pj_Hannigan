#!/usr/bin/env bun
// Drives acp-agent.ts the way OpenMausBot's ACP client does, without OpenMausBot: two prompts in one session,
// every approval answered with the first allow option. Prints the session updates.
//   bun prototype/omb-acp/smoke.ts "first prompt" "follow-up prompt"
import { spawn } from 'child_process'
import { join } from 'path'
import { createInterface } from 'readline'

const prompts = process.argv.slice(2)
const child = spawn(process.execPath, [join(import.meta.dir, 'acp-agent.ts')], { stdio: ['pipe', 'pipe', 'inherit'] })
const waits = new Map<number, (r: any) => void>()
let seq = 0
const call = (method: string, params: unknown) =>
  new Promise<any>(r => {
    const id = ++seq
    waits.set(id, r)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
createInterface({ input: child.stdout }).on('line', line => {
  const m = JSON.parse(line)
  if (m.method === 'session/update') {
    const u = m.params.update
    console.log(`  [${u.sessionUpdate}]`, u.content?.text?.trim() ?? `${u.title ?? ''} ${u.status ?? ''}`.trim())
  } else if (m.method === 'session/request_permission') {
    const opt = m.params.options.find((o: any) => o.kind === 'allow_once')
    console.log('  [request_permission]', m.params.toolCall.title, '->', opt?.name)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: opt.optionId } } }) + '\n')
  } else if (m.id !== undefined) {
    waits.get(m.id)?.(m)
    waits.delete(m.id)
  }
})

console.log('initialize', JSON.stringify((await call('initialize', { protocolVersion: 1, clientCapabilities: {} })).result))
const sessionId = (await call('session/new', { cwd: process.cwd(), mcpServers: [] })).result.sessionId
console.log('session', sessionId)
for (const text of prompts) {
  const t0 = Date.now()
  console.log('prompt >', text)
  const r = await call('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
  console.log('stop <', JSON.stringify(r.result ?? r.error), `${((Date.now() - t0) / 1000).toFixed(1)}s`)
}
child.stdin.end()
