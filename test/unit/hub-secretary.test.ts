// The secretary's instructions (hub/secretary.ts): the persona (01 §3.1) and the free-text guidance from hub.json
// land in the text a secretary receives at start; routing and tool rules stay whatever the persona says.
import { expect, test } from 'bun:test'
import { HubConfigSchema } from '../../shared/config.ts'
import { secretaryInstructions } from '../../hub/secretary.ts'

const cfg = (secretary: Record<string, unknown> = {}, workers: unknown[] = [{ id: 'local', display_name: 'この Mac', role: '自宅' }]) =>
  HubConfigSchema.parse({ version: 8, secretary, workers })

test('defaults: named Hannigan, language of the person, short replies, no character block', () => {
  const s = secretaryInstructions(cfg())
  expect(s).toContain('You are "Hannigan"')
  expect(s).toContain('Reply in the language the person uses.')
  expect(s).toContain('Keep replies short')
  expect(s).not.toContain('Your character')
  expect(s).not.toContain('Address the person as')
  expect(s).not.toContain('Routing guidance')
  // the routing and tool rules are always there
  expect(s).toContain('- local (この Mac): 自宅')
  expect(s).toContain('project_pm_send(worker, project, text)')
  expect(s).toContain('Never invent or guess results')
})

test('persona: name, character, user name, language and verbosity are written in', () => {
  const s = secretaryInstructions(
    cfg({
      persona: { name: 'ハニガン', character: '敬語で短く。\n結論を先に。', user_name: '健さん', language: '日本語', verbosity: 'detailed' },
    }),
  )
  expect(s).toContain('You are "ハニガン"')
  expect(s).toContain('Your character (how you speak and behave; keep it in every reply):\n敬語で短く。\n結論を先に。')
  expect(s).toContain('Address the person as "健さん".')
  expect(s).toContain('Reply in 日本語 unless the person explicitly asks for another language.')
  expect(s).toContain('Replies may be detailed')
  expect(s).not.toContain('Keep replies short')
})

test('routing notes go into the routing section, extra instructions at the end', () => {
  const s = secretaryInstructions(cfg({ routing_notes: '仕事は office。\n個人は home。', extra_instructions: 'EXTRA LAST' }))
  const routing = s.indexOf('Routing guidance from the person')
  expect(routing).toBeGreaterThan(s.indexOf('How to route work:'))
  expect(routing).toBeLessThan(s.indexOf('2. Send the request'))
  expect(s).toContain('   仕事は office。\n   個人は home。')
  expect(s.trimEnd().endsWith('EXTRA LAST')).toBe(true)
})

test('whitespace-only character / notes add nothing', () => {
  const s = secretaryInstructions(cfg({ persona: { character: '  \n ' }, routing_notes: ' ', extra_instructions: '\n' }))
  expect(s).not.toContain('Your character')
  expect(s).not.toContain('Routing guidance')
  expect(s.trimEnd().endsWith('Keep replies short: a few sentences, no restating of what the person already knows.')).toBe(true)
})
