// Test harness: an isolated HANNIGAN_HOME with hub + worker processes and helpers to drive WebChat's API.
import type { Subprocess } from 'bun'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { newToken, writeSecret } from '../shared/secrets.ts'
import { spawnSync } from 'child_process'

export const REPO = join(import.meta.dir, '..')
export type Ev = { seq: number; ts: string; kind: string; [k: string]: any }

export type ProjectPmOptions = { enabled?: boolean; autostart?: boolean; execution_policy?: 'delegate_only' | 'hybrid' | 'direct_first'; extra_instructions?: string }
export type WorkerProjectOptions = {
  id: string
  path?: string // default: <tmp>/projects/<id> (created)
  description?: string
  pm?: ProjectPmOptions | false // false: pm.enabled=false; omitted: schema defaults (enabled, hybrid)
}

export type HarnessOptions = {
  claudeBin?: string // default: fake claude wrapper
  workerId?: string
  projects?: string[] // project ids; folders are created under the temp dir (ignored when workerProjects is given)
  projectPaths?: Record<string, string>
  workerProjects?: WorkerProjectOptions[] // full control over worker.json projects[] incl. pm
  workerSession?: Record<string, unknown> // deep-merged into worker.json session
  pmSession?: Record<string, unknown> // deep-merged into worker.json pm_session
  secretarySession?: Record<string, unknown> // deep-merged into hub.json secretary.session
  secretaryAutostart?: boolean // default true: keeps the Phase 2 single-secretary start for existing e2e tests
  hubExtra?: Record<string, unknown> // deep-merged into hub.json last
  workerExtra?: Record<string, unknown> // deep-merged into worker.json last
  env?: Record<string, string> // added to every session env (secretary, pm, task)
  home?: string
}

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
// objects merge recursively; arrays and scalars from b replace a
export function deepMerge<T extends Record<string, unknown>>(a: T, b: Record<string, unknown> | undefined): T {
  if (!b) return a
  const out: Record<string, unknown> = { ...a }
  for (const [k, v] of Object.entries(b)) out[k] = isPlain(v) && isPlain(out[k]) ? deepMerge(out[k] as Record<string, unknown>, v) : v
  return out as T
}

export class Harness {
  home: string
  dir: string
  port: number
  localPort: number
  prefix: string
  token: string
  workerId: string
  projectDirs: Record<string, string> = {}
  hub: Subprocess | null = null
  worker: Subprocess | null = null
  fakeState: string

  constructor(private o: HarnessOptions = {}) {
    this.dir = mkdtempSync(join(tmpdir(), 'hannigan-test-'))
    this.home = o.home ?? join(this.dir, 'home')
    mkdirSync(this.home, { recursive: true })
    this.port = 20000 + Math.floor(Math.random() * 20000)
    this.localPort = this.port + 1
    this.prefix = 'hnt' + Math.random().toString(36).slice(2, 6)
    this.workerId = o.workerId ?? 'local'
    this.fakeState = join(this.dir, 'fake-state')
    mkdirSync(this.fakeState, { recursive: true })
    let claudeBin = o.claudeBin
    if (!claudeBin) {
      claudeBin = join(this.dir, 'fake-claude')
      writeFileSync(claudeBin, `#!/bin/sh\nexec bun ${JSON.stringify(join(REPO, 'test', 'fake-claude.ts'))} "$@"\n`)
      chmodSync(claudeBin, 0o755)
    }
    const projects: WorkerProjectOptions[] = o.workerProjects ?? (o.projects ?? ['p1']).map(id => ({ id, path: o.projectPaths?.[id] }))
    const projectEntries = projects.map(p => {
      const d = p.path ?? join(this.dir, 'projects', p.id)
      mkdirSync(d, { recursive: true })
      this.projectDirs[p.id] = d
      return {
        id: p.id,
        path: d,
        description: p.description ?? `test project ${p.id}`,
        ...(p.pm === false ? { pm: { enabled: false } } : p.pm ? { pm: p.pm } : {}),
      }
    })
    const fakeEnv = { FAKE_CLAUDE_STATE: this.fakeState, ...(o.env ?? {}) }
    // hub.json v8 / worker.json v2 (docs/design/01-config-schema.md §3, §4)
    const hub = deepMerge(
      {
        version: 8,
        listen: { host: '127.0.0.1', port: this.port },
        tmux: { prefix: this.prefix },
        claude_bin: claudeBin,
        secretary: {
          autostart: o.secretaryAutostart ?? true,
          session: deepMerge({ builtin_tools: '', allowed_tools: ['mcp__hannigan'], env: fakeEnv }, o.secretarySession),
        },
        discord: { enabled: false },
        workers: [{ id: this.workerId, display_name: 'テスト Mac', role: 'test worker' }],
      },
      o.hubExtra,
    )
    writeFileSync(join(this.home, 'hub.json'), JSON.stringify(hub))
    const worker = deepMerge(
      {
        version: 2,
        worker_id: this.workerId,
        hub_url: `ws://127.0.0.1:${this.port}/ws/worker`,
        local: { host: '127.0.0.1', port: this.localPort },
        projects: projectEntries,
        tmux: { prefix: this.prefix },
        claude_bin: claudeBin,
        session: deepMerge({ env: fakeEnv }, o.workerSession),
        pm_session: deepMerge({ env: fakeEnv }, o.pmSession),
      },
      o.workerExtra,
    )
    writeFileSync(join(this.home, 'worker.json'), JSON.stringify(worker))
    this.token = newToken()
    writeSecret(this.home, 'webchat-token', this.token)
    const key = newToken()
    writeSecret(this.home, 'worker-keys.json', JSON.stringify({ [this.workerId]: key }))
    writeSecret(this.home, 'worker-key', key)
  }

