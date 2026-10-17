// 3f settings screen end to end: the real hub + the real worker daemon + the fake Claude Code, driven through the
// WebChat settings API only. A project added in the UI is written to worker.json, shows up in the inventory, is
// usable by the secretary without a restart and survives a worker restart. Fail-closed refusals: nested folders,
// a project with a running PM, a worker that is offline, fields the screen may not change.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, readdirSync, readFileSync, realpathSync } from 'fs'
import { join } from 'path'
import { Harness, type Ev } from '../harness.ts'

const T = 60000
const W = 'local'
let h: Harness
let p1 = ''
let p2 = ''
let pm2 = '' // the PM session of p2
const prompts = { terminal_prompts: { dev_channel_warning: 'auto_accept', workspace_trust: 'auto_accept' } }
const workerFile = () => JSON.parse(readFileSync(join(h.home, 'worker.json'), 'utf8'))
const hubFile = () => JSON.parse(readFileSync(join(h.home, 'hub.json'), 'utf8'))
const inventoryWith = (id: string) => (e: Ev) => e.kind === 'inventory' && e.worker === W && e.projects.some((p: any) => p.id === id)
const projectsArg = () => [
  { id: 'p1', path: p1 },
  { id: 'p2', path: p2, description: 'added in the settings screen', pm: { enabled: true, execution_policy: 'direct_first' } },
]

beforeAll(async () => {
  h = new Harness({
    workerProjects: [{ id: 'p1' }],
    secretaryAutostart: false,
    secretarySession: prompts,
    pmSession: prompts,
    workerSession: prompts,
    hubExtra: { offline_queue: { enabled: true, ttl_minutes: 1440 } },
  })
  p1 = realpathSync(h.projectDirs.p1!)
  p2 = join(h.dir, 'projects', 'p2')
  mkdirSync(join(p2, 'inner'), { recursive: true })
  p2 = realpathSync(p2)
  h.startHub()
  await h.waitHttp()
  h.startWorker()
  await h.waitEvent(e => e.kind === 'worker_link' && e.worker === W && e.connected === true, 0, T, 'worker connected')
  await h.waitEvent(inventoryWith('p1'), 0, T, 'first inventory')
})
afterAll(async () => {
  await h?.cleanup()
})

