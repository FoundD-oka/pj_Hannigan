#!/usr/bin/env bun
// End-to-end run with the real Claude Code (uses your plan's usage). Not part of `bun test`.
// Phase 3 path: per-conversation secretary -> project_pm_send -> project PM (direct work and delegation to a task),
// a direct post to the PM thread, PM stop + resume. Evidence adds PM/task session states and lease events.
// It answers terminal dialogs and tool approvals through the WebChat API, like a person would,
// and writes evidence (events, screens, logs) to the output folder.
//
// usage: bun test/e2e-real.ts <evidence-dir> [--model <alias>] [--effort low]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { Harness, type Ev } from './harness.ts'

const args = process.argv.slice(2)
const out = args[0]
if (!out) {
  console.error('usage: bun test/e2e-real.ts <evidence-dir> [--model <alias>] [--effort <level>]')
  process.exit(1)
}
const opt = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined)
const extra = [...(opt('--model') ? ['--model', opt('--model')!] : []), '--effort', opt('--effort') ?? 'low']
mkdirSync(out, { recursive: true })

const h = new Harness({
  claudeBin: 'claude',
  projects: ['e2e'], // pm: schema defaults (enabled, hybrid)
  secretaryAutostart: false, // Phase 3: the secretary of a conversation starts with its first message
  workerSession: { extra_args: extra },
  pmSession: { extra_args: extra },
  secretarySession: { extra_args: extra },
})
const T = 240000
const CONV = 'conv-e2e'
const results: { step: string; ok: boolean; detail: string; at: string }[] = []
const step = (name: string, ok: boolean, detail = '') => {
  results.push({ step: name, ok, detail, at: new Date().toISOString() })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}

// --- auto answerer: plays the person on WebChat
const answered = new Set<string>()
const policyLog: string[] = []
let denyPattern: RegExp | null = null
let answering = true
async function answerLoop(): Promise<void> {
  while (answering) {
    const open = (await h.api('/api/state').catch(() => ({ json: null }))).json?.approvals ?? []
    for (const a of open) {
      if (answered.has(a.approval_id)) continue
      answered.add(a.approval_id)
      let choice: string | number
      if (a.type === 'tool') choice = denyPattern && denyPattern.test(a.body + a.title) ? 'deny' : 'allow'
      else if (a.prompt_kind === 'workspace_trust') choice = a.options.findIndex((o: string) => /trust this folder/.test(o))
      else if (a.prompt_kind === 'dev_channel_warning') choice = a.options.findIndex((o: string) => /local development/.test(o))
      else {
        policyLog.push(`left unanswered: ${a.prompt_kind} ${a.title}`)
        continue
      }
      const r = await h.api('/api/answer', { approval_id: a.approval_id, choice })
      policyLog.push(`${new Date().toISOString()} ${a.worker}/${a.project} ${a.type}:${a.prompt_kind ?? a.title} -> ${choice} (${r.status})`)
    }
    await Bun.sleep(700)
  }
}

const reply = (s0: number, re: RegExp, what: string) =>
  h.waitEvent(e => e.kind === 'secretary_reply' && e.conv_id === CONV && re.test(String(e.text)), s0, T, what)
// a PM report answering a secretary request (project_pm_send -> request_id -> routed back to this conversation)
const pmReport = (s0: number, what: string) =>
  h.waitEvent(e => e.kind === 'worker_report' && e.role === 'pm' && e.origin === 'request' && e.routed === true, s0, T, what)
const fileHas = (name: string, text: string) => existsSync(join(h.projectDirs.e2e!, name)) && readFileSync(join(h.projectDirs.e2e!, name), 'utf8').includes(text)

