// config_set (3f settings screen, docs/design/01-config-schema.md §25, 03 §2.3): replace worker.json projects[]
// from WebChat. Pure planning step here (validation, in-use check, new file contents); daemon.ts writes the file
// and swaps the in-memory config. Every refusal is fail closed: nothing is written unless all checks pass.
import { z } from 'zod'
import { realpathSync, statSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, resolve, sep } from 'path'
import {
  ExecutionPolicySchema,
  ID_RE,
  WORKER_CONFIG_VERSION,
  WorkerConfigSchema,
  expandHome,
  overlappingProjects,
  type ProjectConfig,
} from '../shared/config.ts'
import { CommandError, type ProjectInfo, type SessionRole, type SessionState } from '../shared/protocol.ts'

const MAX_PROJECTS = 64

export const ConfigSetArgsSchema = z.object({
  projects: z
    .array(
      z.object({
        id: z.string(),
        path: z.string(),
        description: z.string().max(2000).optional(),
        pm: z
          .object({
            enabled: z.boolean().optional(),
            autostart: z.boolean().optional(),
            execution_policy: ExecutionPolicySchema.optional(),
            extra_instructions: z.string().max(20000).optional(),
          })
          .optional(),
      }),
    )
    .max(MAX_PROJECTS),
})

// a session that blocks removing / moving its project: anything not ended (stopped / exited / failed)
export type SessionView = { key: string; project: string; role: SessionRole; name: string; state: SessionState }
const ENDED: SessionState[] = ['stopped', 'exited', 'failed']

// A folder as the settings screen shows it: the home folder becomes `~`, so the user name does not leave the Mac.
// Folders outside home stay absolute; they are only sent in command results (list / config_set), never in events.
export function displayPath(p: string): string {
  const homes = [homedir()]
  try {
    homes.push(realpathSync(homedir()))
  } catch {}
  for (const h of homes) {
    if (p === h) return '~'
    if (p.startsWith(h.endsWith(sep) ? h : h + sep)) return '~/' + p.slice(h.length).replace(/^\/+/, '')
  }
  return p
}

// withPath: only for command results; inventory events keep local folders off the hub's event log (pm.test.ts)
export function projectInfo(p: ProjectConfig, withPath = false): ProjectInfo {
  return {
    id: p.id,
    description: p.description,
    pm_enabled: p.pm.enabled,
    execution_policy: p.pm.execution_policy,
    ...(withPath ? { path: displayPath(p.path) } : {}),
    pm: { ...p.pm },
  }
}

// `~` / absolute only; the folder must exist; symlinks are resolved like loadWorkerConfig does
function canonicalDir(id: string, raw: string): string {
  const p = raw.trim()
  if (!p) throw new CommandError('bad_args', `案件「${id}」のフォルダが空です。Mac 上のフォルダの場所を入れてください`)
  const x = expandHome(p)
  if (!isAbsolute(x)) throw new CommandError('bad_args', `案件「${id}」のフォルダ「${p}」は / か ~ で始まる場所で指定してください`)
  let real: string
  try {
    real = realpathSync(resolve(x))
  } catch {
    throw new CommandError('bad_args', `案件「${id}」のフォルダ「${p}」が見つかりません。先に Mac でフォルダを作ってください`)
  }
  if (!statSync(real).isDirectory()) throw new CommandError('bad_args', `案件「${id}」の「${p}」はフォルダではありません`)
  return real
}

const ROLE_JA: Record<string, string> = { pm: 'PM', task: '子', secretary: '秘書' }
const describe = (s: SessionView) => `${ROLE_JA[s.role] ?? s.role}「${s.name || s.key.slice(0, 8)}」(${s.key.slice(0, 8)}, ${s.state})`

export type ConfigSetPlan = {
  projects: ProjectConfig[] // canonical, fully defaulted
  file: Record<string, unknown> // the whole worker.json to write
  pmRestartNeeded: string[]
}

