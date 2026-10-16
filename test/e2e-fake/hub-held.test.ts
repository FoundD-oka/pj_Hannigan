// Deliveries waiting for a secretary survive a hub restart (hub/held.json). One secretary slot
// (max_active=1); the first conversation's secretary stays at its development-channel dialog, so the second
// conversation has to wait. The hub is restarted while it waits; after the dialog is answered the slot frees
// up and the waiting message reaches the second conversation's secretary.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { Harness, type Ev } from '../harness.ts'

const T = 60000
let h: Harness
const isSec = (e: Ev) => e.worker === '_secretary'

beforeAll(async () => {
  h = new Harness({
    secretaryAutostart: false,
    secretarySession: { terminal_prompts: { dev_channel_warning: 'relay', workspace_trust: 'auto_accept' } },
    hubExtra: { secretary: { contexts: { max_active: 1 } } },
  })
  h.startHub()
  await h.waitHttp()
})
afterAll(async () => {
  await h?.cleanup()
})

describe('held secretary deliveries (hub restart)', () => {
  test('a message waiting for a secretary slot is delivered after a hub restart', async () => {
    let s0 = h.lastSeq()
    await h.send('first', 'conv-1')
    await h.waitEvent(e => e.kind === 'approval_open' && isSec(e) && e.context_id === 'conv-1' && e.prompt_kind === 'dev_channel_warning', s0, T, 'conv-1 dialog')
    const r = await h.send('second', 'conv-2')
    expect(r.json).toMatchObject({ status: 'accepted', delivery: 'held' })
    await h.waitEvent(e => e.kind === 'secretary_waiting' && e.context_id === 'conv-2', s0, T, 'conv-2 waiting')
    const file = join(h.home, 'hub', 'held.json')
    expect(existsSync(file)).toBe(true)
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    expect(saved['conv-2'].map((x: any) => x.content)).toEqual(['second'])
    expect(saved['conv-1'].map((x: any) => x.content)).toEqual(['first']) // its secretary's bridge is not up yet
    // nothing reached a secretary yet
    expect(h.events().some(e => e.seq > s0 && e.kind === 'secretary_reply')).toBe(false)

    await h.stopHub()
    s0 = h.lastSeq()
    h.startHub()
    await h.waitHttp()
    // the conv-1 secretary is still at its dialog; answering it frees the slot after its own message
    await h.answer(e => isSec(e) && e.context_id === 'conv-1' && e.prompt_kind === 'dev_channel_warning', 0, s0, T)
    // conv-1 is evicted for conv-2 (one slot); conv-2's secretary shows the same dialog
    await h.answer(e => isSec(e) && e.context_id === 'conv-2' && e.prompt_kind === 'dev_channel_warning', 0, s0, T)
    const reply = await h.waitEvent(e => e.kind === 'secretary_reply' && e.conv_id === 'conv-2', s0, T, 'conv-2 reply after restart')
    expect(reply.text).toBe('hello: second')
    // conv-2's message went to conv-2 only, once
    await Bun.sleep(1500)
    const replies = h.events().filter(e => e.kind === 'secretary_reply')
    expect(replies.filter(e => e.text === 'hello: second').map(e => e.conv_id)).toEqual(['conv-2'])
    const after = JSON.parse(readFileSync(file, 'utf8'))
    expect(after['conv-2']).toBeUndefined()
  }, T * 2)
})
