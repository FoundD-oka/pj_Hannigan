#!/usr/bin/env bun
// Phase 3: set up a second Mac as a worker only (docs/design/01-config-schema.md §8.1). Writes worker.json
// (no projects; add them in WebChat 設定) and secrets/worker-key with the key that scripts/add-worker.ts
// issued on the hub Mac. No hub.json is written: this Mac runs `scripts/start.sh worker` only and reaches
// the hub through an SSH tunnel to the hub Mac's 127.0.0.1:<hub port> (ws:// is never exposed to the LAN).
// Existing files are kept unless --force is given. Pairing codes (Phase 4) replace this script.
//
// usage: bun scripts/worker-setup.ts --worker <id> --key <key> [--hub-port <port>] [--local-port <port>] [--force]
//   --hub-port   port the hub listens on (hub.json listen.port, default 8800); the tunnel uses it on both ends
//   --local-port this worker's own local port (worker.json local.port, default 8801)
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { hanniganHome, ID_RE, WORKER_CONFIG_VERSION, WorkerConfigSchema } from '../shared/config.ts'
import { readSecret, secretPath, writeSecret } from '../shared/secrets.ts'
import { ensureDir, writeJsonAtomic } from '../shared/util.ts'

export class WorkerSetupError extends Error {}

export type WorkerSetupOptions = {
  worker: string
  key: string
  hubPort?: number
  localPort?: number
  force?: boolean // overwrite an existing worker.json / key
  hubUrl?: string // full ws(s) url (pairing); overrides hubPort
  keepConfig?: boolean // an existing worker.json is kept and only worker_id / hub_url are rewritten (projects stay); the key still needs force
}
export type WorkerSetupResult = {
  workerFile: string
  keyFile: string
  wroteConfig: boolean // false: an existing worker.json was kept
  wroteKey: boolean // false: an existing secrets/worker-key was kept
  hubPort: number
  hubUrl: string
}

const port = (name: string, v: number | undefined, dflt: number): number => {
  const p = v ?? dflt
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new WorkerSetupError(`${name} must be a port number (1-65535)`)
  return p
}

export function setupWorker(home: string, o: WorkerSetupOptions): WorkerSetupResult {
  if (!ID_RE.test(o.worker)) throw new WorkerSetupError(`worker id "${o.worker}": letters, digits, - and _ only (1-32 chars)`)
  const key = o.key.trim()
  if (!key || /\s/.test(key)) throw new WorkerSetupError('--key must be the key issued by the hub (no spaces)')
  const hubPort = port('--hub-port', o.hubPort, 8800)
  const localPort = port('--local-port', o.localPort, 8801)
  ensureDir(home)
  if (o.hubUrl !== undefined && !/^wss?:\/\/[^\s]+\/ws\/worker$/.test(o.hubUrl)) throw new WorkerSetupError(`hub url "${o.hubUrl}" must be ws(s)://host[:port]/ws/worker`)
  const hubUrl = o.hubUrl ?? `ws://127.0.0.1:${hubPort}/ws/worker`
  const workerFile = join(home, 'worker.json')
  let wroteConfig = false
  if (existsSync(workerFile) && o.keepConfig) {
    // re-pointing a Mac that already has projects (e.g. hub moved to the VPS): keep everything but the identity and the hub
    let cur: Record<string, unknown>
    try {
      cur = JSON.parse(readFileSync(workerFile, 'utf8')) as Record<string, unknown>
    } catch (e) {
      throw new WorkerSetupError(`${workerFile} is not valid JSON (${(e as Error).message}); fix it or pass --force to rewrite`)
    }
    const next = { ...cur, worker_id: o.worker, hub_url: hubUrl }
    const v = WorkerConfigSchema.safeParse(next)
    if (!v.success) throw new WorkerSetupError(`${workerFile} would be invalid after the change: ${v.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
    writeJsonAtomic(workerFile, next)
    wroteConfig = true
  } else if (!existsSync(workerFile) || o.force) {
    const worker = {
      version: WORKER_CONFIG_VERSION,
      worker_id: o.worker,
      hub_url: hubUrl,
      local: { host: '127.0.0.1', port: localPort },
      projects: [],
      session: { terminal_prompts: { dev_channel_warning: 'relay' } },
      pm_session: { permission_mode: 'manual' },
      thread_observation: { mode: 'transcript', redact_sensitive: true },
    }
    WorkerConfigSchema.parse(worker) // fail before writing anything invalid
    writeJsonAtomic(workerFile, worker)
    wroteConfig = true
  }
  let wroteKey = false
  if (readSecret(home, 'worker-key') == null || o.force) {
    writeSecret(home, 'worker-key', key)
    wroteKey = true
  }
  return { workerFile, keyFile: secretPath(home, 'worker-key'), wroteConfig, wroteKey, hubPort, hubUrl }
}

function main(): void {
  const args = process.argv.slice(2)
  const opt = (name: string) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const usage = 'usage: bun scripts/worker-setup.ts --worker <id> --key <key> [--hub-port <port>] [--local-port <port>] [--force]\n'
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(usage)
    process.exit(0)
  }
  const worker = opt('--worker')
  const key = opt('--key')
  if (!worker || !key) {
    process.stderr.write(usage)
    process.exit(2)
  }
  const num = (name: string) => {
    const v = opt(name)
    return v === undefined ? undefined : Number(v)
  }
  const home = hanniganHome()
  let r: WorkerSetupResult
  try {
    r = setupWorker(home, { worker, key, hubPort: num('--hub-port'), localPort: num('--local-port'), force: args.includes('--force') })
  } catch (e) {
    if (e instanceof WorkerSetupError) {
      process.stderr.write(`worker-setup: ${e.message}\n`)
      process.exit(1)
    }
    throw e
  }
  const out = (s = '') => process.stdout.write(s + '\n')
  out(`HANNIGAN_HOME=${home}`)
  out(`${r.wroteConfig ? 'wrote' : 'kept'} ${r.workerFile}${r.wroteConfig ? ` (worker_id "${worker}", hub_url ${r.hubUrl}, no projects)` : ' (pass --force to rewrite)'}`)
  out(`${r.wroteKey ? 'wrote' : 'kept'} ${r.keyFile}${r.wroteKey ? '' : ' (pass --force to replace)'}`)
  out()
  out('next, on this Mac:')
  out('1. on the hub Mac, enable Remote Login (System Settings > General > Sharing > Remote Login) so this Mac can ssh in.')
  out(`2. open the SSH tunnel and keep it open while the worker runs (the hub's ws:// stays on 127.0.0.1 of both Macs):`)
  out(`     ssh -N -L ${r.hubPort}:127.0.0.1:${r.hubPort} <user>@<hub-mac>`)
  out('   (<user>@<hub-mac>: the login name and host name / IP of the hub Mac, e.g. taro@studio.local)')
  out('3. in another terminal, start the worker (this Mac needs no hub.json):')
  out('     scripts/start.sh worker')
  out('   projects are added from WebChat 設定 on the hub side, under this worker.')
}

if (import.meta.main) main()