  private spawn(script: string, name: string): Subprocess {
    return Bun.spawn(['bun', join(REPO, script)], {
      env: { ...process.env, HANNIGAN_HOME: this.home, HANNIGAN_CLAUDE_PROJECTS_ROOT: join(this.fakeState, 'projects') },
      stdout: Bun.file(join(this.dir, `${name}.out.log`)),
      stderr: Bun.file(join(this.dir, `${name}.log`)),
    })
  }
  startHub(): void {
    this.hub = this.spawn('hub/hub.ts', `hub-${Date.now()}`)
  }
  startWorker(): void {
    this.worker = this.spawn('worker/daemon.ts', `worker-${Date.now()}`)
  }
  // a second worker daemon with its own HANNIGAN_HOME (e.g. one that paired itself); killed by cleanup()
  extraWorkers: Subprocess[] = []
  startWorkerFrom(home: string): Subprocess {
    const p = Bun.spawn(['bun', join(REPO, 'worker/daemon.ts')], {
      env: { ...process.env, HANNIGAN_HOME: home, HANNIGAN_CLAUDE_PROJECTS_ROOT: join(this.fakeState, 'projects') },
      stdout: Bun.file(join(this.dir, `worker2-${Date.now()}.out.log`)),
      stderr: Bun.file(join(this.dir, `worker2-${Date.now()}.log`)),
    })
    this.extraWorkers.push(p)
    return p
  }
  async stopHub(): Promise<void> {
    this.hub?.kill()
    await this.hub?.exited
    this.hub = null
  }
  async stopWorker(): Promise<void> {
    this.worker?.kill()
    await this.worker?.exited
    this.worker = null
  }

  events(): Ev[] {
    const f = join(this.home, 'hub', 'events.jsonl')
    if (!existsSync(f)) return []
    return readFileSync(f, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as Ev)
  }
  lastSeq(): number {
    const e = this.events()
    return e.length ? e[e.length - 1]!.seq : 0
  }
  async waitEvent(pred: (e: Ev) => boolean, after = 0, timeoutMs = 30000, what = 'event'): Promise<Ev> {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      const hit = this.events().find(e => e.seq > after && pred(e))
      if (hit) return hit
      await Bun.sleep(200)
    }
    throw new Error(`timeout waiting for ${what} after seq ${after}\nlast events:\n${this.events().slice(-15).map(e => JSON.stringify(e)).join('\n')}`)
  }

  url(p: string): string {
    return `http://127.0.0.1:${this.port}${p}`
  }
  async api(path: string, body?: unknown, token = this.token): Promise<{ status: number; json: any }> {
    const r = await fetch(this.url(path), {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    return { status: r.status, json: await r.json().catch(() => null) }
  }
  async waitHttp(timeoutMs = 15000): Promise<void> {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      try {
        if ((await fetch(this.url('/health'))).ok) return
      } catch {}
      await Bun.sleep(200)
    }
    throw new Error('hub did not start')
  }
  send(text: string, conv = 'conv-test', msg_id = 'm' + Math.random().toString(36).slice(2, 10)) {
    return this.api('/api/send', { conv_id: conv, msg_id, text })
  }
  // answer the next approval matching pred with choice
  async answer(pred: (e: Ev) => boolean, choice: string | number, after = 0, timeoutMs = 30000): Promise<Ev> {
    const ap = await this.waitEvent(e => e.kind === 'approval_open' && pred(e), after, timeoutMs, 'approval_open')
    const r = await this.api('/api/answer', { approval_id: ap.approval_id, choice })
    if (r.status !== 200) throw new Error(`answer failed: ${JSON.stringify(r.json)}`)
    return ap
  }
  tmuxSessions(): string[] {
    const r = spawnSync('tmux', ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' })
    return (r.stdout ?? '').split('\n').filter(s => s.startsWith(this.prefix + '-'))
  }
  capture(name: string): string {
    return spawnSync('tmux', ['capture-pane', '-p', '-t', `=${name}:`], { encoding: 'utf8' }).stdout ?? ''
  }
  async cleanup(): Promise<void> {
    for (const p of this.extraWorkers) {
      p.kill()
      await p.exited
    }
    this.extraWorkers = []
    await this.stopWorker()
    await this.stopHub()
    for (const s of this.tmuxSessions()) spawnSync('tmux', ['kill-session', '-t', `=${s}`])
  }
}