describe('settings screen (hub + worker + fake claude)', () => {
  test('GET /api/settings shows the editable hub fields, the worker projects with folder and PM settings', async () => {
    const r = await h.api('/api/settings')
    expect(r.status).toBe(200)
    expect(r.json.hub.offline_queue).toEqual({ enabled: true, ttl_minutes: 1440, max_pending_per_worker: 100 })
    expect(r.json.hub.secretary.contexts.max_active).toBeGreaterThan(0)
    expect(r.json.hub.workers).toEqual([{ id: W, display_name: 'テスト Mac', role: 'test worker', connected: true }])
    expect(r.json.worker_projects[W]).toEqual([
      expect.objectContaining({ id: 'p1', path: p1, pm_enabled: true, pm: { enabled: true, autostart: false, execution_policy: 'hybrid', extra_instructions: '' } }),
    ])
    expect(r.json.fixed.listen.editable).toBe(false)
    expect(r.json.paths_known[W]).toBe(true)
    // behind the WebChat token like every other /api route
    expect((await h.api('/api/settings', undefined, 'wrong-token')).status).toBe(401)
    expect((await h.api('/api/settings/hub', { offline_queue: { ttl_minutes: 5 } }, 'wrong-token')).status).toBe(401)
  })

  test('adding a project: worker.json written, inventory updated, the secretary can use it without a restart', async () => {
    const s0 = h.lastSeq()
    const r = await h.api('/api/settings/worker', { worker: W, projects: projectsArg() })
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(r.json.projects.map((p: any) => p.id)).toEqual(['p1', 'p2'])
    expect(r.json.projects[1]).toMatchObject({ path: p2, description: 'added in the settings screen', pm: { execution_policy: 'direct_first' } })
    await h.waitEvent(inventoryWith('p2'), s0, T, 'inventory with p2')
    await h.waitEvent(e => e.kind === 'settings_changed' && e.scope === 'worker' && e.worker === W, s0, T, 'settings_changed')
    const f = workerFile()
    expect(f.projects.map((p: any) => p.id)).toEqual(['p1', 'p2'])
    expect(f.projects[1].path).toBe(p2)
    expect(f.local.port).toBe(h.localPort) // the rest of the file is kept
    expect((await h.api('/api/settings')).json.worker_projects[W].map((p: any) => p.id)).toEqual(['p1', 'p2'])

    await h.send('pm local p2 direct:hello-p2', 'conv-set')
    const rep = await h.waitEvent(e => e.kind === 'worker_report' && e.project === 'p2' && e.text === 'pm did: hello-p2', s0, T, 'p2 PM report')
    expect(rep.role).toBe('pm')
    pm2 = rep.session
    await h.waitEvent(e => e.kind === 'secretary_reply' && e.conv_id === 'conv-set' && String(e.text).startsWith('report: pm did: hello-p2'), s0, T, 'report back in the conversation')
  }, T)

  test('nested folders are refused and nothing is written', async () => {
    const r = await h.api('/api/settings/worker', { worker: W, projects: [...projectsArg(), { id: 'p3', path: join(p2, 'inner') }] })
    expect(r.status).toBe(400)
    expect(r.json).toMatchObject({ ok: false, error: 'bad_args' })
    expect(r.json.message).toContain('「p2」と「p3」')
    const missing = await h.api('/api/settings/worker', { worker: W, projects: [...projectsArg(), { id: 'p4', path: join(h.dir, 'no-such-folder') }] })
    expect(missing.status).toBe(400)
    expect(missing.json.message).toContain('見つかりません')
    expect(workerFile().projects.map((p: any) => p.id)).toEqual(['p1', 'p2'])
  })

  test('removing or moving a project with a running PM is refused with project_in_use', async () => {
    const rm = await h.api('/api/settings/worker', { worker: W, projects: [{ id: 'p1', path: p1 }] })
    expect(rm.status).toBe(400)
    expect(rm.json.error).toBe('project_in_use')
    expect(rm.json.message).toContain('案件「p2」の削除')
    expect(rm.json.message).toContain(pm2.slice(0, 8))
    const mv = await h.api('/api/settings/worker', { worker: W, projects: [{ id: 'p1', path: p1 }, { id: 'p2', path: join(p2, 'inner') }] })
    expect(mv.json.error).toBe('project_in_use')
    expect(workerFile().projects.map((p: any) => p.id)).toEqual(['p1', 'p2'])
    // editing the running project's PM settings is allowed and reported as applying on the next PM start
    const ed = await h.api('/api/settings/worker', { worker: W, projects: [{ id: 'p1', path: p1 }, { id: 'p2', path: p2, pm: { extra_instructions: 'be brief' } }] })
    expect(ed.status).toBe(200)
    expect(ed.json.pm_restart_needed).toEqual(['p2'])
    expect(workerFile().projects[1].pm).toMatchObject({ extra_instructions: 'be brief', execution_policy: 'direct_first' })
  })

  test('worker offline: the worker form is refused; the project survives a worker restart', async () => {
    const s0 = h.lastSeq()
    await h.stopWorker()
    await h.waitEvent(e => e.kind === 'worker_link' && e.worker === W && e.connected === false, s0, T, 'worker disconnected')
    const off = await h.api('/api/settings/worker', { worker: W, projects: projectsArg() })
    expect(off.status).toBe(409)
    expect(off.json.error).toBe('worker_offline')
    expect((await h.api('/api/settings')).json.hub.workers[0].connected).toBe(false)
    const s1 = h.lastSeq()
    h.startWorker()
    await h.waitEvent(e => e.kind === 'worker_link' && e.worker === W && e.connected === true, s1, T, 'worker reconnected')
    const inv = await h.waitEvent(inventoryWith('p2'), s1, T, 'inventory with p2 after restart')
    expect(inv.projects.find((p: any) => p.id === 'p2')).toMatchObject({ pm: { extra_instructions: 'be brief' } })
    const g = (await h.api('/api/settings')).json
    expect(g.paths_known[W]).toBe(true)
    expect(g.worker_projects[W].find((p: any) => p.id === 'p2')).toMatchObject({ path: p2, pm: { extra_instructions: 'be brief' } })
  }, T)

  test('after the PM stopped, the project can be removed; the stopped PM is not resumed for it', async () => {
    const s0 = h.lastSeq()
    const st = await h.api('/api/session/stop', { worker: W, session: pm2 })
    expect(st.status).toBe(200)
    await h.waitEvent(e => e.kind === 'session_state' && e.session === pm2 && ['stopped', 'exited'].includes(e.state), s0, T, 'p2 PM stopped')
    const r = await h.api('/api/settings/worker', { worker: W, projects: [{ id: 'p1', path: p1 }] })
    expect(r.status).toBe(200)
    expect(r.json.projects.map((p: any) => p.id)).toEqual(['p1'])
    expect(workerFile().projects.map((p: any) => p.id)).toEqual(['p1'])
    // a direct resume of the old PM is refused (its project is gone)
    const s1 = h.lastSeq()
    await h.send(`resume local ${pm2}`, 'conv-set')
    const rr = await h.waitEvent(e => e.kind === 'secretary_reply' && e.conv_id === 'conv-set' && String(e.text).startsWith('resume failed'), s1, T, 'resume refused')
    expect(rr.text).toContain('p2')
    expect(h.events().some(e => e.seq > s1 && e.kind === 'session_state' && e.session === pm2 && e.state === 'starting')).toBe(false)
  }, T)

  test('POST /api/settings/hub changes the offline TTL live and on disk; fixed fields are refused', async () => {
    const s0 = h.lastSeq()
    const r = await h.api('/api/settings/hub', { offline_queue: { ttl_minutes: 90 }, workers: [{ id: W, display_name: '仕事用 Mac', role: '仕事' }] })
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(r.json.applies.now).toEqual(expect.arrayContaining(['offline_queue.ttl_minutes', `workers.${W}.display_name`]))
    expect(r.json.applies.next_secretary_start).toEqual(expect.arrayContaining([`workers.${W}.role`]))
    await h.waitEvent(e => e.kind === 'settings_changed' && e.scope === 'hub', s0, T, 'settings_changed hub')
    const g = (await h.api('/api/settings')).json
    expect(g.hub.offline_queue.ttl_minutes).toBe(90)
    expect(g.hub.workers[0]).toMatchObject({ display_name: '仕事用 Mac', role: '仕事' })
    expect((await h.api('/api/state')).json.settings.ttl_minutes).toBe(90)
    const f = hubFile()
    expect(f.offline_queue.ttl_minutes).toBe(90)
    expect(f.workers[0].display_name).toBe('仕事用 Mac')
    expect(f.listen.port).toBe(h.port)
    // project folders are shown in the settings screen but never recorded in the hub's event log
    const all = JSON.stringify(h.events())
    for (const d of [h.dir, p1, p2]) expect(all.includes(d)).toBe(false)
    const bad = await h.api('/api/settings/hub', { listen: { port: 1 } })
    expect(bad.status).toBe(400)
    expect(bad.json.message).toContain('設定画面から変更できません')
    const zero = await h.api('/api/settings/hub', { offline_queue: { ttl_minutes: 0 } })
    expect(zero.status).toBe(400)
    expect(hubFile().offline_queue.ttl_minutes).toBe(90)
  })

  test('persona: saved to hub.json, shown as the name everywhere, and written into the instructions of the next secretary', async () => {
    const g0 = (await h.api('/api/settings')).json
    expect(g0.hub.secretary.persona).toEqual({ name: 'Hannigan', character: '', user_name: null, language: '', verbosity: 'short' })
    expect(g0.hub.secretary.instructions_preview).toContain('You are "Hannigan"')
    expect((await h.api('/api/state')).json.settings.secretary_name).toBe('Hannigan')

    const s0 = h.lastSeq()
    const r = await h.api('/api/settings/hub', {
      secretary: {
        persona: { name: 'ハニガン', character: '敬語で短く。結論を先に。', user_name: '健さん', language: '日本語', verbosity: 'normal' },
        routing_notes: '案件 p1 は自宅の作業',
        extra_instructions: '',
      },
    })
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(r.json.applies.now).toEqual(['secretary.persona.name'])
    expect(r.json.applies.next_secretary_start).toEqual(
      expect.arrayContaining(['secretary.persona.name', 'secretary.persona.character', 'secretary.persona.user_name', 'secretary.persona.language', 'secretary.persona.verbosity', 'secretary.routing_notes']),
    )
    const ev = await h.waitEvent(e => e.kind === 'settings_changed' && e.scope === 'hub' && e.seq > s0, s0, T, 'settings_changed persona')
    expect(JSON.stringify(ev)).not.toContain('敬語') // field names only, never the values
    const f = hubFile()
    expect(f.secretary.persona).toEqual({ name: 'ハニガン', character: '敬語で短く。結論を先に。', user_name: '健さん', language: '日本語', verbosity: 'normal' })
    expect(f.secretary.routing_notes).toBe('案件 p1 は自宅の作業')
    expect(f.secretary.contexts).toEqual(g0 && hubFile().secretary.contexts) // untouched
    const g1 = (await h.api('/api/settings')).json
    expect(g1.hub.secretary.persona.name).toBe('ハニガン')
    expect(g1.hub.secretary.instructions_preview).toContain('You are "ハニガン"')
    expect(g1.hub.secretary.instructions_preview).toContain('案件 p1 は自宅の作業')
    const st = (await h.api('/api/state')).json
    expect(st.settings.secretary_name).toBe('ハニガン')
    expect(st.workers.find((w: any) => w.worker === '_secretary').display_name).toBe('ハニガン')

    // a new conversation starts a new secretary: its channel instructions carry the persona
    const s1 = h.lastSeq()
    await h.send('who are you', 'conv-persona')
    await h.waitEvent(e => e.kind === 'secretary_reply' && e.conv_id === 'conv-persona' && String(e.text).startsWith('hello: who are you'), s1, T, 'new secretary replied')
    const files = readdirSync(h.fakeState).filter(n => n.startsWith('instructions-'))
    const texts = files.map(n => readFileSync(join(h.fakeState, n), 'utf8'))
    const fresh = texts.filter(x => x.includes('You are "ハニガン"'))
    expect(fresh.length).toBe(1)
    expect(fresh[0]).toContain('Your character (how you speak and behave; keep it in every reply):\n敬語で短く。結論を先に。')
    expect(fresh[0]).toContain('Address the person as "健さん".')
    expect(fresh[0]).toContain('Reply in 日本語')
    expect(fresh[0]).toContain('案件 p1 は自宅の作業')
    // the secretary of the older conversation still runs on the old instructions (reported, not swapped silently)
    expect(texts.some(x => x.includes('You are "Hannigan"'))).toBe(true)
    // refused by name; nothing written
    const bad = await h.api('/api/settings/hub', { secretary: { persona: { name: '' } } })
    expect(bad.status).toBe(400)
    expect(bad.json.message).toContain('秘書の名前')
    expect(hubFile().secretary.persona.name).toBe('ハニガン')
  }, T)
})
