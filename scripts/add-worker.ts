#!/usr/bin/env bun
// Phase 3: register a second Mac's worker on the hub Mac (docs/design/01-config-schema.md §8.1).
// Adds a new key to secrets/worker-keys.json and an entry to hub.json `workers[]`, then prints the
// command to run on the other Mac. The key is printed once and goes to no log or other file.
// hub.json `workers[]` is read at hub start only, so the hub has to be restarted afterwards.
// Since Phase 4 (04 WP1) the normal way is the pairing code from WebChat 設定 → ワーカーを追加 + scripts/pair.ts on
// the other Mac; this script stays for a hub that cannot be reached over the network while pairing.
//
// usage: bun scripts/add-worker.ts --worker <id> [--name <display name>] [--role <text>] [--force]
import { existsSync } from 'fs'
import { join } from 'path'
import { hanniganHome, HUB_CONFIG_VERSION, HubConfigSchema, ID_RE, loadHubConfig } from '../shared/config.ts'
import { newToken, readWorkerKeys, writeSecret } from '../shared/secrets.ts'
import { readJson, writeJsonAtomic } from '../shared/util.ts'
import { lanAddresses, secondMacPrompt } from '../shared/second-mac-prompt.ts'
import { hostname, networkInterfaces, userInfo } from 'os'

export class AddWorkerError extends Error {}

export type AddWorkerOptions = { worker: string; name?: string; role?: string; force?: boolean }
export type AddWorkerResult = {
  key: string // shown once by the caller; never logged
  hubFile: string
  hubPort: number
  display_name: string
  role: string
  replaced: boolean // an existing entry / key was replaced (--force)
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

export function addWorker(home: string, o: AddWorkerOptions): AddWorkerResult {
  const id = o.worker
  if (!ID_RE.test(id)) throw new AddWorkerError(`worker id "${id}": letters, digits, - and _ only (1-32 chars)`)
  const hubFile = join(home, 'hub.json')
  if (!existsSync(hubFile))
    throw new AddWorkerError(`${hubFile} not found. Run this on the hub Mac after its first scripts/start.sh (or scripts/dev-setup.ts).`)
  let raw = readJson<unknown>(hubFile, null)
  if (!isObj(raw)) throw new AddWorkerError(`${hubFile}: not a JSON object`)
  if (raw.version !== HUB_CONFIG_VERSION) {
    // an older file: let the normal loader migrate it on disk (with its backup), then read it again
    loadHubConfig(home)
    raw = readJson<unknown>(hubFile, null)
    if (!isObj(raw) || raw.version !== HUB_CONFIG_VERSION) throw new AddWorkerError(`${hubFile}: could not migrate to version ${HUB_CONFIG_VERSION}`)
  }
  if (raw.workers !== undefined && !Array.isArray(raw.workers)) throw new AddWorkerError(`${hubFile}: workers must be an array`)
  const workers = ((raw.workers ?? []) as unknown[]).map(w => (isObj(w) ? { ...w } : w))
  const at = workers.findIndex(w => isObj(w) && w.id === id)
  const keys = readWorkerKeys(home)
  const exists = at >= 0 || !!keys[id]
  if (exists && !o.force) {
    const where = [at >= 0 ? 'hub.json workers[]' : null, keys[id] ? 'secrets/worker-keys.json' : null].filter(Boolean).join(' and ')
    throw new AddWorkerError(`worker "${id}" already exists in ${where}. Pass --force to issue a new key (the old key stops working).`)
  }
  const prev = at >= 0 ? (workers[at] as Obj) : null
  const display_name = o.name ?? (typeof prev?.display_name === 'string' ? prev.display_name : id)
  const role = o.role ?? (typeof prev?.role === 'string' ? prev.role : '')
  const entry = { ...(prev ?? {}), id, display_name, role }
  if (at >= 0) workers[at] = entry
  else workers.push(entry)
  const next = { ...raw, workers }
  const r = HubConfigSchema.safeParse(next) // fail before writing anything invalid
  if (!r.success) {
    const lines = r.error.issues.map(i => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
    throw new AddWorkerError(`${hubFile}: invalid after adding "${id}" (nothing written)\n${lines.join('\n')}`)
  }
  const key = newToken()
  writeJsonAtomic(hubFile, next) // other keys of the file are kept as they were
  keys[id] = key
  writeSecret(home, 'worker-keys.json', JSON.stringify(keys))
  const listen = isObj(raw.listen) ? raw.listen : {}
  const hubPort = typeof listen.port === 'number' ? listen.port : 8800
  return { key, hubFile, hubPort, display_name, role, replaced: exists }
}

function main(): void {
  const args = process.argv.slice(2)
  const opt = (name: string) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const worker = opt('--worker')
  if (!worker || args.includes('--help') || args.includes('-h')) {
    process.stderr.write('usage: bun scripts/add-worker.ts --worker <id> [--name <display name>] [--role <text>] [--force]\n')
    process.exit(worker ? 0 : 2)
  }
  const home = hanniganHome()
  let r: AddWorkerResult
  try {
    r = addWorker(home, { worker, name: opt('--name'), role: opt('--role'), force: args.includes('--force') })
  } catch (e) {
    if (e instanceof AddWorkerError) {
      process.stderr.write(`add-worker: ${e.message}\n`)
      process.exit(1)
    }
    throw e
  }
  const out = (s = '') => process.stdout.write(s + '\n')
  out(`${r.replaced ? 'replaced' : 'added'} worker "${worker}" (display_name "${r.display_name}"${r.role ? `, role "${r.role}"` : ''}) in ${r.hubFile}`)
  out(`${r.replaced ? 'replaced' : 'added'} its key in ${join(home, 'secrets', 'worker-keys.json')}`)
  out()
  out('1. restart the hub on this Mac (workers[] is read at start; stop.sh also stops this Mac\'s worker, so start both again):')
  out('     scripts/stop.sh && scripts/start.sh')
  out()
  out('2. on the other Mac, open Claude Code and paste the prompt below (it contains the key; it is shown only this once,')
  out('   is stored in secrets/worker-keys.json on this Mac and goes to no log). Claude there clones the repository, runs')
  out('   worker-setup.ts, opens the SSH tunnel and starts the worker. Without Claude, run the commands in the prompt yourself.')
  out()
  const hn = hostname()
  out('----- 8< ----- paste into Claude Code on the other Mac -----')
  out(secondMacPrompt({ worker, credential: { kind: 'key', key: r.key }, hubPort: r.hubPort, hubHost: hn.includes('.') ? hn : `${hn}.local`, hubUser: userInfo().username, hubAddresses: lanAddresses(networkInterfaces() as Parameters<typeof lanAddresses>[0]), pairUrl: `http://127.0.0.1:${r.hubPort}` }))
  out('----- 8< -----')
}

if (import.meta.main) main()
