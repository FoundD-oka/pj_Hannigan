// shared/second-mac-prompt.ts: the prompt for Claude Code on another Mac (hub on a VPS: pair over https;
// hub on a Mac: tunnel then pair; legacy add-worker.ts: key)
import { expect, test } from 'bun:test'
import { lanAddresses, PLACEHOLDER_CODE, PLACEHOLDER_ID, REPO_URL, secondMacPrompt, secondMacPromptTemplate } from '../../shared/second-mac-prompt.ts'

const mac = { hubPort: 8800, hubHost: 'studio.local', hubUser: 'taro', pairUrl: 'http://127.0.0.1:8800' }
const vps = { hubPort: 8800, hubHost: 'vps', hubUser: 'hannigan', publicUrl: 'https://hannigan.found-d.com', pairUrl: 'https://hannigan.found-d.com' }

test('vps layout: health check, clone, pair over https, start; no ssh', () => {
  const p = secondMacPrompt({ ...vps, worker: 'office', credential: { kind: 'code', code: 'ABCD2345' } })
  expect(p).toContain('VPS「https://hannigan.found-d.com」')
  expect(p).toContain('curl -s https://hannigan.found-d.com/health')
  expect(p).toContain(`git clone ${REPO_URL} ~/pj-Hannigan`)
  expect(p).toContain('bun scripts/pair.ts https://hannigan.found-d.com ABCD2345 --worker office')
  expect(p).toContain('scripts/start.sh worker')
  expect(p).not.toContain('ssh ')
  expect(p).not.toContain('トンネル')
  expect(p).toContain('hub.json を作らない')
})

test('mac layout: reach the hub mac (with ips), ssh, tunnel, then pair through 127.0.0.1', () => {
  const p = secondMacPrompt({ ...mac, hubAddresses: ['192.168.50.80', '192.168.50.105'], worker: 'w', credential: { kind: 'code', code: 'C0DE' } })
  expect(p).toContain('ping -c 2 studio.local')
  expect(p).toContain('192.168.50.80、192.168.50.105')
  expect(p).toContain('同じネットワークにいない')
  expect(p).toContain('ssh -o BatchMode=yes -o ConnectTimeout=5 taro@studio.local true')
  expect(p).toContain("-L 8800:127.0.0.1:8800 taro@studio.local'")
  expect(p).toContain('bun scripts/pair.ts http://127.0.0.1:8800 C0DE --worker w')
  expect(p.indexOf('トンネル:')).toBeLessThan(p.indexOf('ペアリング:'))
  const without = secondMacPrompt({ ...mac, worker: 'w', credential: { kind: 'code', code: 'C' } })
  expect(without).toContain('IP を私に聞いてから')
})

test('legacy key credential uses worker-setup.ts with the key and hub port', () => {
  const p = secondMacPrompt({ ...mac, worker: 'w', credential: { kind: 'key', key: 'k'.repeat(64) } })
  expect(p).toContain(`bun scripts/worker-setup.ts --worker w --key ${'k'.repeat(64)} --hub-port 8800`)
  expect(p).not.toContain('bun scripts/pair.ts')
})

test('the template keeps id and code as placeholders and never contains a key', () => {
  const t = secondMacPromptTemplate(vps)
  expect(t).toContain(`bun scripts/pair.ts https://hannigan.found-d.com ${PLACEHOLDER_CODE} --worker ${PLACEHOLDER_ID}`)
  expect(t).not.toMatch(/[0-9a-f]{64}/)
  expect(t.replace(PLACEHOLDER_ID, 'office').replace(PLACEHOLDER_CODE, 'ABCD2345')).toBe(secondMacPrompt({ ...vps, worker: 'office', credential: { kind: 'code', code: 'ABCD2345' } }))
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
