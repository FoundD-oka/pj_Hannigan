// hub side of the settings screen (3f): merge into hub.json, validation, refused fields, apply timing.
import { expect, test } from 'bun:test'
import { HubConfigSchema } from '../../shared/config.ts'
import { planHubSettings, SettingsError } from '../../hub/settings.ts'

const raw = () => ({
  version: 8,
  listen: { host: '127.0.0.1', port: 8800 },
  secretary: { autostart: false, contexts: { max_active: 2 }, extra_instructions: 'keep me' },
  offline_queue: { enabled: true, ttl_minutes: 1440 },
  workers: [{ id: 'local', display_name: 'この Mac', role: '' }],
  future_key: { a: 1 },
})
const current = () => HubConfigSchema.parse(raw())
const err = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(SettingsError)
    return (e as Error).message
  }
  throw new Error('expected a SettingsError')
}

test('merges the edited fields into the file and keeps everything else', () => {
  const p = planHubSettings(
    { offline_queue: { ttl_minutes: 90, max_pending_per_worker: 5 }, secretary: { contexts: { idle_minutes: 10 } }, workers: [{ id: 'local', role: '自宅' }] },
    raw(),
    current(),
  )
  expect(p.file.offline_queue).toEqual({ enabled: true, ttl_minutes: 90, max_pending_per_worker: 5 })
  expect((p.file.secretary as any).contexts).toEqual({ max_active: 2, idle_minutes: 10 })
  expect((p.file.secretary as any).extra_instructions).toBe('keep me')
  expect(p.file.future_key).toEqual({ a: 1 })
  expect(p.file.listen).toEqual({ host: '127.0.0.1', port: 8800 })
  expect(p.config.offline_queue.ttl_minutes).toBe(90)
  expect(p.changed.sort()).toEqual(['offline_queue.max_pending_per_worker', 'offline_queue.ttl_minutes', 'secretary.contexts.idle_minutes', 'workers.local.role'].sort())
  expect(p.applies.now).toContain('offline_queue.ttl_minutes')
  expect(p.applies.next_secretary_start).toEqual(['workers.local.role'])
  expect(p.applies.restart).toEqual([])
})

test('no change reports nothing changed', () => {
  const p = planHubSettings({ offline_queue: { ttl_minutes: 1440 } }, raw(), current())
  expect(p.changed).toEqual([])
})

test('refuses invalid values with the field named', () => {
  expect(err(() => planHubSettings({ offline_queue: { ttl_minutes: 0 } }, raw(), current()))).toContain('保留の期限')
  expect(err(() => planHubSettings({ offline_queue: { ttl_minutes: 1.5 } }, raw(), current()))).toContain('整数')
  expect(err(() => planHubSettings({ secretary: { contexts: { max_active: -1 } } }, raw(), current()))).toContain('秘書の同時起動数')
})

test('refuses listen / public_url / secrets / discord and unknown fields', () => {
  expect(err(() => planHubSettings({ listen: { port: 9000 } }, raw(), current()))).toContain('待ち受けアドレス')
  expect(err(() => planHubSettings({ public_url: 'https://x' }, raw(), current()))).toContain('公開 URL')
  expect(err(() => planHubSettings({ secretary: { session: { model: 'x' } } }, raw(), current()))).toContain('secretary.session')
  expect(err(() => planHubSettings({ webchat_token: 'x' }, raw(), current()))).toContain('webchat_token')
})

test('workers: display name and role only, no adding / removing', () => {
  expect(err(() => planHubSettings({ workers: [{ id: 'other', role: 'x' }] }, raw(), current()))).toContain('ワーカーの追加と削除')
  expect(err(() => planHubSettings({ workers: [{ id: 'local', key: 'x' }] }, raw(), current()))).toContain('workers.0.key')
  const p = planHubSettings({ workers: [{ id: 'local', display_name: '  ' }] }, raw(), current())
  expect((p.file.workers as any)[0]).toEqual({ id: 'local', display_name: null, role: '' })
})

test('persona and guidance: merged into the file, applied at the next secretary start, name also shown now', () => {
  const p = planHubSettings(
    {
      secretary: {
        persona: { name: ' ハニガン ', character: '敬語', user_name: '', language: '日本語', verbosity: 'normal' },
        routing_notes: '仕事は office',
        extra_instructions: 'x',
      },
    },
    raw(),
    current(),
  )
  expect((p.file.secretary as any).persona).toEqual({ name: 'ハニガン', character: '敬語', user_name: null, language: '日本語', verbosity: 'normal' })
  expect((p.file.secretary as any).routing_notes).toBe('仕事は office')
  expect((p.file.secretary as any).extra_instructions).toBe('x')
  expect((p.file.secretary as any).contexts).toEqual({ max_active: 2 }) // untouched
  expect(p.config.secretary.persona.name).toBe('ハニガン')
  expect(p.changed.sort()).toEqual(
    ['secretary.persona.name', 'secretary.persona.character', 'secretary.persona.language', 'secretary.persona.verbosity', 'secretary.routing_notes', 'secretary.extra_instructions'].sort(),
  )
  expect(p.applies.now).toEqual(['secretary.persona.name'])
  expect(p.applies.next_secretary_start.sort()).toEqual(p.changed.sort())
  expect(p.applies.restart).toEqual([])
  // sending the current values again changes nothing
  const same = planHubSettings({ secretary: { persona: { name: 'Hannigan', verbosity: 'short' }, extra_instructions: 'keep me' } }, raw(), current())
  expect(same.changed).toEqual([])
})

test('persona: empty name, overlong fields and an unknown verbosity are refused by name', () => {
  expect(err(() => planHubSettings({ secretary: { persona: { name: '  ' } } }, raw(), current()))).toContain('秘書の名前')
  expect(err(() => planHubSettings({ secretary: { persona: { name: 'a'.repeat(41) } } }, raw(), current()))).toContain('40 文字')
  expect(err(() => planHubSettings({ secretary: { persona: { verbosity: 'loud' } } }, raw(), current()))).toContain('返信の長さ')
  expect(err(() => planHubSettings({ secretary: { persona: { character: 'a'.repeat(4001) } } }, raw(), current()))).toContain('キャラ設定')
  expect(err(() => planHubSettings({ secretary: { persona: { mood: 'x' } } }, raw(), current()))).toContain('secretary.persona.mood')
  expect(err(() => planHubSettings({ secretary: { routing_notes: 'a'.repeat(4001) } }, raw(), current()))).toContain('振り分けの判断基準')
})

test('refuses a hub.json of another version', () => {
  expect(err(() => planHubSettings({}, { version: 1 }, current()))).toContain('version')
})
