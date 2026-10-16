import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { keysToSelect, parsePane } from '../../shared/pane.ts'

const fx = (n: string) => readFileSync(join(import.meta.dir, '..', 'fixtures', n), 'utf8')

describe('parsePane', () => {
  test('dev channel warning', () => {
    const s = parsePane(fx('dev-channel-warning.txt'))
    expect(s.prompt?.kind).toBe('dev_channel_warning')
    expect(s.prompt?.options).toEqual(['I am using this for local development', 'Exit'])
    expect(s.prompt?.cursor).toBe(0)
    expect(s.prompt?.title).toBe('WARNING: Loading development channels')
  })
  test('workspace trust (unnumbered, cursor on No)', () => {
    const s = parsePane(fx('workspace-trust.txt'))
    expect(s.prompt?.kind).toBe('workspace_trust')
    expect(s.prompt?.options).toEqual(['No, exit', 'Yes, I trust this folder'])
    expect(s.prompt?.cursor).toBe(0)
  })
  test('computer use app approval', () => {
    const s = parsePane(fx('cu-app-approval.txt'))
    expect(s.prompt?.kind).toBe('cu_app_approval')
    expect(s.prompt?.options).toEqual(['Deny, and tell Claude what to do differently (esc)', 'Allow for this session (1 app)'])
    expect(s.prompt?.body).toContain('テキストエディット')
  })
  test('tool permission', () => {
    const s = parsePane(fx('tool-permission.txt'))
    expect(s.prompt?.kind).toBe('tool_permission')
    expect(s.prompt?.options.length).toBe(3)
    expect(s.prompt?.options[2]).toBe('No')
  })
  test('idle screen has no prompt and input is ready', () => {
    const s = parsePane(fx('idle.txt'))
    expect(s.prompt).toBeNull()
    expect(s.inputReady).toBe(true)
    expect(s.working).toBe(false)
  })
  test('working spinner without esc hint (v2.1.296)', () => {
    expect(parsePane('✽ Hashing… (11s · ↓ 448 tokens)\n' + '─'.repeat(50) + '\n❯ \n' + '─'.repeat(50)).working).toBe(true)
    expect(parsePane('✶ Bunning…\n').working).toBe(true)
    expect(parsePane('✻ Churned for 56s · done 20:01\n' + '─'.repeat(50) + '\n❯ \n' + '─'.repeat(50)).working).toBe(false)
    expect(parsePane('  Calling hannigan 4 times… (ctrl+o to expand)\n').working).toBe(false)
  })
  test('working indicator', () => {
    const s = parsePane('⏺ doing\n✻ Cogitating… (3s · esc to interrupt)\n')
    expect(s.working).toBe(true)
    expect(s.inputReady).toBe(false)
  })
  test('prompt id is stable and differs by content', () => {
    const a = parsePane(fx('dev-channel-warning.txt')).prompt!.prompt_id
    expect(parsePane(fx('dev-channel-warning.txt')).prompt!.prompt_id).toBe(a)
    expect(parsePane(fx('workspace-trust.txt')).prompt!.prompt_id).not.toBe(a)
  })
})

test('keysToSelect', () => {
  expect(keysToSelect(0, 1)).toEqual(['Down', 'Enter'])
  expect(keysToSelect(2, 0)).toEqual(['Up', 'Up', 'Enter'])
  expect(keysToSelect(1, 1)).toEqual(['Enter'])
})
