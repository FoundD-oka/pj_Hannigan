import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { WorkerEvent } from '../../shared/protocol.ts'
import { TranscriptAdapter, convertLine, encodeCwd, makeRedactor, maskPaths, newConvertState, readFrom, type Stats } from '../../worker/transcript.ts'

// the fixture keeps a placeholder so that no token-shaped string is committed; a fake one is put in at test time
const FAKE_GH = 'ghp_' + 'FAKE' + 'x'.repeat(36)
const KNOWN = 'HANNIGAN_KNOWN_SECRET_VALUE_42'
const fixture = () => readFileSync(join(import.meta.dir, '..', 'fixtures', 'transcript-v2.1.301.jsonl'), 'utf8').replaceAll('__FAKE_GH_TOKEN__', FAKE_GH)

function convertAll(text: string) {
  const { redact } = makeRedactor([KNOWN])
  const stats: Stats = {}
  const st = newConvertState()
  const items = text
    .split('\n')
    .filter(Boolean)
    .flatMap(l => {
      try {
        return convertLine(JSON.parse(l), redact, stats, st)
      } catch {
        return []
      }
    })
  return { items, stats, st }
}

test('converts only known lines and blocks (S2 §3)', () => {
  const { items, stats, st } = convertAll(fixture())
  expect(items.map(i => i.entry_kind)).toEqual([
    'channel_message',
    'assistant_message',
    'tool_summary',
    'tool_result',
    'user_direct',
    'tool_summary',
    'tool_result',
    'terminal_input',
    'tool_summary',
    'tool_result',
  ])
  expect(items[0]!.message_id).toBe('rq-1')
  expect(items[0]!.text.startsWith('[task] Deploy with token')).toBe(true)
  expect(items[1]!.text).toBe('I will run the tests first.')
  expect(items[1]!.entry_id).toBe('00000000-0000-4000-8000-0000000000aa:a2:0')
  expect(items[4]!.message_id).toBe('m-9')
  expect(items[4]!.text).toBe('please also check the README')
  expect(items[7]!.text).toBe('typed in the terminal')
  expect(items[9]!.text).toBe('[error] permission denied\n[image]')
  // dropped: thinking, the reply tool and its result, api-request-*, attachments, meta lines
  expect(stats['skip:thinking']).toBe(1)
  expect(stats['skip:tool_use:reply']).toBe(1)
  expect(stats['skip:tool_result:reply']).toBe(1)
  expect(stats['skip:type:api-request-blob']).toBe(1)
  expect(stats['skip:type:attachment']).toBe(1)
  expect(stats['skip:user:meta-or-command']).toBe(1)
  expect(JSON.stringify(items)).not.toContain('masked private reasoning')
  expect(JSON.stringify(items)).not.toContain('reply is recorded')
  expect([...st.versions]).toEqual(['2.1.301'])
})

test('redacts before truncation: token shapes, Authorization headers, *_TOKEN=, known Hannigan secrets', () => {
  const { items } = convertAll(fixture())
  const all = JSON.stringify(items)
  expect(all).not.toContain(FAKE_GH)
  expect(all).not.toContain('abcdef1234567890')
  expect(all).not.toContain('abc123def456')
  expect(all).not.toContain(KNOWN)
  expect(all).toContain('[REDACTED:hannigan-secret]')
  expect(all).toContain('MY_SECRET_TOKEN=[REDACTED]')
  expect(all).toContain('Authorization: Bearer [REDACTED]')
  // sensitive file: neither the input path's content nor the result body
  expect(items[5]!.text).toBe('Read: [sensitive file]')
  expect(items[6]!.text).toBe('[sensitive file content hidden]')
  expect(all).not.toContain('zzz-masked-value')
})

test('long tool output is cut after redaction', () => {
  const { redact } = makeRedactor([])
  const line = {
    type: 'user',
    uuid: 'x',
    sessionId: 's',
    message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'a'.repeat(490) + ' API_TOKEN=' + 'b'.repeat(40) }] },
  }
  const [it] = convertLine(line, redact, {})
  expect(it!.text).not.toContain('bbbb')
  expect(it!.text.length).toBeLessThanOrEqual(501)
})

test('readFrom consumes complete lines only and resets on truncation', () => {
  const d = mkdtempSync(join(tmpdir(), 'hn-tr-'))
  const f = join(d, 't.jsonl')
  writeFileSync(f, '{"a":1}\n{"b":2}\n{"c"')
  const r1 = readFrom(f, 0)
  expect(r1.lines).toEqual(['{"a":1}', '{"b":2}'])
  appendFileSync(f, ':3}\n')
  const r2 = readFrom(f, r1.next)
  expect(r2.lines).toEqual(['{"c":3}'])
  writeFileSync(f, '{"z":0}\n')
  expect(readFrom(f, r2.next).reset).toBe(true)
})

