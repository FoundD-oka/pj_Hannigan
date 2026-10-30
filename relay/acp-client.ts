#!/usr/bin/env node
// The ACP engine OpenMausBot starts (`customAcp`, one process per conversation). It answers what needs no Mac by itself
// and passes the rest to the relay daemon. It holds no session state: Claude Code runs on the Mac, and OpenMausBot may
// replace this process at any time. docs/design/05-omb-mac-relay.md.
//   node acp-client.js --mac m4-mini
import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { connect } from 'net'
import { homedir } from 'os'
import { basename, join } from 'path'
import { createInterface } from 'readline'
import type { ClientToRelay, RelayToClient } from './protocol.ts'

const args = process.argv.slice(2)
if (args.includes('--version')) {
  // OpenMausBot checks a custom engine with `<cli> --version` before using it
  console.log('hannigan-acp 0.1.0')
  process.exit(0)
}
const macAt = args.indexOf('--mac')
const MAC = macAt >= 0 ? args[macAt + 1] : undefined
if (!MAC) {
  console.error('usage: acp-client --mac <id>')
  process.exit(2)
}
const SOCK = process.env.HANNIGAN_RELAY_SOCK ?? join(homedir(), '.hannigan-relay', 'relay.sock')
const CLAUDE = process.env.HANNIGAN_ACP_CLAUDE ?? 'claude'
const ONLINE_WAIT_MS = Number(process.env.HANNIGAN_ACP_ONLINE_WAIT_MS ?? 15000)
const OFFLINE_NOTE_MS = 30000
const OFFLINE_GIVE_UP_MS = Number(process.env.HANNIGAN_ACP_OFFLINE_GIVE_UP_MS ?? 15 * 60000)

type Rpc = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: any; result?: any; error?: any }
const write = (m: Rpc): void => {
  process.stdout.write(JSON.stringify(m) + '\n')
}
const say = (sessionId: string, text: string) =>
  write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } })

// ---------------------------------------------------------------- the relay
let online = false
let relayGone = false
let connected = false
const onlineWaiters = new Set<(ok: boolean) => void>()
const toRelay = (m: ClientToRelay): void => {
  sock.write(JSON.stringify(m) + '\n')
}
const sock = connect(SOCK)
sock.on('connect', () => {
  connected = true
  toRelay({ t: 'connect', mac: MAC })
})
sock.on('error', e => {
  relayGone = true
  console.error(`hannigan-acp: relay not reachable: ${e.message}`)
})
sock.on('close', () => {
  relayGone = true
  setOnline(false)
  // this process can never reach the Mac again; OpenMausBot starts a new one and reopens the conversation with
  // session/load. A relay that was never reached stays here, so the prompt gets an answer in the chat.
  if (connected) process.exit(pending.size ? 1 : 0)
})
createInterface({ input: sock }).on('line', text => {
  let m: RelayToClient
  try {
    m = JSON.parse(text)
  } catch {
    return
  }
  if (m.t === 'state') setOnline(m.online)
  else if (m.t === 'error') console.error(`hannigan-acp: ${m.message}`)
  else if (m.t === 'line') onMacLine(m.line)
})

function setOnline(next: boolean): void {
  if (next === online) return
  online = next
  if (online) {
    for (const r of onlineWaiters) r(true)
    onlineWaiters.clear()
    for (const p of pending.values()) {
      if (p.noted) say(p.sessionId, `\n（Mac「${MAC}」とつながり直した。続きを待ってるよ）\n`)
      p.offlineSince = 0
      p.noted = false
    }
  } else {
    for (const p of pending.values()) p.offlineSince = Date.now()
  }
}

function waitOnline(ms: number): Promise<boolean> {
  if (online) return Promise.resolve(true)
  if (relayGone) return Promise.resolve(false)
  return new Promise(resolve => {
    const done = (ok: boolean) => {
      clearTimeout(t)
      onlineWaiters.delete(done)
      resolve(ok)
    }
    const t = setTimeout(() => done(false), ms)
    onlineWaiters.add(done)
  })
}

// ---------------------------------------------------------------- turns in flight, while the Mac is away
type Pending = { sessionId: string; offlineSince: number; noted: boolean }
const pending = new Map<string, Pending>()

function onMacLine(line: string): void {
  let id: string | undefined
  try {
    const m = JSON.parse(line) as Rpc
    if (!m.method && m.id !== undefined) id = String(m.id)
  } catch {}
  if (id) pending.delete(id)
  process.stdout.write(line + '\n')
}

