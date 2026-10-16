// A minimal hub for worker tests: accepts the worker hello (proto 2), sends welcome, acks events,
// records them, and lets a test send commands and await their results. It survives worker restarts.
import type { Server, ServerWebSocket } from 'bun'
import { PROTO, type WorkerEvent, type WorkerEventMsg, type WorkerResult } from '../shared/protocol.ts'

export type RecordedEvent = WorkerEvent & { seq: number; ts: string; [k: string]: any }

export class FakeHub {
  server: Server<undefined>
  events: RecordedEvent[] = []
  hellos: Record<string, unknown>[] = []
  private ws: ServerWebSocket<undefined> | null = null
  private lastSeq = 0
  private waiting = new Map<string, (r: WorkerResult) => void>()
  private n = 0

  constructor(port = 0) {
    this.server = Bun.serve({
      hostname: '127.0.0.1',
      port,
      fetch: (req, server) => {
        if (new URL(req.url).pathname === '/ws/worker' && server.upgrade(req)) return
        return new Response('not found', { status: 404 })
      },
      websocket: {
        message: (ws, raw) => this.onMessage(ws, String(raw)),
        close: ws => {
          if (this.ws === ws) this.ws = null
        },
      },
    })
  }

  get url(): string {
    return `ws://127.0.0.1:${this.server.port}/ws/worker`
  }
  get connected(): boolean {
    return !!this.ws
  }

  private onMessage(ws: ServerWebSocket<undefined>, raw: string): void {
    const m = JSON.parse(raw) as { t: string; [k: string]: any }
    if (m.t === 'hello') {
      this.hellos.push(m)
      if (m.proto !== PROTO) {
        ws.send(JSON.stringify({ t: 'bye', reason: 'proto' }))
        ws.close()
        return
      }
      this.ws = ws
      ws.send(JSON.stringify({ t: 'welcome', proto: PROTO, hub_version: 'fake', last_seq: this.lastSeq }))
    } else if (m.t === 'event') {
      const e = m as unknown as WorkerEventMsg
      if (e.seq > this.lastSeq) {
        this.lastSeq = e.seq
        this.events.push({ ...e.event, seq: e.seq, ts: e.ts } as RecordedEvent)
      }
      ws.send(JSON.stringify({ t: 'ack', seq: e.seq }))
    } else if (m.t === 'result') {
      const done = this.waiting.get(m.id)
      this.waiting.delete(m.id)
      done?.(m as unknown as WorkerResult)
    }
  }

  async waitConnected(timeoutMs = 20000): Promise<void> {
    const t0 = Date.now()
    while (!this.ws) {
      if (Date.now() - t0 > timeoutMs) throw new Error('worker did not connect to the fake hub')
      await Bun.sleep(100)
    }
  }

  // send a command; resolves with the worker's result (ok or error)
  async command(name: string, args: Record<string, unknown> = {}, timeoutMs = 30000, id = `c-${++this.n}-${Date.now()}`): Promise<WorkerResult> {
    await this.waitConnected()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new Error(`no result for ${name} within ${timeoutMs} ms`))
      }, timeoutMs)
      this.waiting.set(id, r => {
        clearTimeout(timer)
        resolve(r)
      })
      this.ws!.send(JSON.stringify({ t: 'command', id, name, args }))
    })
  }

  // ok data or throws with the error code
  async ok<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const r = await this.command(name, args)
    if (!r.ok) throw new Error(`${name} failed: ${r.error.code}: ${r.error.message}`)
    return r.data as T
  }

  last(): number {
    return this.events.length ? this.events[this.events.length - 1]!.seq : 0
  }

  async waitEvent(pred: (e: RecordedEvent) => boolean, after = 0, timeoutMs = 30000, what = 'event'): Promise<RecordedEvent> {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      const hit = this.events.find(e => e.seq > after && pred(e))
      if (hit) return hit
      await Bun.sleep(100)
    }
    throw new Error(
      `timeout waiting for ${what} after seq ${after}\nlast events:\n${this.events
        .slice(-25)
        .map(e => JSON.stringify(e))
        .join('\n')}`,
    )
  }

  stop(): void {
    this.server.stop(true)
  }
}
