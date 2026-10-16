// Per-conversation secretary contexts (Q6/B). docs/design/03-hub-worker-protocol.md §4.6, 01-config-schema.md §14.
// context_id = WebChat conv_id (validated). Each context owns one secretary session key and one folder
// under secretary.contexts.root_dir. This module holds the persistent map and the pure selection rules;
// hub.ts drives the SessionManager.
import { join } from 'path'
import { readJson, writeJsonAtomic } from '../shared/util.ts'

export const CONTEXT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export type ContextEntry = {
  context_id: string
  source: 'webchat'
  session_key: string | null // secretary session (Claude Code UUID at creation)
  created_at: string
  last_used_at: string
}

export class ContextStore {
  private map: Record<string, ContextEntry>
  constructor(
    private file: string,
    private root: string,
  ) {
    this.map = readJson<Record<string, ContextEntry>>(file, {})
  }

  private save(): void {
    writeJsonAtomic(this.file, this.map)
  }

  // folder of a context; only a validated id is ever joined into a path
  dirFor(context_id: string): string {
    if (!CONTEXT_ID_RE.test(context_id)) throw new Error(`invalid context id`)
    return join(this.root, context_id)
  }

  get(context_id: string): ContextEntry | undefined {
    return Object.hasOwn(this.map, context_id) ? this.map[context_id] : undefined
  }

  all(): ContextEntry[] {
    return Object.values(this.map)
  }

  byKey(session_key: string): ContextEntry | undefined {
    return this.all().find(c => c.session_key === session_key)
  }

  ensure(context_id: string, now = new Date().toISOString()): ContextEntry {
    if (!CONTEXT_ID_RE.test(context_id)) throw new Error(`invalid context id`)
    let c = this.get(context_id)
    if (!c) {
      c = { context_id, source: 'webchat', session_key: null, created_at: now, last_used_at: now }
      this.map[context_id] = c
      this.save()
    }
    return c
  }

  setSession(context_id: string, session_key: string): void {
    const c = this.ensure(context_id)
    c.session_key = session_key
    this.save()
  }

  touch(context_id: string, now = new Date().toISOString()): void {
    const c = this.get(context_id)
    if (!c) return
    c.last_used_at = now
    this.save()
  }
}

// secretary session states that count as "running"
export const LIVE_STATES = ['starting', 'awaiting_terminal', 'ready', 'working', 'awaiting_approval']

export type IdleInput = {
  contexts: ContextEntry[]
  stateOf: (session_key: string) => string | undefined
  busy: (context_id: string, session_key: string) => boolean // open approvals or undelivered messages
  now: number
  idleMs: number
}

// contexts whose secretary may be stopped now: ready (not working), unused for idleMs, nothing open
export function idleContexts(i: IdleInput): ContextEntry[] {
  return i.contexts.filter(c => {
    if (!c.session_key) return false
    if (i.stateOf(c.session_key) !== 'ready') return false
    if (i.now - Date.parse(c.last_used_at) < i.idleMs) return false
    return !i.busy(c.context_id, c.session_key)
  })
}

// the least recently used ready secretary that can be stopped to free a slot for another context
export function evictionCandidate(i: Omit<IdleInput, 'idleMs' | 'now'> & { except: string }): ContextEntry | undefined {
  return i.contexts
    .filter(c => c.context_id !== i.except && c.session_key && i.stateOf(c.session_key) === 'ready' && !i.busy(c.context_id, c.session_key))
    .sort((a, b) => a.last_used_at.localeCompare(b.last_used_at))[0]
}
