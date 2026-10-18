// Pairing end to end (04 WP1, 01 §6): the hub issues a code from the settings API, scripts/pair.ts on "another Mac"
// (a second HANNIGAN_HOME) exchanges it for a key and writes worker.json, and a worker daemon started from that home
// connects without a hub restart. Refusals: wrong code, reused code, wrong worker id, an id that already exists.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { pair, PairError } from '../../scripts/pair.ts'
import { readSecret, readWorkerKeys } from '../../shared/secrets.ts'
import { Harness, type Ev } from '../harness.ts'

const T = 60000
let h: Harness
let home2 = ''
const hubFile = () => JSON.parse(readFileSync(join(h.home, 'hub.json'), 'utf8'))
const prompts = { terminal_prompts: { dev_channel_warning: 'auto_accept', workspace_trust: 'auto_accept' } }

beforeAll(async () => {
  h = new Harness({ projects: ['p1'], secretaryAutostart: false, secretarySession: prompts, pmSession: prompts, workerSession: prompts })
  home2 = join(h.dir, 'home2')
  mkdirSync(home2, { recursive: true })
  h.startHub()
  await h.waitHttp()
  h.startWorker()
  await h.waitEvent(e => e.kind === 'worker_link' && e.worker === 'local' && e.connected === true, 0, T, 'first worker connected')
})
afterAll(async () => {
  await h?.cleanup()
})

describe('pairing (hub + pair.ts + a second worker daemon)', () => {
  test('/api/pairing/start needs the token and a free, valid worker id', async () => {
    expect((await h.api('/api/pairing/start', { worker: 'office' }, 'wrong')).status).toBe(401)
    const bad = await h.api('/api/pairing/start', { worker: 'bad id!' })
    expect(bad.status).toBe(400)
    expect(bad.json.message).toContain('ワーカー ID')
    const exists = await h.api('/api/pairing/start', { worker: 'local' })
    expect(exists.status).toBe(409)
    expect(exists.json.error).toBe('exists')
  })

  test('a code pairs a new worker: key issued, hub.json and the running hub updated, the daemon connects', async () => {
    const s0 = h.lastSeq()
    const r = await h.api('/api/pairing/start', { worker: 'office', display_name: '仕事 Mac', role: '仕事用' })
    expect(r.status).toBe(200)
    expect(r.json.code).toMatch(/^[A-Z2-9]{8}$/)
    expect(r.json.pair_url).toBe(h.url(''))
    expect(r.json.command).toBe(`bun scripts/pair.ts ${h.url('')} ${r.json.code} --worker office`)
    await h.waitEvent(e => e.kind === 'pairing_started' && e.worker === 'office', s0, T, 'pairing_started')
    // the open pairing is listed without its code
    const g = (await h.api('/api/settings')).json
    expect(g.pairing).toEqual([expect.objectContaining({ worker: 'office', failures: 0 })])
    expect(JSON.stringify(g.pairing)).not.toContain(r.json.code)
    // the code itself never reaches the event log
    expect(JSON.stringify(h.events())).not.toContain(r.json.code)

    // wrong worker id for this code: refused, counted
    await expect(pair(home2, { hubUrl: h.url(''), code: r.json.code, worker: 'someone' })).rejects.toThrow(/worker_mismatch|ワーカー「office」用/)
    // the other Mac
    // the real worker of this Mac may hold 8801: give the paired one its own local port
    const res = await pair(home2, { hubUrl: h.url(''), code: r.json.code.toLowerCase(), worker: 'office', localPort: h.port + 2 })
    expect(res.wroteConfig).toBe(true)
    expect(res.wroteKey).toBe(true)
    expect(res.hubUrl).toBe(`ws://127.0.0.1:${h.port}/ws/worker`)
    const w2 = JSON.parse(readFileSync(join(home2, 'worker.json'), 'utf8'))
    expect(w2).toMatchObject({ worker_id: 'office', hub_url: res.hubUrl, projects: [], local: { port: h.port + 2 } })
    const key2 = readSecret(home2, 'worker-key')
    expect(key2).toMatch(/^[0-9a-f]{64}$/)
    // hub side: key stored, hub.json extended, running config extended (no restart)
    expect(readWorkerKeys(h.home).office).toBe(key2!)
    expect(hubFile().workers.map((w: any) => w.id)).toEqual(['local', 'office'])
    expect(hubFile().workers[1]).toEqual({ id: 'office', display_name: '仕事 Mac', role: '仕事用' })
    await h.waitEvent(e => e.kind === 'worker_paired' && e.worker === 'office', s0, T, 'worker_paired')
    expect(JSON.stringify(h.events())).not.toContain(key2!)
    const g2 = (await h.api('/api/settings')).json
    expect(g2.hub.workers.map((w: any) => w.id)).toEqual(['local', 'office'])
    expect(g2.pairing).toEqual([])
    // the code is spent
    await expect(pair(join(h.dir, 'home3'), { hubUrl: h.url(''), code: r.json.code, worker: 'office' })).rejects.toThrow(PairError)

    // the new Mac's daemon connects with the issued key
    const s1 = h.lastSeq()
    h.startWorkerFrom(home2)
    const link = await h.waitEvent(e => e.kind === 'worker_link' && e.worker === 'office' && e.connected === true, s1, T, 'paired worker connected')
    expect(link.worker).toBe('office')
    const st = (await h.api('/api/state')).json
    expect(st.workers.find((w: any) => w.worker === 'office')).toMatchObject({ display_name: '仕事 Mac', connected: true })
    // and the secretary's view of the workers (threads) has both
    expect(st.threads.map((w: any) => w.worker).sort()).toEqual(['local', 'office'])
  }, T)

  test('unknown codes are refused; pair.ts refuses plain http to a remote host', async () => {
    const bad = await fetch(h.url('/pair'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'ZZZZZZZZ', worker: 'x1' }) })
    expect(bad.status).toBe(403)
    expect((await bad.json()).error).toBe('unknown_code')
    const args = await fetch(h.url('/pair'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ worker: 'x1' }) })
    expect(args.status).toBe(400)
    await expect(pair(home2, { hubUrl: 'http://10.0.0.5:8800', code: 'ABCDEFGH', worker: 'w' })).rejects.toThrow(/https/)
    await expect(pair(home2, { hubUrl: 'not a url', code: 'ABCDEFGH', worker: 'w' })).rejects.toThrow(PairError)
  })

  test('cancel removes an open pairing', async () => {
    const r = await h.api('/api/pairing/start', { worker: 'laptop' })
    expect(r.status).toBe(200)
    const c = await h.api('/api/pairing/cancel', { worker: 'laptop' })
    expect(c.json).toEqual({ ok: true, removed: true })
    expect((await h.api('/api/settings')).json.pairing).toEqual([])
    await expect(pair(join(h.dir, 'home4'), { hubUrl: h.url(''), code: r.json.code, worker: 'laptop' })).rejects.toThrow(PairError)
  })
})
