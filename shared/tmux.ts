// Thin tmux wrapper. Arguments are passed as argv (never through a shell).
import { spawnSync } from 'child_process'

const TMUX = process.env.HANNIGAN_TMUX_BIN ?? 'tmux'

function run(args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync(TMUX, args, { encoding: 'utf8' })
  return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? '' }
}

export function hasSession(name: string): boolean {
  return run(['has-session', '-t', `=${name}`]).ok
}

export function listSessions(): string[] {
  const r = run(['list-sessions', '-F', '#{session_name}'])
  return r.ok ? r.out.split('\n').filter(Boolean) : []
}

export function newSession(opts: {
  name: string
  cwd: string
  width: number
  height: number
  env: Record<string, string>
  argv: string[]
}): { ok: boolean; err: string } {
  // env -i keeps the session environment explicit and reproducible (no inherited secrets)
  const envArgs = Object.entries(opts.env).map(([k, v]) => `${k}=${v}`)
  const r = run([
    'new-session',
    '-d',
    '-s',
    opts.name,
    '-x',
    String(opts.width),
    '-y',
    String(opts.height),
    '-c',
    opts.cwd,
    'env',
    '-i',
    ...envArgs,
    ...opts.argv,
  ])
  if (r.ok) run(['set-option', '-t', `=${opts.name}`, 'remain-on-exit', 'off'])
  return { ok: r.ok, err: r.err }
}

export function capture(name: string): string | null {
  const r = run(['capture-pane', '-p', '-t', `=${name}:`])
  return r.ok ? r.out : null
}

export function sendKeys(name: string, keys: string[]): boolean {
  return run(['send-keys', '-t', `=${name}:`, ...keys]).ok
}

export function sendLiteral(name: string, text: string): boolean {
  return run(['send-keys', '-t', `=${name}:`, '-l', text]).ok
}

export function killSession(name: string): boolean {
  return run(['kill-session', '-t', `=${name}`]).ok
}

// PID of the process running in the pane (the `env -i ... claude` exec chain, i.e. Claude Code itself)
export function panePid(name: string): number | null {
  const r = run(['display-message', '-p', '-t', `=${name}:`, '#{pane_pid}'])
  const n = Number(r.out.trim())
  return r.ok && Number.isInteger(n) && n > 0 ? n : null
}
