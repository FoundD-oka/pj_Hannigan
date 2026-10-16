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

test('refuses a hub.json of another version', () => {
  expect(err(() => planHubSettings({}, { version: 1 }, current()))).toContain('version')
})
