// Transcript adapter (Q4/B, docs/verification/phase3-spikes/S2-transcript-adapter.md): tails the native
// Claude Code transcript of pm / task sessions and turns the safe parts into `thread_entry` events.
// Read-only: never writes to the transcript or types into Claude Code. The format is internal to Claude Code,
// so only known line types and blocks are used; everything else is dropped and counted.
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, watch, type FSWatcher } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { SessionRole, WorkerEvent } from '../shared/protocol.ts'
import { log, maskAbsPaths, readJson, writeJsonAtomic } from '../shared/util.ts'

export const TESTED_VERSIONS = ['2.1.301']
const MAX_TEXT = 4000
const MAX_TOOL_INPUT = 300
const MAX_TOOL_RESULT = 500

// ---------------------------------------------------------------- redaction (S2 §5.2)
const TOKEN_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\b[MN][A-Za-z\d_-]{23,25}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(Authorization:\s*(?:Bearer|Basic)\s+)[^\s"'\\]+/gi,
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]*\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"'\\]+)/gi,
]

export type Redactor = { redact: (s: string) => string; hits: () => number }

// knownSecrets: exact values replaced first (longest first); patterns only when `patterns` is true
export function makeRedactor(knownSecrets: string[], patterns = true): Redactor {
  const vals = [...new Set(knownSecrets.map(s => s.trim()).filter(s => s.length >= 8))].sort((a, b) => b.length - a.length)
  let hits = 0
  const redact = (input: string): string => {
    let s = input
    for (const v of vals)
      if (s.includes(v)) {
        hits++
        s = s.split(v).join('[REDACTED:hannigan-secret]')
      }
    if (patterns)
      for (const re of TOKEN_PATTERNS)
        s = s.replace(re, (m: string, p1: unknown) => {
          hits++
          return typeof p1 === 'string' && m.startsWith(p1) ? p1 + '[REDACTED]' : '[REDACTED]'
        })
    return s
  }
  return { redact, hits: () => hits }
}

// values of $HANNIGAN_HOME/secrets/* (whole file and, for JSON files, every string value)
export function hanniganSecrets(home: string): string[] {
  const dir = join(home, 'secrets')
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const f of readdirSync(dir)) {
    try {
      const raw = readFileSync(join(dir, f), 'utf8')
      out.push(raw.trim())
      try {
        const walk = (v: unknown): void => {
          if (typeof v === 'string') out.push(v)
          else if (v && typeof v === 'object') Object.values(v).forEach(walk)
        }
        walk(JSON.parse(raw))
      } catch {}
    } catch {}
  }
  return out
}

// ---------------------------------------------------------------- conversion (S2 §3, appendix A)
export type EntryKind = 'user_direct' | 'channel_message' | 'terminal_input' | 'assistant_message' | 'tool_summary' | 'tool_result'
export type ThreadItem = {
  entry_id: string // `${sessionId}:${uuid}:${blockIndex}`
  ts: string
  entry_kind: EntryKind
  text: string
  message_id?: string | null
  tool?: string
  tool_use_id?: string
  truncated?: boolean
}
export type ConvertState = {
  hiddenToolUses: Set<string> // tool_use ids whose result is not shown (reply tool, sensitive files)
  sensitiveToolUses: Set<string>
  versions: Set<string>
}
export const newConvertState = (): ConvertState => ({ hiddenToolUses: new Set(), sensitiveToolUses: new Set(), versions: new Set() })

const cut = (s: string, n: number) => (s.length > n ? { text: s.slice(0, n) + '…', truncated: true } : { text: s, truncated: false })
const SKIP_USER_PREFIX = ['<local-command-', '<command-name>', '<command-message>', '<task-notification>', '<system-reminder>', 'Base directory for this skill']
const HIDDEN_TOOLS = /^mcp__hannigan__reply$/
const SENSITIVE_PATH = /(^|\/)(\.env(\..*)?|secrets?\/|.*\.pem$|id_[a-z0-9]+(\.pub)?$|\.ssh\/|\.aws\/|\.netrc$|credentials)/i

