#!/usr/bin/env bun
// Phase 3 single-Mac setup (docs/design/01-config-schema.md §8.1): writes hub.json v8, worker.json v2
// and the secrets for one worker on this Mac. Existing files are kept unless --force is given
// (an older version is migrated on the next start). Pairing (Phase 4) replaces the key part.
//
// usage: bun scripts/dev-setup.ts [--worker <id>] [--name <display name>] [--role <text>]
//                                 [--project <id>=<path>]... [--port <hub port>] [--local-port <port>]
//                                 [--pm-off] [--force]
import { existsSync } from 'fs'
import { join } from 'path'
import { expandHome, hanniganHome, HUB_CONFIG_VERSION, HubConfigSchema, WORKER_CONFIG_VERSION, WorkerConfigSchema } from '../shared/config.ts'
import { ensureSecret, newToken, readWorkerKeys, writeSecret } from '../shared/secrets.ts'
import { ensureDir, writeJsonAtomic } from '../shared/util.ts'

const args = process.argv.slice(2)
const opt = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const many = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]!] : []))
const force = args.includes('--force')
const pmOff = args.includes('--pm-off')

const home = ensureDir(hanniganHome())
const workerId = opt('--worker') ?? 'local'
const port = Number(opt('--port') ?? 8800)
const localPort = Number(opt('--local-port') ?? 8801)
const projects = many('--project').map(p => {
  const [id, ...rest] = p.split('=')
  return {
    id: id!,
    path: expandHome(rest.join('=')),
    description: '',
    pm: { enabled: !pmOff, autostart: false, execution_policy: 'hybrid' as const, extra_instructions: '' },
  }
})

const hubFile = join(home, 'hub.json')
if (!existsSync(hubFile) || force) {
  // offline_queue is enabled for local testing only; the OSS default stays false
  const hub = {
    version: HUB_CONFIG_VERSION,
    secretary: {
      autostart: false,
      // who the person talks to (01 §3.1); edited in WebChat 設定. The name is also the WebChat's title.
      persona: { name: 'Hannigan', character: '', user_name: null, language: '', verbosity: 'short' },
      routing_notes: '',
      extra_instructions: '',
      contexts: { mode: 'per_conversation', max_active: 2 },
      shared_ledger: { enabled: true },
    },
    webchat: { conversation_scope: 'conversation', threads: { enabled: true, direct_send_enabled: true } },
    offline_queue: { enabled: true, ttl_minutes: 1440, max_pending_per_worker: 100 },
    discord: { enabled: false },
    listen: { host: '127.0.0.1', port },
    public_url: null,
    workers: [{ id: workerId, display_name: opt('--name') ?? workerId, role: opt('--role') ?? '' }],
  }
  HubConfigSchema.parse(hub) // fail before writing anything invalid
  writeJsonAtomic(hubFile, hub)
  console.log(`wrote ${hubFile}`)
} else console.log(`kept ${hubFile}`)

const workerFile = join(home, 'worker.json')
if (!existsSync(workerFile) || force) {
  const worker = {
    version: WORKER_CONFIG_VERSION,
    worker_id: workerId,
    hub_url: `ws://127.0.0.1:${port}/ws/worker`,
    local: { host: '127.0.0.1', port: localPort },
    projects,
    session: { terminal_prompts: { dev_channel_warning: 'relay' } },
    pm_session: { permission_mode: 'manual' },
    thread_observation: { mode: 'transcript', redact_sensitive: true },
  }
  WorkerConfigSchema.parse(worker)
  writeJsonAtomic(workerFile, worker)
  console.log(`wrote ${workerFile}`)
} else console.log(`kept ${workerFile}`)

ensureSecret(home, 'webchat-token')
const keys = readWorkerKeys(home)
if (!keys[workerId] || force) {
  keys[workerId] = newToken()
  writeSecret(home, 'worker-keys.json', JSON.stringify(keys))
  writeSecret(home, 'worker-key', keys[workerId]!)
  console.log(`wrote worker key for "${workerId}"`)
}
console.log(`\nHANNIGAN_HOME=${home}`)
console.log(`start:   scripts/start.sh`)
console.log(`WebChat: http://127.0.0.1:${port}/#token=$(cat ${join(home, 'secrets', 'webchat-token')})`)