let pmKey = ''
try {
  h.startHub()
  await h.waitHttp()
  h.startWorker()
  void answerLoop()
  await h.waitEvent(e => e.kind === 'worker_link' && e.connected === true, 0, T, 'worker connected')

  // 1. PM works directly: secretary -> project_pm_send -> PM -> report with request_id -> same conversation
  let s0 = h.lastSeq()
  await h.send(
    '「テスト Mac」の e2e プロジェクトの PM に依頼して。hello.txt というファイルを作って、中身を「hannigan-e2e-ok」の1行だけにしてもらって。小さい作業なので PM 自身で片付けてよい。終わったら結果を教えて。',
    CONV,
  )
  await h.waitEvent(e => e.kind === 'session_state' && e.worker === '_secretary' && e.context_id === CONV && e.state === 'ready', s0, T, 'secretary ready')
  step('会話の最初のメッセージで秘書が起動し、端末ダイアログを WebChat の API から回答して ready になった', true)
  const acc = await h.waitEvent(e => e.kind === 'request_state' && e.context_id === CONV && e.state === 'accepted', s0, T, 'project_pm_send')
  step('秘書が project_pm_send で案件 PM に依頼した（request_id 発行）', true, String(acc.request_id))
  const pm = await h.waitEvent(e => e.kind === 'session_state' && e.worker === 'local' && e.role === 'pm' && e.project === 'e2e', s0, T, 'PM session')
  pmKey = pm.session
  step('ワーカーで案件 PM（role=pm）が起動した', true, pmKey)
  const r1 = await pmReport(s0, 'PM report 1')
  step('PM が request_id 付きで報告し、依頼元の会話に配送された', r1.request_id === acc.request_id && r1.context_id === CONV, `report: ${String(r1.text).slice(0, 120)}`)
  step('hello.txt が作られた', fileHas('hello.txt', 'hannigan-e2e-ok'))
  const rep1 = await reply(r1.seq, /./, 'secretary reply after report 1')
  step('秘書が報告を同じ会話に返した', rep1.conv_id === CONV, String(rep1.text).slice(0, 160))
  step('通常ツールの承認を WebChat から許可した', h.events().some(e => e.seq > s0 && e.kind === 'approval_closed' && String(e.result) === 'webchat:allow'))

  // 2. PM delegates to a task; the task report goes through the PM with the original request_id
  s0 = h.lastSeq()
  await h.send(
    '同じ e2e プロジェクトの PM に依頼して。今回は PM 自身では書かずに、task_create で子セッションを作って委任すること。子に world.txt を作らせて、中身は「hannigan-task-ok」の1行だけ。子の報告を確認してから結果を教えて。',
    CONV,
  )
  const acc2 = await h.waitEvent(e => e.kind === 'request_state' && e.context_id === CONV && e.state === 'accepted', s0, T, 'project_pm_send 2')
  const created = await h.waitEvent(e => e.kind === 'task_event' && e.action === 'created' && e.pm_session === pmKey, s0, T, 'task created')
  step('PM が子セッション（role=task）を作って委任した', true, String(created.task_session))
  const tr = await h.waitEvent(e => e.kind === 'worker_report' && e.role === 'task' && e.session === created.task_session, s0, T, 'task report')
  step('子の報告は秘書ではなく PM に届いた（routed=false）', tr.routed === false && tr.pm_session === pmKey)
  const r2 = await h.waitEvent(e => e.kind === 'worker_report' && e.role === 'pm' && e.request_id === acc2.request_id && e.routed === true, tr.seq, T, 'PM report 2')
  step('PM が元の request_id で子の結果を報告した', r2.context_id === CONV, String(r2.text).slice(0, 160))
  step('world.txt が作られた', fileHas('world.txt', 'hannigan-task-ok'))
  const held = h.events().filter(e => e.seq > s0 && e.kind === 'resource_lease_state' && e.state === 'held').map(e => e.session)
  step('書込権（lease）を PM と子が順に取得した', held.includes(created.task_session), held.join(', '))

  // 3. deny a tool call of the PM
  denyPattern = /denied-marker/
  s0 = h.lastSeq()
  await h.send('e2e プロジェクトの PM に、Bash で「touch denied-marker.txt」を実行してもらって。拒否されたらそのまま報告して。', CONV)
  await h.waitEvent(e => e.kind === 'approval_closed' && String(e.result) === 'webchat:deny', s0, T, 'deny closed')
  const r3 = await pmReport(s0, 'PM report 3')
  step('PM のツール承認を WebChat から拒否した（ファイルは作られない）', !existsSync(join(h.projectDirs.e2e!, 'denied-marker.txt')), String(r3.text).slice(0, 160))
  denyPattern = null

  // 4. direct post to the PM thread (no secretary in between); the answer stays in the PM thread
  const word = `ゆうぐれ-${Date.now() % 10000}`
  s0 = h.lastSeq()
  const d = await h.api('/api/thread/send', { worker: 'local', session: pmKey, msg_id: `d-${Date.now()}`, text: `合言葉「${word}」を覚えておいて。覚えたら一言だけ返事して。` })
  step('WebChat から PM スレッドへ直接投稿できた', d.status === 200, JSON.stringify(d.json))
  const dr = await h.waitEvent(e => e.kind === 'worker_report' && e.session === pmKey && e.origin === 'user_direct', s0, T, 'PM direct answer')
  step('直接投稿への PM の返事は PM スレッドに残り、秘書へは配送されなかった', dr.routed === false, String(dr.text).slice(0, 120))

  // 5. stop the PM, then a new request resumes it with its history
  s0 = h.lastSeq()
  const stop = await h.api('/api/session/stop', { worker: 'local', session: pmKey })
  await h.waitEvent(e => e.kind === 'session_state' && e.session === pmKey && e.state === 'stopped', s0, T, 'PM stopped')
  step('WebChat の停止ボタン相当で PM を終了した', stop.json?.ok === true)
  s0 = h.lastSeq()
  await h.send('e2e プロジェクトの PM に、さっき直接伝えた合言葉を聞いて、その答えを教えて。', CONV)
  const r5 = await pmReport(s0, 'PM report after resume')
  step('PM の再開で履歴が維持された（合言葉を答えた）', String(r5.text).includes(word), `expected ${word}; report: ${String(r5.text).slice(0, 120)}`)
  step('再開後もチャネル登録が維持された（再開した PM から報告が届いた）', r5.session === pmKey)
} catch (e) {
  step('実行中にエラー', false, String((e as Error).message).slice(0, 2000))
} finally {
  answering = false
  // evidence
  const events = h.events()
  const mask = (s: string) =>
    s
      .split(h.token).join('<webchat-token>')
      .split(process.env.HOME ?? '/Users/x').join('~')
      .split(h.dir).join('<tmp>')
      .replaceAll('/private<tmp>', '<tmp>')
      .replace(/(\/private)?\/var\/folders\/[^\s"\\]*/g, '<tmp>') // also truncated temp paths in report excerpts
  writeFileSync(join(out, 'events.jsonl'), mask(events.map(e => JSON.stringify(e)).join('\n') + '\n'))
  writeFileSync(join(out, 'answers.log'), mask(policyLog.join('\n') + '\n'))
  // Phase 3: PM / task session states and the workspace lease history
  const pick = (kinds: string[]) => events.filter(e => kinds.includes(e.kind)).map(e => JSON.stringify(e)).join('\n') + '\n'
  writeFileSync(join(out, 'sessions.jsonl'), mask(pick(['session_state', 'task_event', 'secretary_context'])))
  writeFileSync(join(out, 'leases.jsonl'), mask(pick(['resource_lease_state', 'resource_wait'])))
  const threads = await h.api('/api/threads').catch(() => ({ json: null }))
  writeFileSync(join(out, 'threads.json'), mask(JSON.stringify(threads.json, null, 2)))
  for (const s of h.tmuxSessions()) writeFileSync(join(out, `pane-${s.replace(h.prefix, 'hn')}.txt`), mask(h.capture(s)))
  for (const f of ['hub', 'worker']) {
    const logs = Bun.spawnSync(['sh', '-c', `cat ${h.dir}/${f}-*.log`]).stdout.toString()
    writeFileSync(join(out, `${f}.log`), mask(logs))
  }
  writeFileSync(join(out, 'results.json'), mask(JSON.stringify({ claude_version: Bun.spawnSync(['claude', '--version']).stdout.toString().trim(), extra_args: extra, results }, null, 2)))
  console.log(`evidence: ${out}`)
  await h.cleanup()
  process.exit(results.every(r => r.ok) ? 0 : 1)
}
