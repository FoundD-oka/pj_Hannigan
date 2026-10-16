import { expect, test } from 'bun:test'
import { COMMANDS, ERROR_CODES, OFFLINE_QUEUEABLE, PROTO, type CommandName, type ErrorCode } from '../../shared/protocol.ts'

test('proto 2', () => {
  expect(PROTO).toBe(2)
})

test('COMMANDS lists every CommandName exactly once', () => {
  // the Record forces a compile error when CommandName gains a member that is not listed here
  const all: Record<CommandName, true> = {
    list: true,
    pm_ensure: true,
    pm_send: true,
    thread_direct_send: true,
    session_create: true,
    session_resume: true,
    session_send: true,
    session_interrupt: true,
    session_stop: true,
    approval_answer: true,
    terminal_answer: true,
    config_set: true,
  }
  expect([...COMMANDS].sort()).toEqual(Object.keys(all).sort() as CommandName[])
  expect(new Set(COMMANDS).size).toBe(COMMANDS.length)
  for (const c of OFFLINE_QUEUEABLE) expect(COMMANDS).toContain(c)
  expect([...OFFLINE_QUEUEABLE].sort()).toEqual(['pm_send', 'thread_direct_send'])
  expect(OFFLINE_QUEUEABLE).not.toContain('config_set')
})

test('ERROR_CODES lists every ErrorCode exactly once', () => {
  const required: ErrorCode[] = ['expired', 'deadline_expired', 'queue_full', 'workspace_busy', 'forbidden', 'delivery_unknown', 'worker_offline', 'project_in_use']
  for (const c of required) expect(ERROR_CODES).toContain(c)
  expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length)
})
