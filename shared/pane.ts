// tmux pane parsing for terminal-only dialogs (docs/design/02-worker-daemon.md §6).
// All screen strings that depend on the Claude Code version are collected here.
import { createHash } from 'crypto'

export type PromptKind = 'dev_channel_warning' | 'workspace_trust' | 'cu_app_approval' | 'tool_permission' | 'unknown'

export type TerminalPrompt = {
  prompt_id: string
  kind: PromptKind
  title: string
  body: string
  options: string[]
  cursor: number // 0-based index of the highlighted option
}

export type PaneState = {
  prompt: TerminalPrompt | null
  working: boolean
  inputReady: boolean
}

const RULE_RE = /^\s*[─━]{40,}\s*$/
const FOOTER_RE = /(Enter to confirm|Esc to cancel)/
const CURSOR_RE = /^(\s*)❯\s/
// v2.1.296 shows a spinner line such as "✽ Hashing… (11s · ↓ 448 tokens)" or "✶ Bunning…" while working;
// older builds also showed "esc to interrupt". A finished turn reads "✻ Churned for 56s · done 20:01" (no ellipsis).
const WORKING_RE = /(esc to interrupt|^\s*[✻✶✽✢✳✺·*]\s+\S+…)/im

const KIND_PATTERNS: [PromptKind, RegExp][] = [
  ['dev_channel_warning', /WARNING: Loading development channels/],
  ['workspace_trust', /(Is this a project you created or one you trust|Yes, I trust this folder)/],
  ['cu_app_approval', /Computer Use wants to control/],
  ['tool_permission', /Do you want to proceed\?/],
]

// Option labels we choose when auto-accepting (matched against parsed labels).
export const ACCEPT_LABEL: Partial<Record<PromptKind, RegExp>> = {
  dev_channel_warning: /I am using this for local development/,
  workspace_trust: /Yes, I trust this folder/,
}

function indentOf(s: string): number {
  return s.length - s.trimStart().length
}

export function parsePane(text: string): PaneState {
  const lines = text.replace(/\r/g, '').split('\n')
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop()
  const tail = lines.slice(-25).join('\n')
  const working = WORKING_RE.test(tail)

  let lastRule = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (RULE_RE.test(lines[i]!)) {
      lastRule = i
      break
    }
  }
  const prompt = parsePrompt(lines.slice(lastRule + 1))
  // idle input box: a line starting with ❯ directly between two rules
  let inputReady = false
  if (!prompt) {
    for (let i = lines.length - 1; i > 0; i--) {
      if (RULE_RE.test(lines[i]!) && i >= 2 && /^❯(\s|$)/.test(lines[i - 1]!) && RULE_RE.test(lines[i - 2]!)) {
        inputReady = true
        break
      }
    }
  }
  return { prompt, working, inputReady: inputReady && !working }
}

export function parsePrompt(region: string[]): TerminalPrompt | null {
  let footer = -1
  for (let i = region.length - 1; i >= 0; i--) {
    if (FOOTER_RE.test(region[i]!)) {
      footer = i
      break
    }
  }
  if (footer < 0) return null
  let cursorLine = -1
  for (let i = footer - 1; i >= 0; i--) {
    if (CURSOR_RE.test(region[i]!)) {
      cursorLine = i
      break
    }
  }
  if (cursorLine < 0) return null
  const m = CURSOR_RE.exec(region[cursorLine]!)!
  const col = m[0].length // text column of options
  const isOptionAt = (s: string) => s.trim().length > 0 && (CURSOR_RE.test(s) ? CURSOR_RE.exec(s)![0].length === col : indentOf(s) === col)

  // walk up to the first option
  let start = cursorLine
  while (start - 1 >= 0) {
    const s = region[start - 1]!
    if (isOptionAt(s)) start--
    else if (s.trim() && indentOf(s) > col) start-- // wrapped continuation of an option above
    else break
  }
  // collect options downward until the footer
  const options: string[] = []
  let cursor = 0
  let firstOptionLine = start
  while (firstOptionLine < cursorLine && !isOptionAt(region[firstOptionLine]!)) firstOptionLine++
  for (let i = firstOptionLine; i < footer; i++) {
    const s = region[i]!
    if (!s.trim()) break
    if (isOptionAt(s)) {
      if (i === cursorLine) cursor = options.length
      options.push(s.slice(col).trim().replace(/^\d+\.\s+/, ''))
    } else if (indentOf(s) > col && options.length) {
      options[options.length - 1] += ' ' + s.trim()
    } else break
  }
  if (!options.length) return null

  const bodyLines = region.slice(0, firstOptionLine).map(s => s.trim()).filter(Boolean)
  const regionText = region.join('\n')
  let kind: PromptKind = 'unknown'
  for (const [k, re] of KIND_PATTERNS) {
    if (re.test(regionText)) {
      kind = k
      break
    }
  }
  const title = bodyLines[0] ?? kind
  const body = bodyLines.slice(1).join('\n')
  const prompt_id =
    'tp-' +
    createHash('sha1')
      .update(kind + '\n' + title + '\n' + options.join('\n') + '\n' + body.slice(0, 300))
      .digest('hex')
      .slice(0, 12)
  return { prompt_id, kind, title, body, options, cursor }
}

// Keys that move the cursor from `from` to `to` and confirm.
export function keysToSelect(from: number, to: number): string[] {
  const keys: string[] = []
  const d = to - from
  for (let i = 0; i < Math.abs(d); i++) keys.push(d > 0 ? 'Down' : 'Up')
  keys.push('Enter')
  return keys
}