function parseChannel(s: string): { attrs: Record<string, string>; body: string } | null {
  const m = /^\s*<channel\s+([^>]*)>([\s\S]*?)<\/channel>\s*$/.exec(s)
  if (!m) return null
  const attrs: Record<string, string> = {}
  for (const a of m[1]!.matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]!] = a[2]!
  return { attrs, body: m[2]!.trim() }
}

export type Stats = Record<string, number>

export function convertLine(o: any, redact: (s: string) => string, stats: Stats, st: ConvertState = newConvertState()): ThreadItem[] {
  const bump = (k: string) => (stats[k] = (stats[k] ?? 0) + 1)
  const t = o?.type
  if (typeof o?.version === 'string') st.versions.add(o.version)
  if (t !== 'user' && t !== 'assistant') {
    bump(`skip:type:${t}`)
    return []
  }
  if (o.isSidechain) return bump('skip:sidechain'), []
  if (o.isCompactSummary) return bump('skip:compact-summary'), []
  if (t === 'assistant' && o.isApiErrorMessage) return bump('skip:api-error'), []
  const base = `${o.sessionId}:${o.uuid}`
  const ts = String(o.timestamp ?? new Date().toISOString())
  const c = o.message?.content
  const out: ThreadItem[] = []
  if (t === 'user' && typeof c === 'string') {
    if (o.origin?.kind === 'channel') {
      const ch = parseChannel(c)
      const r = cut(redact(ch ? ch.body : c), MAX_TEXT)
      const kind = ch?.attrs.kind
      out.push({
        entry_id: `${base}:0`,
        ts,
        entry_kind: kind === 'user_direct' ? 'user_direct' : 'channel_message',
        message_id: ch?.attrs.message_id ?? ch?.attrs.request_id ?? null,
        ...r,
        text: kind && kind !== 'user_direct' ? `[${kind}] ${r.text}` : r.text,
      })
      bump('emit:user:channel')
    } else if (o.isMeta || SKIP_USER_PREFIX.some(p => c.trimStart().startsWith(p))) bump('skip:user:meta-or-command')
    else {
      out.push({ entry_id: `${base}:0`, ts, entry_kind: 'terminal_input', ...cut(redact(c), MAX_TEXT) })
      bump('emit:user:terminal')
    }
    return out
  }
  if (!Array.isArray(c)) return bump('skip:no-content'), []
  c.forEach((b: any, i: number) => {
    const entry_id = `${base}:${i}`
    switch (b?.type) {
      case 'text': {
        const text = String(b.text ?? '')
        if (t === 'assistant') {
          out.push({ entry_id, ts, entry_kind: 'assistant_message', ...cut(redact(text), MAX_TEXT) })
          bump('emit:assistant')
        } else if (!o.isMeta && !SKIP_USER_PREFIX.some(p => text.trimStart().startsWith(p))) {
          out.push({ entry_id, ts, entry_kind: 'terminal_input', ...cut(redact(text), MAX_TEXT) })
          bump('emit:user:text-block')
        } else bump('skip:user:meta-text')
        break
      }
      case 'tool_use': {
        const name = String(b.name ?? '?')
        if (HIDDEN_TOOLS.test(name)) {
          st.hiddenToolUses.add(b.id)
          bump('skip:tool_use:reply')
          break
        }
        const path = b.input?.file_path ?? b.input?.notebook_path ?? b.input?.path
        if (typeof path === 'string' && SENSITIVE_PATH.test(path)) {
          st.sensitiveToolUses.add(b.id)
          out.push({ entry_id, ts, entry_kind: 'tool_summary', tool: name, tool_use_id: b.id, text: `${name}: [sensitive file]` })
          bump('emit:tool_use:sensitive')
          break
        }
        const r = cut(redact(JSON.stringify(b.input ?? {})), MAX_TOOL_INPUT)
        out.push({ entry_id, ts, entry_kind: 'tool_summary', tool: name, tool_use_id: b.id, ...r, text: `${name}: ${r.text}` })
        bump('emit:tool_use')
        break
      }
      case 'tool_result': {
        if (st.hiddenToolUses.has(b.tool_use_id)) {
          bump('skip:tool_result:reply')
          break
        }
        if (st.sensitiveToolUses.has(b.tool_use_id)) {
          out.push({ entry_id, ts, entry_kind: 'tool_result', tool_use_id: b.tool_use_id, text: '[sensitive file content hidden]' })
          bump('emit:tool_result:sensitive')
          break
        }
        const rc = b.content
        const s =
          typeof rc === 'string' ? rc : Array.isArray(rc) ? rc.map((x: any) => (x?.type === 'text' ? String(x.text ?? '') : `[${x?.type}]`)).join('\n') : ''
        const r = cut(redact(s), MAX_TOOL_RESULT)
        out.push({ entry_id, ts, entry_kind: 'tool_result', tool_use_id: b.tool_use_id, ...r, text: (b.is_error ? '[error] ' : '') + r.text })
        bump('emit:tool_result')
        break
      }
      case 'thinking':
      case 'redacted_thinking':
        bump('skip:thinking')
        break
      default:
        bump(`skip:block:${b?.type}`)
    }
  })
  return out
}