// args: the command arguments; current: the projects in memory; sessions: every session record of this worker;
// rawFile: the current worker.json contents (already at WORKER_CONFIG_VERSION, since the daemon migrated it at start)
export function planConfigSet(args: unknown, current: ProjectConfig[], sessions: SessionView[], rawFile: unknown): ConfigSetPlan {
  const r = ConfigSetArgsSchema.safeParse(args ?? {})
  if (!r.success)
    throw new CommandError('bad_args', `設定の形式が正しくありません: ${r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  const ids = new Set<string>()
  const next: ProjectConfig[] = []
  for (const p of r.data.projects) {
    const id = p.id.trim()
    if (!ID_RE.test(id)) throw new CommandError('bad_args', `案件 ID「${p.id}」は使えません。英数字と - _ だけで 1〜32 文字にしてください`)
    if (ids.has(id)) throw new CommandError('bad_args', `案件 ID「${id}」が重複しています。ID は案件ごとに別にしてください`)
    ids.add(id)
    const prev = current.find(x => x.id === id)
    next.push({
      id,
      path: canonicalDir(id, p.path),
      description: p.description ?? prev?.description ?? '',
      pm: {
        enabled: p.pm?.enabled ?? prev?.pm.enabled ?? true,
        autostart: p.pm?.autostart ?? prev?.pm.autostart ?? false,
        execution_policy: p.pm?.execution_policy ?? prev?.pm.execution_policy ?? 'hybrid',
        extra_instructions: p.pm?.extra_instructions ?? prev?.pm.extra_instructions ?? '',
      },
    })
  }
  const overlap = overlappingProjects(next)
  if (overlap)
    throw new CommandError(
      'bad_args',
      `案件「${overlap[0].id}」と「${overlap[1].id}」のフォルダが同じか、一方がもう一方の中にあります（${displayPath(overlap[0].path)} と ${displayPath(overlap[1].path)}）。書込権はフォルダ単位なので、案件ごとに重ならないフォルダを指定してください`,
    )

  // fail closed: a project that loses its id or folder must not have anything running in it
  const live = (id: string) => sessions.filter(s => s.project === id && !ENDED.includes(s.state))
  const blocked: string[] = []
  for (const p of current) {
    const n = next.find(x => x.id === p.id)
    const why = !n ? '削除' : n.path !== p.path ? `フォルダの変更（${displayPath(p.path)} → ${displayPath(n.path)}）` : null
    if (!why) continue
    const ss = live(p.id)
    if (ss.length) blocked.push(`案件「${p.id}」の${why}: 動いているセッション ${ss.map(describe).join('、')}`)
  }
  if (blocked.length)
    throw new CommandError(
      'project_in_use',
      `動いているセッションがあるため変更できません。${blocked.join('。')}。スレッド一覧でセッションを停止してから、もう一度保存してください`,
    )

  const pmRestartNeeded = next
    .filter(n => {
      const p = current.find(x => x.id === n.id)
      if (!p) return false
      const changed = JSON.stringify(p.pm) !== JSON.stringify(n.pm) || p.description !== n.description
      return changed && live(n.id).some(s => s.role === 'pm')
    })
    .map(n => n.id)

  if (!rawFile || typeof rawFile !== 'object' || Array.isArray(rawFile))
    throw new CommandError('internal', 'worker.json を読めませんでした（JSON オブジェクトではありません）。ファイルを確認してください')
  const file: Record<string, unknown> = { ...(rawFile as Record<string, unknown>), projects: next }
  if (file.version !== WORKER_CONFIG_VERSION)
    throw new CommandError('internal', `worker.json の version が ${String(file.version)} です。ワーカーを再起動して移行してから保存してください`)
  const v = WorkerConfigSchema.safeParse(file)
  if (!v.success)
    throw new CommandError('bad_args', `保存後の worker.json が設定として正しくありません: ${v.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`)
  return { projects: v.data.projects, file, pmRestartNeeded }
}
