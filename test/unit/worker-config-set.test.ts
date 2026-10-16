// config_set planning on the worker (3f settings screen): validation, canonical folders, in-use refusal.
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { WorkerConfigSchema, type ProjectConfig } from '../../shared/config.ts'
import { CommandError } from '../../shared/protocol.ts'
import { displayPath, planConfigSet, projectInfo, type SessionView } from '../../worker/config-set.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'hn-cfgset-')))
const dir = (name: string) => {
  const d = join(root, name)
  mkdirSync(d, { recursive: true })
  return d
}
const raw = (projects: unknown[] = []) => ({ version: 2, worker_id: 'local', projects, max_sessions: 3, unknown_key_kept: 1 })
const cur = (id: string, path: string, pm: Partial<ProjectConfig['pm']> = {}): ProjectConfig => ({
  id,
  path,
  description: `desc ${id}`,
  pm: { enabled: true, autostart: false, execution_policy: 'hybrid', extra_instructions: '', ...pm },
})
const sess = (project: string, state: SessionView['state'], role: SessionView['role'] = 'pm'): SessionView => ({
  key: `${project}-${role}-0123456789`,
  project,
  role,
  name: `${project} ${role}`,
  state,
})
const err = (fn: () => unknown): CommandError => {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(CommandError)
    return e as CommandError
  }
  throw new Error('expected a CommandError')
}

test('adds a project: canonical path, defaults, whole file kept and valid', () => {
  const a = dir('a')
  const link = join(root, 'link-a')
  symlinkSync(a, link)
  const plan = planConfigSet({ projects: [{ id: 'a', path: link }] }, [], [], raw())
  expect(plan.projects).toEqual([{ id: 'a', path: a, description: '', pm: { enabled: true, autostart: false, execution_policy: 'hybrid', extra_instructions: '' } }])
  expect(plan.file.max_sessions).toBe(3)
  expect(plan.file.unknown_key_kept).toBe(1)
  expect(WorkerConfigSchema.safeParse(plan.file).success).toBe(true)
  expect(plan.pmRestartNeeded).toEqual([])
  expect(projectInfo(plan.projects[0]!, true)).toMatchObject({ id: 'a', path: a, pm_enabled: true, execution_policy: 'hybrid', pm: { enabled: true } })
  // inventory events carry no folder (local paths stay off the hub's event log)
  expect(projectInfo(plan.projects[0]!)).not.toHaveProperty('path')
})

test('omitted description / pm fields keep the current values', () => {
  const a = dir('keep')
  const plan = planConfigSet(
    { projects: [{ id: 'keep', path: a, pm: { execution_policy: 'delegate_only' } }] },
    [cur('keep', a, { extra_instructions: 'be careful', autostart: true })],
    [],
    raw(),
  )
  expect(plan.projects[0]).toMatchObject({ description: 'desc keep', pm: { execution_policy: 'delegate_only', extra_instructions: 'be careful', autostart: true, enabled: true } })
})

test('refuses a missing folder, a file, a relative path and a bad id', () => {
  expect(err(() => planConfigSet({ projects: [{ id: 'x', path: join(root, 'nope') }] }, [], [], raw())).message).toContain('見つかりません')
  const f = join(root, 'file.txt')
  writeFileSync(f, 'x')
  expect(err(() => planConfigSet({ projects: [{ id: 'x', path: f }] }, [], [], raw())).message).toContain('フォルダではありません')
  expect(err(() => planConfigSet({ projects: [{ id: 'x', path: 'rel/dir' }] }, [], [], raw())).message).toContain('/ か ~')
  const e = err(() => planConfigSet({ projects: [{ id: 'bad id!', path: dir('b') }] }, [], [], raw()))
  expect(e.code).toBe('bad_args')
  expect(e.message).toContain('bad id!')
})

test('refuses duplicate ids and same / nested folders', () => {
  const p = dir('dup')
  expect(err(() => planConfigSet({ projects: [{ id: 'd', path: p }, { id: 'd', path: dir('dup2') }] }, [], [], raw())).message).toContain('重複')
  const inner = dir('dup/inner')
  const e = err(() => planConfigSet({ projects: [{ id: 'outer', path: p }, { id: 'inner', path: inner }] }, [], [], raw()))
  expect(e.code).toBe('bad_args')
  expect(e.message).toContain('「outer」と「inner」')
  expect(err(() => planConfigSet({ projects: [{ id: 'one', path: p }, { id: 'two', path: p }] }, [], [], raw())).message).toContain('同じか')
})

test('refuses removing or moving a project with a live session (project_in_use), names the session', () => {
  const a = dir('busy')
  const b = dir('busy2')
  const current = [cur('busy', a)]
  const live = [sess('busy', 'ready', 'pm'), sess('busy', 'working', 'task')]
  const rm = err(() => planConfigSet({ projects: [] }, current, live, raw()))
  expect(rm.code).toBe('project_in_use')
  expect(rm.message).toContain('案件「busy」の削除')
  expect(rm.message).toContain('busy pm')
  expect(rm.message).toContain('busy task')
  const mv = err(() => planConfigSet({ projects: [{ id: 'busy', path: b }] }, current, live, raw()))
  expect(mv.code).toBe('project_in_use')
  expect(mv.message).toContain('フォルダの変更')
  // ended sessions do not block
  const ended = [sess('busy', 'stopped'), sess('busy', 'failed', 'task'), sess('busy', 'exited', 'task')]
  expect(planConfigSet({ projects: [] }, current, ended, raw()).projects).toEqual([])
  // editing the PM settings of a running project is allowed; it applies when that PM starts next time
  const plan = planConfigSet({ projects: [{ id: 'busy', path: a, pm: { execution_policy: 'direct_first' } }] }, current, live, raw())
  expect(plan.pmRestartNeeded).toEqual(['busy'])
})

test('refuses a worker.json that is not the current version', () => {
  const e = err(() => planConfigSet({ projects: [] }, [], [], { version: 1, worker_id: 'local' }))
  expect(e.code).toBe('internal')
  expect(err(() => planConfigSet({ projects: 'x' }, [], [], raw())).code).toBe('bad_args')
})

test('folders under home are shown as ~ (the user name does not leave the Mac)', () => {
  expect(displayPath(homedir())).toBe('~')
  expect(displayPath(join(homedir(), 'work', 'notes'))).toBe('~/work/notes')
  expect(displayPath(join(homedir() + 'x', 'y'))).toBe(join(homedir() + 'x', 'y'))
  expect(displayPath('/opt/other')).toBe('/opt/other')
})
