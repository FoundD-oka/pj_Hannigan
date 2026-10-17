// scripts/add-worker.ts (hub Mac) and scripts/worker-setup.ts (second Mac): Phase 3 two-Mac setup (01 §8.1)
import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { addWorker, AddWorkerError } from '../../scripts/add-worker.ts'
import { setupWorker, WorkerSetupError } from '../../scripts/worker-setup.ts'
import { loadHubConfig, loadWorkerConfig } from '../../shared/config.ts'
import { readSecret, readWorkerKeys, safeEqual, writeSecret } from '../../shared/secrets.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'hn-2mac-'))
const readBack = (f: string) => JSON.parse(readFileSync(f, 'utf8'))
const mode = (f: string) => statSync(f).mode & 0o777

// a hub Mac after dev-setup: one worker "local" with its key, plus settings that must survive untouched
function hubMac(): string {
  const home = tmp()
  const hub = {
    version: 8,
    secretary: { autostart: false, persona: { name: 'Hannigan', character: 'cheerful', user_name: 'Ken', language: '', verbosity: 'short' }, routing_notes: 'notes は home', contexts: { mode: 'per_conversation', max_active: 2 }, shared_ledger: { enabled: true } },
    webchat: { conversation_scope: 'conversation', threads: { enabled: true, direct_send_enabled: true } },
    offline_queue: { enabled: true, ttl_minutes: 1440, max_pending_per_worker: 100 },
    discord: { enabled: false },
    listen: { host: '127.0.0.1', port: 8900 },
    public_url: null,
    workers: [{ id: 'local', display_name: 'この Mac', role: '私用' }],
  }
  writeFileSync(join(home, 'hub.json'), JSON.stringify(hub, null, 2) + '\n')
  writeSecret(home, 'worker-keys.json', JSON.stringify({ local: 'a'.repeat(64) }))
  writeSecret(home, 'webchat-token', 'b'.repeat(64))
  return home
}

const errOf = <E>(fn: () => unknown, cls: new (...a: never[]) => E): string => {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(cls)
    return (e as Error).message
  }
  throw new Error('expected an error')
}

// ---------------------------------------------------------------- add-worker
test('add-worker: adds a key and a workers[] entry, keeps everything else in hub.json', () => {
  const home = hubMac()
  const before = readBack(join(home, 'hub.json'))
  const r = addWorker(home, { worker: 'lime', name: 'Lime', role: '別の Mac' })
  expect(r.key).toMatch(/^[0-9a-f]{64}$/)
  expect(r.replaced).toBe(false)
  expect(r.hubPort).toBe(8900) // from listen.port, for the command it prints
  // the key is in worker-keys.json (mode 600), the old key is untouched
  const keys = readWorkerKeys(home)
  expect(keys).toEqual({ local: 'a'.repeat(64), lime: r.key })
  expect(mode(join(home, 'secrets', 'worker-keys.json'))).toBe(0o600)
  // hub.json: the new entry is appended, nothing else changed
  const after = readBack(join(home, 'hub.json'))
  expect(after.workers).toEqual([
    { id: 'local', display_name: 'この Mac', role: '私用' },
    { id: 'lime', display_name: 'Lime', role: '別の Mac' },
  ])
  const { workers: _b, ...restBefore } = before
  const { workers: _a, ...restAfter } = after
  expect(restAfter).toEqual(restBefore)
  // it still loads as a valid v8 config (what the hub does at start)
  const cfg = loadHubConfig(home)
  expect(cfg.migration).toBeNull()
  expect(cfg.workers.map(w => w.id)).toEqual(['local', 'lime'])
  expect(cfg.secretary.persona.character).toBe('cheerful')
  expect(cfg.listen.port).toBe(8900)
  // the key is not written anywhere else under HANNIGAN_HOME
  for (const f of ['hub.json', 'secrets/webchat-token']) expect(readFileSync(join(home, f), 'utf8')).not.toContain(r.key)
})