// incremental tail: complete lines (ending in \n) from a byte offset
export function readFrom(path: string, offset: number): { lines: string[]; next: number; reset: boolean; ino: number } {
  const fd = openSync(path, 'r')
  try {
    const st = fstatSync(fd)
    if (st.size < offset) return { lines: [], next: 0, reset: true, ino: st.ino }
    const buf = Buffer.alloc(st.size - offset)
    readSync(fd, buf, 0, buf.length, offset)
    const lastNl = buf.lastIndexOf(0x0a)
    if (lastNl < 0) return { lines: [], next: offset, reset: false, ino: st.ino }
    const lines = buf.subarray(0, lastNl).toString('utf8').split('\n').filter(Boolean)
    return { lines, next: offset + lastNl + 1, reset: false, ino: st.ino }
  } finally {
    closeSync(fd)
  }
}

export const encodeCwd = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-')

// local paths are not sent to the hub: the project folder becomes <project>, the home folder ~, and any other
// absolute path a stable `<path:hash>`
export function maskPaths(cwd: string, home = homedir()): (s: string) => string {
  const pairs: [string, string][] = [[cwd, '<project>']]
  try {
    const real = realpathSync(cwd)
    if (real !== cwd) pairs.push([real, '<project>'])
  } catch {}
  if (home && home.length > 1) pairs.push([home, '~'])
  return s => maskAbsPaths(pairs.reduce((acc, [from, to]) => acc.split(from).join(to), s))
}

// ---------------------------------------------------------------- adapter
export type WatchedSession = { key: string; project: string; role: SessionRole; pm_session: string | null; cwd: string; conversation_id: string }
type Pos = { path: string | null; offset: number; ino: number; coverage: string | null }
type Watcher = { s: WatchedSession; pos: Pos; since: number; st: ConvertState; fsw: FSWatcher | null; lastGlob: number }

export type AdapterOptions = {
  stateDir: string
  home: string // HANNIGAN_HOME, for the secrets to redact
  emit: (e: WorkerEvent) => void
  redactSensitive: boolean
  projectsRoot?: string // default ~/.claude/projects
  testedVersions?: string[]
  graceMs?: number // file not found this long after watch() -> coverage 'unavailable' (default 60 s)
  pollMs?: number // default 2 s
}

export class TranscriptAdapter {
  private w = new Map<string, Watcher>()
  private file: string
  private saved: Record<string, Pos>
  private redactor: Redactor
  private root: string
  private timer: ReturnType<typeof setInterval> | null = null
  readonly stats: Stats = {}

