#!/usr/bin/env node
// The relay daemon on the VPS: Macs connect out to it over wss, OpenMausBot's acp-client processes connect to it over a
// unix socket, and it joins the two without reading the ACP lines. docs/design/05-omb-mac-relay.md.
//   node server.js                 run the daemon
//   node server.js pair --mac ID   issue a one-time code for a Mac (10 minutes, single use)
//   node server.js status          list the Macs
import { createHash, randomBytes } from 'crypto'
import { chmodSync, existsSync, mkdirSync, rmSync } from 'fs'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'http'
import { connect as netConnect, createServer as createNetServer, type Socket } from 'net'
import { homedir } from 'os'
import { join } from 'path'
import { createInterface } from 'readline'
import { WebSocket, WebSocketServer } from 'ws'
import { PairingStore } from '../hub/pairing.ts'
import { safeEqual } from '../shared/secrets.ts'
import { log, nowIso, readJson, rid, writeJsonAtomic } from '../shared/util.ts'
import { ReliableLink } from './link.ts'
import {
  DEAD_AFTER_MS,
  DEFAULT_RELAY_PORT,
  RELAY_PATH,
  type AdminReply,
  type AdminRequest,
  type ClientToRelay,
  type FromMac,
  type MacHello,
  type RelayDenied,
  type RelayToClient,
  type RelayWelcome,
  type ToMac,
} from './protocol.ts'

const HOME = process.env.HANNIGAN_RELAY_HOME ?? join(homedir(), '.hannigan-relay')
const SOCK = process.env.HANNIGAN_RELAY_SOCK ?? join(HOME, 'relay.sock')
const PORT = Number(process.env.HANNIGAN_RELAY_PORT ?? DEFAULT_RELAY_PORT)
const MACS_FILE = join(HOME, 'macs.json')
const COMPONENT = 'relay'