test('add-worker: defaults display_name to the id and role to empty', () => {
  const home = hubMac()
  const r = addWorker(home, { worker: 'kabosu' })
  expect(r.display_name).toBe('kabosu')
  expect(r.role).toBe('')
  expect(readBack(join(home, 'hub.json')).workers[1]).toEqual({ id: 'kabosu', display_name: 'kabosu', role: '' })
})

test('add-worker: refuses an existing id without --force and changes nothing', () => {
  const home = hubMac()
  const hubBefore = readFileSync(join(home, 'hub.json'), 'utf8')
  const keysBefore = readFileSync(join(home, 'secrets', 'worker-keys.json'), 'utf8')
  const msg = errOf(() => addWorker(home, { worker: 'local', name: 'x' }), AddWorkerError)
  expect(msg).toContain('"local" already exists')
  expect(msg).toContain('--force')
  expect(readFileSync(join(home, 'hub.json'), 'utf8')).toBe(hubBefore)
  expect(readFileSync(join(home, 'secrets', 'worker-keys.json'), 'utf8')).toBe(keysBefore)
  // an id that only has a key (hub.json entry removed by hand) is also "existing"
  writeSecret(home, 'worker-keys.json', JSON.stringify({ local: 'a'.repeat(64), ghost: 'c'.repeat(64) }))
  expect(errOf(() => addWorker(home, { worker: 'ghost' }), AddWorkerError)).toContain('secrets/worker-keys.json')
})

test('add-worker: --force issues a new key and keeps the entry in place with its old name and role', () => {
  const home = hubMac()
  addWorker(home, { worker: 'lime', name: 'Lime', role: '別の Mac' })
  const r = addWorker(home, { worker: 'local', force: true })
  expect(r.replaced).toBe(true)
  expect(r.key).not.toBe('a'.repeat(64))
  expect(readWorkerKeys(home).local).toBe(r.key)
  const workers = readBack(join(home, 'hub.json')).workers
  expect(workers.map((w: { id: string }) => w.id)).toEqual(['local', 'lime'])
  expect(workers[0]).toEqual({ id: 'local', display_name: 'この Mac', role: '私用' })
  // --name / --role given with --force replace the old values
  addWorker(home, { worker: 'local', force: true, name: 'Studio', role: '母艦' })
  expect(readBack(join(home, 'hub.json')).workers[0]).toEqual({ id: 'local', display_name: 'Studio', role: '母艦' })
})

test('add-worker: refuses a bad id or a missing hub.json without writing', () => {
  const home = hubMac()
  expect(errOf(() => addWorker(home, { worker: 'bad id!' }), AddWorkerError)).toContain('letters, digits')
  expect(readWorkerKeys(home)).toEqual({ local: 'a'.repeat(64) })
  const empty = tmp()
  expect(errOf(() => addWorker(empty, { worker: 'lime' }), AddWorkerError)).toContain('hub.json not found')
  expect(existsSync(join(empty, 'secrets', 'worker-keys.json'))).toBe(false)
})

test('add-worker: migrates an older hub.json first (backup kept) and then adds the worker', () => {
  const home = hubMac()
  writeFileSync(join(home, 'hub.json'), JSON.stringify({ version: 1, listen: { port: 8900 }, workers: [{ id: 'local' }] }))
  addWorker(home, { worker: 'lime' })
  const after = readBack(join(home, 'hub.json'))
  expect(after.version).toBe(8)
  expect(after.workers.map((w: { id: string }) => w.id)).toEqual(['local', 'lime'])
  expect(after.listen.port).toBe(8900)
})