  constructor(private o: AdapterOptions) {
    this.file = join(o.stateDir, 'transcripts.json')
    this.saved = readJson<Record<string, Pos>>(this.file, {})
    this.redactor = makeRedactor(hanniganSecrets(o.home), o.redactSensitive)
    this.root = o.projectsRoot ?? join(homedir(), '.claude', 'projects')
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), this.o.pollMs ?? 2000)
  }

  close(): void {
    if (this.timer) clearInterval(this.timer)
    for (const w of this.w.values()) w.fsw?.close()
  }

  watching(key: string): boolean {
    return this.w.has(key)
  }

  watch(s: WatchedSession): void {
    const old = this.w.get(s.key)
    if (old) {
      old.s = s
      return
    }
    const pos = this.saved[s.key] ?? { path: null, offset: 0, ino: 0, coverage: null }
    this.w.set(s.key, { s, pos, since: Date.now(), st: newConvertState(), fsw: null, lastGlob: 0 })
    this.read(s.key)
  }

  unwatch(key: string): void {
    const w = this.w.get(key)
    if (!w) return
    this.read(key) // last lines written before the session ended
    w.fsw?.close()
    this.w.delete(key)
  }

  tick(): void {
    for (const k of [...this.w.keys()]) this.read(k)
  }

  private locate(w: Watcher): string | null {
    const id = w.s.conversation_id || w.s.key
    if (w.pos.path && existsSync(w.pos.path)) return w.pos.path
    const first = join(this.root, encodeCwd(w.s.cwd), `${id}.jsonl`)
    if (existsSync(first)) return first
    // fallback: any project folder (long cwd hashing, /cd); globbing is throttled
    if (Date.now() - w.lastGlob < 10000) return null
    w.lastGlob = Date.now()
    try {
      for (const d of readdirSync(this.root)) {
        const f = join(this.root, d, `${id}.jsonl`)
        if (existsSync(f)) return f
      }
    } catch {}
    return null
  }

  private coverage(w: Watcher, value: 'transcript' | 'partial' | 'unavailable'): void {
    if (w.pos.coverage === value) return
    w.pos.coverage = value
    this.persist(w)
    this.o.emit({
      kind: 'thread_entry',
      session: w.s.key,
      project: w.s.project,
      role: w.s.role,
      pm_session: w.s.pm_session,
      entry_id: `${w.s.key}:coverage:${value}:${Date.now()}`,
      entry_kind: 'coverage',
      source: 'transcript',
      text: value,
      ts: new Date().toISOString(),
    })
  }

  private read(key: string): void {
    const w = this.w.get(key)
    if (!w) return
    try {
      const path = this.locate(w)
      if (!path) {
        if (Date.now() - w.since > (this.o.graceMs ?? 60000)) this.coverage(w, 'unavailable')
        return
      }
      if (w.pos.path !== path) {
        w.pos = { ...w.pos, path, offset: 0, ino: 0 }
      }
      if (!w.fsw) {
        try {
          w.fsw = watch(path, { persistent: false }, () => setTimeout(() => this.read(key), 50))
        } catch {}
      }
      let r = readFrom(path, w.pos.offset)
      if (r.reset || (w.pos.ino && r.ino !== w.pos.ino)) {
        // replaced or truncated: read again from the start; entry_id dedup at the hub drops repeats
        w.pos.offset = 0
        r = readFrom(path, 0)
      }
      w.pos.ino = r.ino
      const mask = maskPaths(w.s.cwd)
      for (const line of r.lines) {
        let o: any
        try {
          o = JSON.parse(line)
        } catch {
          this.stats['bad_line'] = (this.stats['bad_line'] ?? 0) + 1
          continue
        }
        for (const it of convertLine(o, this.redactor.redact, this.stats, w.st)) {
          this.o.emit({
            kind: 'thread_entry',
            session: w.s.key,
            project: w.s.project,
            role: w.s.role,
            pm_session: w.s.pm_session,
            entry_id: it.entry_id,
            entry_kind: it.entry_kind,
            source: 'transcript',
            text: mask(it.text),
            message_id: it.message_id ?? null,
            ts: it.ts,
          })
        }
      }
      const changed = r.next !== w.pos.offset
      w.pos.offset = r.next
      const tested = this.o.testedVersions ?? TESTED_VERSIONS
      if (w.st.versions.size) this.coverage(w, [...w.st.versions].every(v => tested.includes(v)) ? 'transcript' : 'partial')
      else if (statSync(path).size > 0 && !w.pos.coverage) this.coverage(w, 'transcript')
      if (changed) this.persist(w)
    } catch (e) {
      log('transcript', 'read error', { session: key, err: String((e as Error).message ?? e) })
    }
  }

  private persist(w: Watcher): void {
    this.saved[w.s.key] = w.pos
    writeJsonAtomic(this.file, this.saved)
  }
}