setInterval(() => {
  const now = Date.now()
  for (const [id, p] of pending) {
    if (!p.offlineSince) continue
    if (!p.noted && now - p.offlineSince >= OFFLINE_NOTE_MS) {
      p.noted = true
      say(p.sessionId, `\n（Mac「${MAC}」との接続が切れた。作業は Mac で続いてるはずだから、つながり直すのを待ってるよ）\n`)
    }
    if (now - p.offlineSince >= OFFLINE_GIVE_UP_MS) {
      pending.delete(id)
      toRelay({ t: 'line', line: JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: p.sessionId } }) })
      write({ jsonrpc: '2.0', id: isNaN(Number(id)) ? id : Number(id), error: { code: -32603, message: `Mac「${MAC}」との接続が戻らなかった` } })
    }
  }
}, 5000).unref()

// ---------------------------------------------------------------- what runs here: OpenMausBot's memory upkeep
// A one-shot in an empty folder (no tools, no permissions). It has nothing to do on the Mac and must not start a
// second interactive Claude there, so it stays on the server's own login.
const localSessions = new Map<string, { child: ChildProcess | null }>()
const isMemoryFolder = (cwd: unknown) => typeof cwd === 'string' && basename(cwd).startsWith('omb-acp-memory-')

function runLocal(m: Rpc, sessionId: string, text: string, cwd: string): void {
  const s = localSessions.get(sessionId)!
  const child = spawn(CLAUDE, ['-p', '--output-format', 'text', '--tools', ''], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  s.child = child
  let out = ''
  let err = ''
  child.stdout!.on('data', d => (out += d))
  child.stderr!.on('data', d => (err += d))
  child.on('error', e => write({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: e.message } }))
  child.on('close', code => {
    s.child = null
    if (code !== 0) return write({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: `claude exited ${code}: ${err.slice(0, 300)}` } })
    say(sessionId, out)
    write({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } })
  })
  child.stdin!.end(text)
}

// ---------------------------------------------------------------- ACP from OpenMausBot
const localCwd = new Map<string, string>()

async function onRequest(m: Rpc): Promise<void> {
  const p = m.params ?? {}
  switch (m.method) {
    case 'initialize':
      return write({
        jsonrpc: '2.0',
        id: m.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: false } },
          authMethods: [],
          agentInfo: { name: 'hannigan-acp', title: `Claude Code on ${MAC}`, version: '0.1.0' },
        },
      })
    case 'session/new': {
      // the ID is Claude Code's conversation ID; the Mac starts the session at the first prompt
      const sessionId = randomUUID()
      if (isMemoryFolder(p.cwd)) {
        localSessions.set(sessionId, { child: null })
        localCwd.set(sessionId, p.cwd)
      }
      return write({ jsonrpc: '2.0', id: m.id, result: { sessionId } })
    }
    case 'session/load':
      // the Mac resumes the conversation (or starts it) at the next prompt
      return write({ jsonrpc: '2.0', id: m.id, result: {} })
    case 'session/prompt': {
      const sessionId = String(p.sessionId)
      if (localSessions.has(sessionId)) {
        const text = (Array.isArray(p.prompt) ? p.prompt : []).map((b: any) => (b?.type === 'text' ? b.text : '')).join('\n')
        return runLocal(m, sessionId, text, localCwd.get(sessionId) ?? homedir())
      }
      if (!(await waitOnline(ONLINE_WAIT_MS))) {
        say(sessionId, `Mac「${MAC}」がオフラインだから、今は作業できないよ。Mac の電源とネットワークを確かめて、もう一度送ってね。`)
        write({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } })
        if (relayGone) setTimeout(() => process.exit(0), 100) // the next prompt tries the relay again in a new process
        return
      }
      pending.set(String(m.id), { sessionId, offlineSince: 0, noted: false })
      return toRelay({ t: 'line', line: JSON.stringify(m) })
    }
    default:
      return write({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } })
  }
}

createInterface({ input: process.stdin })
  .on('line', line => {
    let m: Rpc
    try {
      m = JSON.parse(line)
    } catch {
      return
    }
    if (m.method && m.id !== undefined) {
      void onRequest(m)
    } else if (m.method === 'session/cancel' && localSessions.has(String(m.params?.sessionId))) {
      localSessions.get(String(m.params.sessionId))?.child?.kill()
    } else if (!relayGone) {
      // session/cancel, and our answers to the Mac's session/request_permission
      toRelay({ t: 'line', line })
    }
  })
  .on('close', () => process.exit(0))