type MacRecord = { key_sha256: string; paired_at: string }
type MacConn = {
  id: string
  link: ReliableLink<FromMac, ToMac>
  ws: WebSocket | null
  epoch: string | null
  lastRx: number
  clients: Map<string, Socket>
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const relayEpoch = rid('r')
const conns = new Map<string, MacConn>()
const macs = () => readJson<Record<string, MacRecord>>(MACS_FILE, {})

function connFor(id: string): MacConn {
  let c = conns.get(id)
  if (!c) {
    const conn: MacConn = {
      id,
      ws: null,
      epoch: null,
      lastRx: 0,
      clients: new Map(),
      link: new ReliableLink<FromMac, ToMac>(
        body => {
          if (body.t === 'line') writeClient(conn.clients.get(body.ch), { t: 'line', line: body.line })
        },
        () => {
          // a Mac away for very long: nothing can be delivered in order any more
          log(COMPONENT, 'queue overflow; ending the open channels', { mac: id })
          endChannels(conn)
          conn.link.reset()
        },
      ),
    }
    conns.set(id, conn)
    c = conn
  }
  return c
}

function writeClient(sock: Socket | undefined, m: RelayToClient): void {
  if (sock && !sock.destroyed) sock.write(JSON.stringify(m) + '\n')
}

function endChannels(c: MacConn): void {
  for (const sock of c.clients.values()) sock.destroy()
  c.clients.clear()
}

function setOnline(c: MacConn, online: boolean): void {
  for (const sock of c.clients.values()) writeClient(sock, { t: 'state', online })
}

// ---------------------------------------------------------------- Macs over wss
function onMacHello(ws: WebSocket, hello: MacHello): void {
  const rec = macs()[hello.mac]
  if (!rec || !safeEqual(rec.key_sha256, sha256(String(hello.key ?? '')))) {
    log(COMPONENT, 'mac refused', { mac: String(hello.mac).slice(0, 32) })
    ws.send(JSON.stringify({ t: 'denied', reason: 'unknown mac or wrong key' } satisfies RelayDenied))
    ws.close()
    return
  }
  const c = connFor(hello.mac)
  if (c.ws && c.ws !== ws) c.ws.terminate()
  if (c.epoch && c.epoch !== hello.epoch) {
    // the Mac's agent restarted and lost its queue: its channels are gone (OpenMausBot reopens them with session/load)
    log(COMPONENT, 'mac restarted; ending its channels', { mac: c.id, channels: c.clients.size })
    endChannels(c)
    c.link.reset()
  }
  c.epoch = hello.epoch
  c.ws = ws
  c.lastRx = Date.now()
  ws.send(JSON.stringify({ t: 'welcome', epoch: relayEpoch, lastSeen: c.link.lastSeen } satisfies RelayWelcome))
  c.link.attach(text => ws.readyState === WebSocket.OPEN && ws.send(text))
  c.link.resume(hello.lastSeen)
  setOnline(c, true)
  log(COMPONENT, 'mac connected', { mac: c.id, queued: c.link.pending })

  ws.on('message', raw => {
    c.lastRx = Date.now()
    const text = raw.toString()
    if (text === '{"ping":1}') {
      ws.send('{"pong":1}')
      return
    }
    c.link.receive(text)
  })
  ws.on('close', () => {
    if (c.ws !== ws) return
    c.ws = null
    c.link.detach()
    setOnline(c, false)
    log(COMPONENT, 'mac disconnected', { mac: c.id })
  })
}

setInterval(() => {
  for (const c of conns.values()) {
    if (c.ws && Date.now() - c.lastRx > DEAD_AFTER_MS) {
      log(COMPONENT, 'mac silent; closing its socket', { mac: c.id })
      c.ws.terminate()
    }
  }
}, 10000).unref()

// ---------------------------------------------------------------- acp-client processes and the CLI over the unix socket
function onLocalSocket(sock: Socket): void {
  const rl = createInterface({ input: sock })
  let conn: MacConn | null = null
  let ch: string | null = null
  sock.on('error', () => {})
  sock.on('close', () => {
    if (conn && ch) {
      conn.clients.delete(ch)
      conn.link.send({ t: 'close', ch })
    }
  })
  rl.on('line', text => {
    let m: ClientToRelay | AdminRequest
    try {
      m = JSON.parse(text)
    } catch {
      return
    }
    if (m.t === 'connect') {
      if (!macs()[m.mac]) {
        writeClient(sock, { t: 'error', message: `Mac「${m.mac}」はペアリングされていません` })
        sock.end()
        return
      }
      conn = connFor(m.mac)
      ch = rid('c')
      conn.clients.set(ch, sock)
      conn.link.send({ t: 'open', ch })
      writeClient(sock, { t: 'state', online: !!conn.ws })
    } else if (m.t === 'line' && conn && ch) {
      conn.link.send({ t: 'line', ch, line: m.line })
    } else if (m.t === 'issue_code' || m.t === 'status') {
      sock.end(JSON.stringify(admin(m)) + '\n')
    }
  })
}

function admin(m: AdminRequest): AdminReply {
  try {
    if (m.t === 'issue_code') {
      const e = pairing.start({ worker: m.mac })
      return { t: 'code', mac: m.mac, code: e.code, expires_at: e.expires_at }
    }
    return {
      t: 'status',
      macs: Object.keys(macs()).map(mac => {
        const c = conns.get(mac)
        return { mac, online: !!c?.ws, channels: c?.clients.size ?? 0, queued: c?.link.pending ?? 0 }
      }),
    }
  } catch (e) {
    return { t: 'error', message: (e as Error).message }
  }
}

// ---------------------------------------------------------------- HTTP: pairing and health, behind Caddy
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function onHttp(req: IncomingMessage, res: ServerResponse): void {
  const path = (req.url ?? '').split('?')[0]
  if (req.method === 'GET' && path === `${RELAY_PATH}/health`) return json(res, 200, { ok: true })
  if (req.method === 'POST' && path === `${RELAY_PATH}/pair`) {
    let raw = ''
    req.on('data', d => {
      raw += d
      if (raw.length > 4096) req.destroy()
    })
    req.on('end', () => {
      let b: { code?: unknown; mac?: unknown } = {}
      try {
        b = JSON.parse(raw)
      } catch {}
      const r = pairing.verify(b.code, b.mac)
      if (!r.ok) {
        log(COMPONENT, 'pairing refused', { reason: r.reason })
        return json(res, r.reason === 'bad_args' ? 400 : 403, { error: r.message })
      }
      const key = randomBytes(32).toString('hex')
      writeJsonAtomic(MACS_FILE, { ...macs(), [r.entry.worker]: { key_sha256: sha256(key), paired_at: nowIso() } })
      log(COMPONENT, 'mac paired', { mac: r.entry.worker })
      json(res, 200, { mac: r.entry.worker, key })
    })
    return
  }
  json(res, 404, { error: 'not found' })
}

// ---------------------------------------------------------------- CLI
function askDaemon(m: AdminRequest): void {
  const sock = netConnect(SOCK)
  const rl = createInterface({ input: sock })
  sock.on('error', e => {
    console.error(`relay daemon not reachable at ${SOCK}: ${e.message}`)
    process.exit(1)
  })
  sock.on('connect', () => sock.write(JSON.stringify(m) + '\n'))
  rl.on('line', text => {
    const r = JSON.parse(text) as AdminReply
    if (r.t === 'code') console.log(`mac:     ${r.mac}\ncode:    ${r.code}\nexpires: ${r.expires_at}`)
    else if (r.t === 'status') for (const x of r.macs) console.log(`${x.mac}\t${x.online ? 'online' : 'offline'}\tchannels ${x.channels}\tqueued ${x.queued}`)
    else {
      console.error(r.message)
      process.exitCode = 1
    }
    sock.end()
  })
}

const [cmd, ...rest] = process.argv.slice(2)
if (cmd === 'pair' || cmd === 'status') {
  if (cmd === 'status') askDaemon({ t: 'status' })
  else {
    const i = rest.indexOf('--mac')
    if (i < 0 || !rest[i + 1]) {
      console.error('usage: server.js pair --mac <id>')
      process.exit(2)
    }
    askDaemon({ t: 'issue_code', mac: rest[i + 1] })
  }
} else if (cmd) {
  console.error('usage: server.js [pair --mac <id> | status]')
  process.exit(2)
}

mkdirSync(HOME, { recursive: true, mode: 0o700 })
const pairing = new PairingStore(join(HOME, 'pairing.json'))

if (!cmd) {
  if (existsSync(SOCK)) rmSync(SOCK)
  const local = createNetServer(onLocalSocket)
  local.listen(SOCK, () => chmodSync(SOCK, 0o600))
  const http = createHttpServer(onHttp)
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 })
  http.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '').split('?')[0] !== `${RELAY_PATH}/ws`) return socket.destroy()
    wss.handleUpgrade(req, socket, head, ws => {
      const timer = setTimeout(() => ws.terminate(), 5000)
      ws.once('message', raw => {
        clearTimeout(timer)
        let hello: MacHello | null = null
        try {
          hello = JSON.parse(raw.toString())
        } catch {}
        if (hello?.t === 'hello') onMacHello(ws, hello)
        else ws.terminate()
      })
    })
  })
  http.listen(PORT, '127.0.0.1', () => log(COMPONENT, 'relay started', { port: PORT, sock: SOCK, macs: Object.keys(macs()) }))
}
