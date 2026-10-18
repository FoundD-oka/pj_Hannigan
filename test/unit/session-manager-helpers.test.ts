// shared/session-manager.ts helpers added for the VPS (04 S3): resume only with a transcript; a shell that exists
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { defaultShell, transcriptExists } from '../../shared/session-manager.ts'

test('transcriptExists finds <id>.jsonl under any project folder and nothing else', () => {
  const root = mkdtempSync(join(tmpdir(), 'hn-tr-'))
  const id = '86919f84-701a-4d6d-aefc-0c4b66208096'
  expect(transcriptExists(root, id)).toBe(false)
  mkdirSync(join(root, '-home-hannigan--hannigan-secretary-contexts-vps-s3-1'), { recursive: true })
  expect(transcriptExists(root, id)).toBe(false)
  writeFileSync(join(root, '-home-hannigan--hannigan-secretary-contexts-vps-s3-1', `${id}.jsonl`), '{}\n')
  expect(transcriptExists(root, id)).toBe(true)
  expect(transcriptExists(join(root, 'missing'), id)).toBe(false)
  expect(transcriptExists(root, '../etc/passwd')).toBe(false)
})

test('defaultShell prefers an existing $SHELL, then the OS default that exists', () => {
  expect(defaultShell({ SHELL: '/bin/sh' }, 'linux')).toBe('/bin/sh')
  expect(defaultShell({ SHELL: '/nonexistent/zsh' }, 'linux')).toMatch(/^\/bin\/(bash|zsh|sh)$/)
  expect(defaultShell({}, 'linux')).toMatch(/^\/bin\/(bash|zsh|sh)$/)
  expect(defaultShell({}, 'darwin')).toMatch(/^\/bin\/(zsh|bash|sh)$/)
})
