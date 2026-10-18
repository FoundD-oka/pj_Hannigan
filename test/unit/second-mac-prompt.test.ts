// shared/second-mac-prompt.ts: the prompt for Claude Code on the second Mac (add-worker.ts prints it with the key,
// the settings screen shows the template with placeholders)
import { expect, test } from 'bun:test'
import { lanAddresses, PLACEHOLDER_ID, PLACEHOLDER_KEY, REPO_URL, secondMacPrompt, secondMacPromptTemplate } from '../../shared/second-mac-prompt.ts'

const base = { hubPort: 8800, hubHost: 'studio.local', hubUser: 'taro' }

test('the prompt carries the worker id, key, port, hub login, repository and the commands Claude must run', () => {
  const p = secondMacPrompt({ ...base, worker: 'office', key: 'k'.repeat(64) })
  expect(p).toContain(`git clone ${REPO_URL} ~/pj-Hannigan`)
  expect(p).toContain(`bun scripts/worker-setup.ts --worker office --key ${'k'.repeat(64)} --hub-port 8800`)
  expect(p).toContain('ssh -o BatchMode=yes -o ConnectTimeout=5 taro@studio.local true')
  expect(p).toContain("-L 8800:127.0.0.1:8800 taro@studio.local'")
  expect(p).toContain('curl -s http://127.0.0.1:8800/health')
  expect(p).toContain('scripts/start.sh worker')
  expect(p).toContain('connected to hub')
  expect(p).toContain('hub.json を作らない')
  expect(p).toContain('studio.local')
})

test('the template keeps the id and key as placeholders and never contains a real key', () => {
  const t = secondMacPromptTemplate(base)
  expect(t).toContain(`--worker ${PLACEHOLDER_ID} --key ${PLACEHOLDER_KEY} --hub-port 8800`)
  expect(t).not.toMatch(/[0-9a-f]{64}/)
  // same text otherwise
  expect(t.replace(PLACEHOLDER_ID, 'office').replace(PLACEHOLDER_KEY, 'K')).toBe(secondMacPrompt({ ...base, worker: 'office', key: 'K' }))
})

test('another repository url and a plain ip work', () => {
  const p = secondMacPrompt({ worker: 'w', key: 'K', hubPort: 9000, hubHost: '192.168.1.20', hubUser: 'me', repoUrl: 'git@example.com:x/y.git' })
  expect(p).toContain('git clone git@example.com:x/y.git')
  expect(p).toContain('me@192.168.1.20')
  expect(p).toContain('-L 9000:127.0.0.1:9000')
})

test('hub addresses go into the reachability step; without them Claude asks for the ip', () => {
  const withIp = secondMacPrompt({ ...base, worker: 'w', key: 'K', hubAddresses: ['192.168.50.80', '192.168.50.105'] })
  expect(withIp).toContain('ping -c 2 studio.local')
  expect(withIp).toContain('192.168.50.80、192.168.50.105')
  expect(withIp).toContain('同じネットワークにいない')
  expect(withIp).toContain('scripts/worker-setup.ts` と `package.json` が無ければ')
  const without = secondMacPrompt({ ...base, worker: 'w', key: 'K' })
  expect(without).toContain('IP を私に聞いてから')
})

test('lanAddresses keeps non-internal IPv4 only, without duplicates', () => {
  const ifs = {
    lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    en0: [{ family: 'IPv4', internal: false, address: '192.168.50.80' }, { family: 'IPv6', internal: false, address: 'fe80::1' }],
    en1: [{ family: 4, internal: false, address: '192.168.50.105' }, { family: 'IPv4', internal: false, address: '192.168.50.80' }],
    utun0: undefined,
  }
  expect(lanAddresses(ifs as any)).toEqual(['192.168.50.80', '192.168.50.105'])
})