// ---------------------------------------------------------------- worker-setup
test('worker-setup: writes worker.json (no projects, tunnel URL) and secrets/worker-key, no hub.json', () => {
  const home = join(tmp(), 'hannigan') // not yet created: the script creates it
  const r = setupWorker(home, { worker: 'lime', key: 'd'.repeat(64), hubPort: 8900 })
  expect(r.wroteConfig).toBe(true)
  expect(r.wroteKey).toBe(true)
  expect(r.hubUrl).toBe('ws://127.0.0.1:8900/ws/worker')
  const cfg = loadWorkerConfig(home) // what the worker daemon does at start
  expect(cfg.migration).toBeNull()
  expect(cfg.worker_id).toBe('lime')
  expect(cfg.hub_url).toBe('ws://127.0.0.1:8900/ws/worker')
  expect(cfg.projects).toEqual([])
  expect(cfg.local).toEqual({ host: '127.0.0.1', port: 8801 })
  expect(cfg.pm_session.permission_mode).toBe('manual')
  expect(readSecret(home, 'worker-key')).toBe('d'.repeat(64))
  expect(mode(join(home, 'secrets', 'worker-key'))).toBe(0o600)
  expect(mode(join(home, 'secrets'))).toBe(0o700)
  expect(existsSync(join(home, 'hub.json'))).toBe(false)
  expect(existsSync(join(home, 'secrets', 'webchat-token'))).toBe(false)
  expect(existsSync(join(home, 'secrets', 'worker-keys.json'))).toBe(false)
})

test('worker-setup: defaults (8800 / 8801) and --local-port', () => {
  const home = tmp()
  expect(setupWorker(home, { worker: 'lime', key: 'k1' }).hubUrl).toBe('ws://127.0.0.1:8800/ws/worker')
  const other = tmp()
  setupWorker(other, { worker: 'lime', key: 'k1', localPort: 8811 })
  expect(readBack(join(other, 'worker.json')).local).toEqual({ host: '127.0.0.1', port: 8811 })
})

test('worker-setup: keeps existing files without --force, replaces them with --force', () => {
  const home = tmp()
  setupWorker(home, { worker: 'lime', key: 'k1', hubPort: 8900 })
  const r = setupWorker(home, { worker: 'other', key: 'k2', hubPort: 8800 })
  expect(r.wroteConfig).toBe(false)
  expect(r.wroteKey).toBe(false)
  expect(readBack(join(home, 'worker.json')).worker_id).toBe('lime')
  expect(readSecret(home, 'worker-key')).toBe('k1')
  const f = setupWorker(home, { worker: 'other', key: 'k2', hubPort: 8800, force: true })
  expect(f.wroteConfig).toBe(true)
  expect(f.wroteKey).toBe(true)
  expect(readBack(join(home, 'worker.json')).worker_id).toBe('other')
  expect(readBack(join(home, 'worker.json')).hub_url).toBe('ws://127.0.0.1:8800/ws/worker')
  expect(readSecret(home, 'worker-key')).toBe('k2')
})

test('worker-setup: refuses a bad id, an empty key or a bad port without writing', () => {
  const home = tmp()
  expect(errOf(() => setupWorker(home, { worker: 'no spaces', key: 'k' }), WorkerSetupError)).toContain('letters, digits')
  expect(errOf(() => setupWorker(home, { worker: 'lime', key: '  ' }), WorkerSetupError)).toContain('--key')
  expect(errOf(() => setupWorker(home, { worker: 'lime', key: 'k', hubPort: 70000 }), WorkerSetupError)).toContain('--hub-port')
  expect(errOf(() => setupWorker(home, { worker: 'lime', key: 'k', localPort: Number.NaN }), WorkerSetupError)).toContain('--local-port')
  expect(existsSync(join(home, 'worker.json'))).toBe(false)
  expect(existsSync(join(home, 'secrets', 'worker-key'))).toBe(false)
})

// ---------------------------------------------------------------- the two together
test('the key add-worker issues on the hub Mac is what the hub checks against the second Mac\'s worker-key', () => {
  const hub = hubMac()
  const second = tmp()
  const { key } = addWorker(hub, { worker: 'lime', name: 'Lime' })
  setupWorker(second, { worker: 'lime', key, hubPort: 8900 })
  // hub/hub.ts workerHello: readWorkerKeys(home)[worker_id] compared with safeEqual to the hello's key
  const expected = readWorkerKeys(hub)['lime']!
  expect(safeEqual(readSecret(second, 'worker-key')!, expected)).toBe(true)
  expect(safeEqual(readSecret(second, 'worker-key')!, readWorkerKeys(hub)['local']!)).toBe(false)
})
