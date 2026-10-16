// Settings screen, hub side (3f, docs/design/01-config-schema.md §25). hub.json stays the source of truth: a
// change is merged into the file's own JSON object (so keys the screen does not know are kept), the whole file is
// validated like at startup, and only then written. Pure: hub.ts reads / writes the file and applies the result.
import { z } from 'zod'
import { checkHubConfig, ConfigError, HUB_CONFIG_VERSION, HubConfigSchema, type HubConfig } from '../shared/config.ts'

export class SettingsError extends Error {}

const posInt = (label: string) =>
  z.number({ error: `${label}は 1 以上の整数で指定してください` }).int(`${label}は 1 以上の整数で指定してください`).positive(`${label}は 1 以上の整数で指定してください`)

// what the screen may send; anything else (listen, public_url, secrets, discord, ...) is refused by name
const Input = z.strictObject({
  secretary: z
    .strictObject({
      contexts: z
        .strictObject({
          max_active: posInt('秘書の同時起動数').max(64, '秘書の同時起動数は 64 以下にしてください').optional(),
          idle_minutes: posInt('秘書の放置時間（分）').max(10080, '秘書の放置時間は 10080 分（7 日）以下にしてください').optional(),
        })
        .optional(),
    })
    .optional(),
  offline_queue: z
    .strictObject({
      enabled: z.boolean().optional(),
      ttl_minutes: posInt('保留の期限（分）').max(43200, '保留の期限は 43200 分（30 日）以下にしてください').optional(),
      max_pending_per_worker: posInt('ワーカーごとの保留上限').max(10000, 'ワーカーごとの保留上限は 10000 以下にしてください').optional(),
    })
    .optional(),
  workers: z
    .array(
      z.strictObject({
        id: z.string(),
        display_name: z.string().max(80, '表示名は 80 文字以内にしてください').nullable().optional(),
        role: z.string().max(2000, '役割は 2000 文字以内にしてください').optional(),
      }),
    )
    .optional(),
})
export type HubSettingsInput = z.infer<typeof Input>

const FIXED: Record<string, string> = {
  listen: '待ち受けアドレス（listen）',
  public_url: '公開 URL（public_url）',
  discord: 'Discord の設定',
  version: '設定の版（version）',
}

// fields as the screen names them, grouped by when they take effect
export type Applies = { now: string[]; next_secretary_start: string[]; restart: string[] }

export type HubSettingsPlan = { file: Record<string, unknown>; config: HubConfig; applies: Applies; changed: string[] }

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const sub = (o: Obj, k: string): Obj => (isObj(o[k]) ? (o[k] as Obj) : (o[k] = {}) as Obj)

function explain(e: z.ZodError): string {
  return e.issues
    .map(i => {
      if (i.code === 'unrecognized_keys') {
        const keys = i.keys.map(k => [...i.path, k].join('.'))
        const top = i.path.length === 0 ? i.keys.filter(k => k in FIXED) : []
        if (top.length) return `${top.map(k => FIXED[k]).join('、')}は設定画面から変更できません。hub.json を直接編集してハブを再起動してください`
        return `設定画面で変更できない項目です: ${keys.join(', ')}`
      }
      return `${i.path.join('.') || '(全体)'}: ${i.message}`
    })
    .join('; ')
}

// input: the request body; raw: hub.json as read from disk now; current: the running config (for `changed`)
export function planHubSettings(input: unknown, raw: unknown, current: HubConfig): HubSettingsPlan {
  const r = Input.safeParse(input ?? {})
  if (!r.success) throw new SettingsError(explain(r.error))
  const a = r.data
  if (!isObj(raw)) throw new SettingsError('hub.json が JSON オブジェクトではありません。ファイルを確認してください')
  if (raw.version !== HUB_CONFIG_VERSION)
    throw new SettingsError(`hub.json の version が ${String(raw.version)} です。ハブを再起動して移行してから保存してください`)
  const file = JSON.parse(JSON.stringify(raw)) as Obj
  const changed: string[] = []
  const set = (o: Obj, k: string, v: unknown, name: string, was: unknown) => {
    if (v === undefined) return
    o[k] = v
    if (v !== was) changed.push(name)
  }

  const ctx = a.secretary?.contexts
  if (ctx) {
    const c = sub(sub(file, 'secretary'), 'contexts')
    set(c, 'max_active', ctx.max_active, 'secretary.contexts.max_active', current.secretary.contexts.max_active)
    set(c, 'idle_minutes', ctx.idle_minutes, 'secretary.contexts.idle_minutes', current.secretary.contexts.idle_minutes)
  }
  const oq = a.offline_queue
  if (oq) {
    const o = sub(file, 'offline_queue')
    set(o, 'enabled', oq.enabled, 'offline_queue.enabled', current.offline_queue.enabled)
    set(o, 'ttl_minutes', oq.ttl_minutes, 'offline_queue.ttl_minutes', current.offline_queue.ttl_minutes)
    set(o, 'max_pending_per_worker', oq.max_pending_per_worker, 'offline_queue.max_pending_per_worker', current.offline_queue.max_pending_per_worker)
  }
  if (a.workers) {
    // display name and role only: adding or removing a worker needs a key pairing and stays a file edit
    if (!Array.isArray(file.workers)) throw new SettingsError('hub.json に workers がありません。ワーカーの追加は設定画面ではできません')
    const list = file.workers as unknown[]
    const seen = new Set<string>()
    for (const w of a.workers) {
      if (seen.has(w.id)) throw new SettingsError(`ワーカー「${w.id}」が 2 回指定されています`)
      seen.add(w.id)
      const entry = list.find(x => isObj(x) && x.id === w.id) as Obj | undefined
      if (!entry) throw new SettingsError(`ワーカー「${w.id}」は hub.json にありません。ワーカーの追加と削除は設定画面ではできません`)
      const cur = current.workers.find(x => x.id === w.id)
      set(entry, 'display_name', w.display_name === undefined ? undefined : w.display_name?.trim() || null, `workers.${w.id}.display_name`, cur?.display_name ?? null)
      set(entry, 'role', w.role, `workers.${w.id}.role`, cur?.role ?? '')
    }
  }

  const v = HubConfigSchema.safeParse(file)
  if (!v.success) throw new SettingsError(`保存後の hub.json が設定として正しくありません: ${v.error.issues.map(i => `${i.path.join('.') || '(全体)'}: ${i.message}`).join('; ')}`)
  try {
    checkHubConfig(file, v.data)
  } catch (e) {
    if (e instanceof ConfigError) throw new SettingsError(e.message)
    throw e
  }
  const applies: Applies = { now: [], next_secretary_start: [], restart: [] }
  for (const f of changed) {
    if (f.startsWith('workers.')) {
      // the screen shows the new name at once; secretaries read names and roles in their instructions at start
      applies.now.push(f)
      applies.next_secretary_start.push(f)
    } else applies.now.push(f)
  }
  return { file, config: v.data, applies, changed }
}
