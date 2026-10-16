// Secrets: one value per file under $HANNIGAN_HOME/secrets (dir 700, files 600).
// All secret I/O goes through this module so it can later move to the OS keychain.
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomBytes, timingSafeEqual } from 'crypto'

export function secretsDir(home: string): string {
  const d = join(home, 'secrets')
  if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 })
  chmodSync(d, 0o700)
  return d
}

export function secretPath(home: string, name: string): string {
  return join(secretsDir(home), name)
}

function warnPerms(file: string): void {
  const mode = statSync(file).mode & 0o777
  if (mode & 0o077) process.stderr.write(`hannigan: warning: ${file} is readable by others (mode ${mode.toString(8)})\n`)
}

export function readSecret(home: string, name: string): string | null {
  const f = secretPath(home, name)
  if (!existsSync(f)) return null
  warnPerms(f)
  const v = readFileSync(f, 'utf8').trim()
  return v || null
}

export function writeSecret(home: string, name: string, value: string): string {
  const f = secretPath(home, name)
  writeFileSync(f, value + '\n', { mode: 0o600 })
  chmodSync(f, 0o600)
  return f
}

export function newToken(): string {
  return randomBytes(32).toString('hex')
}

export function ensureSecret(home: string, name: string): string {
  return readSecret(home, name) ?? (writeSecret(home, name, newToken()), readSecret(home, name)!)
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export function readWorkerKeys(home: string): Record<string, string> {
  const raw = readSecret(home, 'worker-keys.json')
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Record<string, string>
  } catch {
    process.stderr.write('hannigan: secrets/worker-keys.json is not valid JSON\n')
    return {}
  }
}