function adapter(root: string, stateDir: string, events: WorkerEvent[], o: { graceMs?: number; tested?: string[] } = {}) {
  return new TranscriptAdapter({
    stateDir,
    home: join(stateDir, 'home'),
    emit: e => events.push(e),
    redactSensitive: true,
    projectsRoot: root,
    graceMs: o.graceMs ?? 60000,
    testedVersions: o.tested,
  })
}

test('adapter: finds the file by cwd + session id, emits entries once, persists the offset, marks coverage', () => {
  const d = mkdtempSync(join(tmpdir(), 'hn-tr-'))
  const root = join(d, 'projects')
  const cwd = '/work/demo'
  const id = '00000000-0000-4000-8000-0000000000aa'
  mkdirSync(join(root, encodeCwd(cwd)), { recursive: true })
  writeFileSync(join(root, encodeCwd(cwd), `${id}.jsonl`), fixture())
  const s = { key: id, project: 'demo', role: 'task' as const, pm_session: 'pm-1', cwd, conversation_id: id }
  const ev: WorkerEvent[] = []
  const a = adapter(root, join(d, 'state'), ev)
  a.watch(s)
  const entries = ev.filter(e => e.kind === 'thread_entry') as Extract<WorkerEvent, { kind: 'thread_entry' }>[]
  expect(entries.filter(e => e.entry_kind !== 'coverage').length).toBe(10)
  expect(entries.every(e => e.source === 'transcript' && e.session === id && e.pm_session === 'pm-1')).toBe(true)
  expect(entries.find(e => e.entry_kind === 'coverage')!.text).toBe('transcript')
  a.close()
  // a new adapter (daemon restart) continues from the saved offset
  const ev2: WorkerEvent[] = []
  const b = adapter(root, join(d, 'state'), ev2)
  b.watch(s)
  expect(ev2.length).toBe(0)
  appendFileSync(
    join(root, encodeCwd(cwd), `${id}.jsonl`),
    '\n' + JSON.stringify({ type: 'assistant', uuid: 'a9', sessionId: id, version: '2.1.302', message: { content: [{ type: 'text', text: 'later' }] } }) + '\n',
  )
  b.tick()
  const more = ev2.filter(e => e.kind === 'thread_entry') as Extract<WorkerEvent, { kind: 'thread_entry' }>[]
  expect(more.map(e => e.text)).toContain('later')
  // an untested Claude Code version -> partial
  expect(more.find(e => e.entry_kind === 'coverage')?.text).toBe('partial')
  b.close()
})

test('adapter: missing file -> coverage unavailable after the grace period', () => {
  const d = mkdtempSync(join(tmpdir(), 'hn-tr-'))
  const ev: WorkerEvent[] = []
  const a = adapter(join(d, 'projects'), join(d, 'state'), ev, { graceMs: -1 })
  a.watch({ key: 'k', project: 'p', role: 'pm', pm_session: null, cwd: '/nowhere', conversation_id: 'k' })
  const cov = ev.filter(e => e.kind === 'thread_entry' && e.entry_kind === 'coverage')
  expect(cov.length).toBe(1)
  expect((cov[0] as any).text).toBe('unavailable')
  a.close()
})

test('local paths are masked in emitted text', () => {
  const m = maskPaths('/work/demo', '/Users/someone')
  expect(m('Write: {"file_path":"/work/demo/src/a.ts"} and /Users/someone/.zshrc')).toBe('Write: {"file_path":"<project>/src/a.ts"} and ~/.zshrc')
  // any other absolute path becomes a stable short hash; the user and folder names never leave the Mac
  const other = m('see /Users/other/secret-proj/x.ts and /Volumes/Disk/a b, /private/tmp/q, /opt/x, /etc/hosts')
  expect(other).not.toContain('other')
  expect(other).not.toContain('secret-proj')
  expect(other).not.toContain('/Volumes')
  expect(other).not.toContain('/etc/hosts')
  expect(other).toMatch(/^see <path:[0-9a-f]{6}> and <path:[0-9a-f]{6}> b, <path:[0-9a-f]{6}>, <path:[0-9a-f]{6}>, <path:[0-9a-f]{6}>$/)
  expect(m('/tmp/a')).toBe(m('/tmp/a')) // stable
  expect(m('/tmp/a')).not.toBe(m('/tmp/b'))
  // relative paths, URLs and placeholders are left alone
  expect(m('src/a.ts https://example.com/Users/x <project>/b ~/c')).toBe('src/a.ts https://example.com/Users/x <project>/b ~/c')
})
