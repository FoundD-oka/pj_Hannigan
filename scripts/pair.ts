#!/usr/bin/env bun
// Pair this Mac with a hub (04 WP1, 01 §6): present the one-time code issued in WebChat 設定, receive this
// worker's key, and write worker.json (no projects) and secrets/worker-key. No hub.json is written here.
// Then `scripts/start.sh worker` connects over wss:// (hub on the VPS) or ws:// (hub on this Mac / LAN via tunnel).
//
// usage: bun scripts/pair.ts <hub_url> <code> --worker <id> [--local-port <port>] [--force] [--fresh]
//   --force  replace an existing key (re-pairing). An existing worker.json keeps its projects and only gets the new
//            worker_id / hub_url; add --fresh to rewrite it from scratch.
//   hub_url  https://hannigan.example.com (hub on a VPS) or http://127.0.0.1:8800 (hub reachable locally)
//   code     the 8-character code from 設定 → ワーカーを追加 (valid 10 minutes, once)
import { hanniganHome, ID_RE } from '../shared/config.ts'
import { setupWorker, WorkerSetupError, type WorkerSetupResult } from './worker-setup.ts'

export class PairError extends Error {}

export type PairOptions = { hubUrl: string; code: string; worker: string; localPort?: number; force?: boolean; fresh?: boolean; fetchImpl?: typeof fetch }
// default: an existing worker.json keeps its projects and only gets the new worker_id / hub_url; --fresh rewrites it (with --force)
export type PairResult = WorkerSetupResult & { worker: string }

export function pairEndpoint(hubUrl: string): string {
  let u: URL
  try {
    u = new URL(hubUrl)
  } catch {
    throw new PairError(`hub url "${hubUrl}" is not a URL (use https://host or http://127.0.0.1:8800)`)
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new PairError(`hub url must start with https:// or http:// (got ${u.protocol})`)
  if (u.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))
    throw new PairError('plain http:// is only for a hub on this Mac (127.0.0.1); a hub elsewhere must be https://')
  u.pathname = '/pair'
  u.search = ''
  u.hash = ''
  return u.toString()
}

export async function pair(home: string, o: PairOptions): Promise<PairResult> {
  if (!ID_RE.test(o.worker)) throw new PairError(`worker id "${o.worker}": letters, digits, - and _ only (1-32 chars)`)
  const code = o.code.trim()
  if (!code) throw new PairError('the pairing code is empty')
  const f = o.fetchImpl ?? fetch
  let res: Response
  try {
    res = await f(pairEndpoint(o.hubUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, worker: o.worker }),
      signal: AbortSignal.timeout(15000),
    })
  } catch (e) {
    throw new PairError(`could not reach the hub at ${o.hubUrl}: ${(e as Error).message}`)
  }
  let data: { ok?: boolean; key?: string; hub_url?: string; error?: string; message?: string }
  try {
    data = (await res.json()) as typeof data
  } catch {
    throw new PairError(`the hub answered ${res.status} without JSON; is ${o.hubUrl} a Hannigan hub?`)
  }
  if (!res.ok || !data.ok || typeof data.key !== 'string' || typeof data.hub_url !== 'string')
    throw new PairError(`pairing refused (${data.error ?? res.status}): ${data.message ?? 'no details'}`)
  try {
    const r = setupWorker(home, { worker: o.worker, key: data.key, hubUrl: data.hub_url, localPort: o.localPort, force: o.force, keepConfig: !o.fresh })
    if (!r.wroteKey) throw new PairError(`${r.keyFile} already exists and was kept, so the key the hub just issued is NOT stored: run again with --force to replace it`)
    return { ...r, worker: o.worker }
  } catch (e) {
    if (e instanceof WorkerSetupError) throw new PairError(e.message)
    throw e
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const opt = (name: string) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const usage = 'usage: bun scripts/pair.ts <hub_url> <code> --worker <id> [--local-port <port>] [--force] [--fresh]\n'
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(usage)
    process.exit(0)
  }
  const positional = args.filter((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1]!.startsWith('--')))
  const [hubUrl, code] = positional
  const worker = opt('--worker')
  if (!hubUrl || !code || !worker) {
    process.stderr.write(usage)
    process.exit(2)
  }
  const lp = opt('--local-port')
  const home = hanniganHome()
  let r: PairResult
  try {
    r = await pair(home, { hubUrl, code, worker, localPort: lp === undefined ? undefined : Number(lp), force: args.includes('--force'), fresh: args.includes('--fresh') })
  } catch (e) {
    if (e instanceof PairError) {
      process.stderr.write(`pair: ${e.message}\n`)
      process.exit(1)
    }
    throw e
  }
  const out = (s = '') => process.stdout.write(s + '\n')
  out(`paired as worker "${r.worker}"`)
  out(`HANNIGAN_HOME=${home}`)
  out(`${r.wroteConfig ? 'wrote' : 'kept'} ${r.workerFile}${r.wroteConfig ? ` (hub_url ${r.hubUrl}, no projects)` : ' (pass --force to rewrite)'}`)
  out(`${r.wroteKey ? 'wrote' : 'kept'} ${r.keyFile}${r.wroteKey ? '' : ' (pass --force to replace)'}`)
  out()
  out('next: scripts/start.sh worker   (projects are added from WebChat 設定 on the hub side, under this worker)')
  if (r.hubUrl.startsWith('ws://')) out('the hub url is plain ws://, so it must be this Mac or an SSH tunnel to the hub Mac; keep the tunnel open while the worker runs')
}

if (import.meta.main) await main()
