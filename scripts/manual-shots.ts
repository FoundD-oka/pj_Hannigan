#!/usr/bin/env bun
// Takes the screenshots for docs/manual with the real hub + worker + real Claude Code (uses plan usage, --effort low),
// driving the WebChat page in headless Chrome over the DevTools protocol (no npm dependency).
// usage: bun scripts/manual-shots.ts <out-dir> [--settings-only|--fake-chat] [--dry]   (--settings-only: fake Claude, settings screens only; --fake-chat: fake Claude, chat / thread / phone)
import { mkdirSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { Harness, type Ev } from '../test/harness.ts'

const out = process.argv[2]
if (!out) throw new Error('usage: bun manual-shots.ts <out-dir>')
mkdirSync(out, { recursive: true })
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const T = 240000
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a)

// ------------------------------------------------------------------ CDP client
class CDP {
  private ws!: WebSocket
  private id = 0
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private listeners: ((m: any) => void)[] = []
  proc!: ReturnType<typeof Bun.spawn>
  async launch(port: number, profile: string): Promise<void> {
    this.proc = Bun.spawn(
      [CHROME, '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
       '--window-size=1280,900', '--hide-scrollbars', '--force-color-profile=srgb', '--lang=ja', 'about:blank'],
      { stdout: 'ignore', stderr: 'ignore' },
    )
    let targets: any[] = []
    for (let i = 0; i < 50; i++) {
      try {
        targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
        if (targets.some(t => t.type === 'page')) break
      } catch {}
      await Bun.sleep(200)
    }
    const page = targets.find(t => t.type === 'page')
    if (!page) throw new Error('chrome did not expose a page target')
    this.ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise<void>((res, rej) => { this.ws.onopen = () => res(); this.ws.onerror = () => rej(new Error('ws error')) })
    this.ws.onmessage = ev => {
      const m = JSON.parse(String(ev.data))
      if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id)!; this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result) }
      else for (const l of this.listeners) l(m)
    }
    await this.send('Page.enable')
    await this.send('Runtime.enable')
    await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
    // confirm() dialogs (stop / cancel buttons): accept them like a person clicking OK
    this.listeners.push(m => { if (m.method === 'Page.javascriptDialogOpening') void this.send('Page.handleJavaScriptDialog', { accept: true }) })
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.id
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) })
  }
  async goto(url: string): Promise<void> {
    await this.send('Page.navigate', { url })
    await Bun.sleep(800)
  }
  async eval<T = unknown>(expr: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails))
    return r.result.value as T
  }
  async viewport(w: number, h: number, mobile = false): Promise<void> {
    await this.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile })
  }
  async shot(name: string, opts: { full?: boolean } = {}): Promise<void> {
    await Bun.sleep(500)
    const params: Record<string, unknown> = { format: 'png' }
    if (opts.full) {
      const h = await this.eval<number>('Math.min(document.documentElement.scrollHeight, 2600)')
      params.captureBeyondViewport = true
      params.clip = { x: 0, y: 0, width: 1280, height: h, scale: 1 }
    }
    const r = await this.send('Page.captureScreenshot', params)
    writeFileSync(join(out, name + '.png'), Buffer.from(r.data, 'base64'))
    log('shot', name)
  }
  async close(): Promise<void> { try { await this.send('Browser.close') } catch {} this.proc.kill() }
}

// ------------------------------------------------------------------ scenario
const extra = ['--effort', 'low']
const SETTINGS_ONLY = process.argv.includes('--settings-only')
const FAKE_CHAT = process.argv.includes('--fake-chat') // fake Claude: a conversation, a thread and the phone view, for checking the UI
const FAKE = SETTINGS_ONLY || FAKE_CHAT
const demoHome = join(process.env.HOME!, 'hannigan-manual-demo')
if (FAKE) mkdirSync(join(demoHome, 'notes'), { recursive: true })
const h = new Harness({
  ...(FAKE ? { projectPaths: { notes: join(demoHome, 'notes') } } : { claudeBin: 'claude' }),
  projects: ['notes'],
  secretaryAutostart: false,
  workerSession: { extra_args: extra },
  pmSession: { extra_args: extra },
  secretarySession: { extra_args: extra },
  hubExtra: { workers: [{ id: 'local', display_name: '自宅 Mac', role: '私用。個人のメモと開発' }], offline_queue: { enabled: true, ttl_minutes: 1440, max_pending_per_worker: 100 } },
})
const notes = h.projectDirs.notes!
writeFileSync(join(notes, 'README.md'), '# notes\n\n個人のメモ置き場。\n')
const CONV = 'c20261017-demo'
const cdp = new CDP()
const page = () => `${h.url('/')}#token=${h.token}`

// a person on WebChat: click the buttons of approval cards the way the manual tells the reader to
async function clickApproval(a: any): Promise<string> {
  let label: string
  if (a.type === 'tool') label = '許可'
  else if (a.prompt_kind === 'workspace_trust') label = a.options.find((o: string) => /trust this folder/i.test(o))
  else if (a.prompt_kind === 'dev_channel_warning') label = a.options.find((o: string) => /local development/i.test(o))
  else return 'skip'
  const ok = await cdp.eval<boolean>(`(() => { const c = document.getElementById('ap-${a.approval_id}'); if (!c) return false;
    const b = [...c.querySelectorAll('.btns button')].find(x => x.textContent === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true })()`)
  return ok ? label : 'missing'
}
// wait until an approval card with this predicate is open, screenshot it, then answer it in the page
async function approvalShot(name: string | null, pred: (a: any) => boolean, after: number): Promise<void> {
  const t0 = Date.now()
  while (Date.now() - t0 < T) {
    const open = (await h.api('/api/state')).json?.approvals ?? []
    const a = open.find(pred)
    if (a) {
      await Bun.sleep(600) // let SSE paint the card
      if (name) { await cdp.eval(`(() => { const c = document.getElementById('ap-${a.approval_id}'); c && c.scrollIntoView({ block: 'center' }) })()`); await cdp.shot(name) }
      const r = await clickApproval(a)
      log('answered', a.prompt_kind ?? a.title, '->', r)
      if (r === 'missing') await h.api('/api/answer', { approval_id: a.approval_id, choice: a.type === 'tool' ? 'allow' : 0 })
      await h.waitEvent(e => e.kind === 'approval_closed' && e.approval_id === a.approval_id, after, T, 'approval closed')
      return
    }
    await Bun.sleep(400)
  }
  throw new Error('approval not seen: ' + name)
}
// answer every approval that appears until `done` resolves (screens for the named kinds only once)
async function answerUntil<T>(done: Promise<T>, shots: Record<string, string>, after: number): Promise<T> {
  let finished = false
  const taken = new Set<string>()
  const settled = done.then(v => { finished = true; return v })
  while (!finished) {
    const open = (await h.api('/api/state').catch(() => ({ json: null }))).json?.approvals ?? []
    for (const a of open) {
      const kind = a.type === 'tool' ? `tool:${a.title.split(':')[0]}` : a.prompt_kind
      const name = shots[kind]
      if (name && !taken.has(kind)) { taken.add(kind); await Bun.sleep(600); await cdp.eval(`(() => { const c = document.getElementById('ap-${a.approval_id}'); c && c.scrollIntoView({ block: 'center' }) })()`); await cdp.shot(name) }
      const r = await clickApproval(a)
      if (r === 'missing') await h.api('/api/answer', { approval_id: a.approval_id, choice: a.type === 'tool' ? 'allow' : 0 })
      if (r !== 'skip') await h.waitEvent(e => e.kind === 'approval_closed' && e.approval_id === a.approval_id, after, T, 'approval closed').catch(() => {})
    }
    await Bun.sleep(500)
  }
  return settled
}
const typeAndSend = async (text: string) => {
  await cdp.eval(`(() => { const ta = document.getElementById('t'); ta.value = ${JSON.stringify(text)}; ta.dispatchEvent(new Event('input')); })()`)
  await cdp.shot('typing')
  await cdp.eval(`document.getElementById('f').requestSubmit()`)
}
const pmReport = (s0: number, what: string) => h.waitEvent(e => e.kind === 'worker_report' && e.role === 'pm' && e.origin === 'request' && e.routed === true, s0, T, what)
const reply = (s0: number) => h.waitEvent(e => e.kind === 'secretary_reply' && e.conv_id === CONV, s0, T, 'secretary reply')

let pmKey = ''
try {
  h.startHub(); await h.waitHttp(); h.startWorker()
  await h.waitEvent(e => e.kind === 'worker_link' && e.connected === true, 0, T, 'worker connected')
  await cdp.launch(h.port + 7, join(h.dir, 'chrome-profile'))
  await cdp.viewport(1280, 900)
  await cdp.goto(page())
  await cdp.eval(`localStorage.setItem('hn_conv', '${CONV}'); localStorage.setItem('hn_convs', '["${CONV}"]')`)
  await cdp.goto(h.url('/'))
  await Bun.sleep(1200)
  await cdp.shot('01-home')
  if (process.argv.includes('--dry')) throw new Error('dry run done')
  if (FAKE_CHAT) {
    const s0 = h.lastSeq()
    await typeAndSend('pm local notes direct:README を読んで要約して')
    await answerUntil(reply(s0), { dev_channel_warning: 'fake-approval' }, s0)
    await Bun.sleep(800)
    await cdp.shot('fake-chat')
    await cdp.eval(`document.getElementById('themeBtn').click()`)
    await Bun.sleep(300)
    await cdp.shot('fake-chat-dark')
    await cdp.eval(`document.getElementById('themeBtn').click()`)
    await cdp.eval(`(() => { const r = document.querySelector('#threads .row'); r && r.click() })()`)
    await Bun.sleep(1200)
    await cdp.shot('fake-thread')
    await cdp.eval(`(() => { const b = [...document.querySelectorAll('#thread button')].find(x => /会話へ戻る/.test(x.textContent)); b && b.click() })()`)
    await cdp.viewport(390, 844)
    await Bun.sleep(600)
    await cdp.shot('fake-phone')
    await cdp.eval(`document.getElementById('panelBtn').click()`)
    await Bun.sleep(400)
    await cdp.shot('fake-phone-panel')
    throw new Error('fake chat done')
  }
  if (SETTINGS_ONLY) {
    await cdp.eval(`document.getElementById('settingsBtn').click()`)
    await Bun.sleep(1500)
    await cdp.shot('16-settings-persona') // the persona card is the first thing in 設定
    await cdp.eval(`(() => { const h = [...document.querySelectorAll('#settings h2')].find(x => /ハブ/.test(x.textContent)); h && h.scrollIntoView({ block: 'start' }); scrollBy(0, -240) })()`)
    await cdp.shot('11-settings-hub')
    await cdp.eval(`(() => { const h = [...document.querySelectorAll('#settings h2')].find(x => /ワーカー/.test(x.textContent)); h && h.scrollIntoView({ block: 'start' }); scrollBy(0, -60) })()`)
    await cdp.shot('11-settings-worker')
    await cdp.eval(`(() => { const b = [...document.querySelectorAll('#settings button')].find(x => /案件を追加/.test(x.textContent)); b && b.click() })()`)
    await Bun.sleep(600)
    await cdp.eval(`(() => { const box = document.querySelector('.proj-edit.new'); if (!box) return; const ins = box.querySelectorAll('input[type=text], textarea');
      const set = (i, v) => { if (ins[i]) { ins[i].value = v; ins[i].dispatchEvent(new Event('input')) } }; set(0, 'blog'); set(1, '~/work/blog'); set(2, '個人ブログの原稿'); box.scrollIntoView({ block: 'center' }) })()`)
    await cdp.shot('12-settings-add-project')
    await cdp.eval(`(() => { const h = [...document.querySelectorAll('#settings h2')].find(x => /2 台目/.test(x.textContent)); h && h.scrollIntoView({ block: 'start' }); scrollBy(0, -240) })()`)
    await cdp.shot('17-settings-second-mac')
    throw new Error('settings done')
  }

  // 1. first request: secretary starts (terminal confirmations), PM starts, PM writes a file (tool approval)
  let s0 = h.lastSeq()
  const ask1 = '自宅 Mac の notes で、TODO.md を作って「買い物リストを作る」「来週の予定を整理する」の2行を書いて。小さい作業なので PM 自身でやって。終わったら一言で教えて'
  await typeAndSend(ask1)
  const r1 = await answerUntil(pmReport(s0, 'PM report 1'), { dev_channel_warning: '03-approval-dev-channel', workspace_trust: '04-approval-trust', 'tool:Write': '05-approval-tool' }, s0)
  pmKey = r1.session
  await reply(r1.seq)
  await Bun.sleep(1500)
  await cdp.eval(`scrollTo(0, document.body.scrollHeight)`)
  await cdp.eval(`(() => { const d = [...document.querySelectorAll('details.worker')].pop(); if (d) d.open = true })()`)
  await cdp.shot('06-first-roundtrip')

  // 2. delegation to a task
  s0 = h.lastSeq()
  const ask2 = 'notes の PM に、今度は PM 自身では書かずに子セッションを作って任せて。子に IDEAS.md を作らせて「週末に試したいこと」を3つ箇条書きで書かせて。子の報告を確認してから教えて'
  await typeAndSend(ask2)
  const r2 = await answerUntil(h.waitEvent(e => e.kind === 'worker_report' && e.role === 'pm' && e.routed === true && e.seq > s0 && /IDEAS|子|委任/.test(String(e.text)), s0, T, 'PM report 2'), {}, s0)
  await reply(r2.seq)
  await Bun.sleep(1500)
  await cdp.eval(`scrollTo(0, document.body.scrollHeight)`)
  await cdp.shot('07-delegation')
  await cdp.shot('08-side-panel') // same state; the manual crops the right side

  // 3. PM thread with history, then a direct post
  await cdp.eval(`(() => { const rows = [...document.querySelectorAll('#threads .row')]; const r = rows.find(x => x.textContent.includes('PM')); r && r.click() })()`)
  await Bun.sleep(2500)
  await cdp.eval(`scrollTo(0, document.body.scrollHeight)`)
  await cdp.shot('09-thread-pm')
  s0 = h.lastSeq()
  await cdp.eval(`(() => { const ta = document.getElementById('t'); ta.value = 'IDEAS.md の 1 行目に「# 週末メモ」という見出しを足しておいて。終わったら一言だけ返事して'; document.getElementById('f').requestSubmit() })()`)
  const dr = await answerUntil(h.waitEvent(e => e.kind === 'worker_report' && e.session === pmKey && e.origin === 'user_direct', s0, T, 'direct answer'), {}, s0)
  await Bun.sleep(1500)
  await cdp.eval(`scrollTo(0, document.body.scrollHeight)`)
  await cdp.shot('10-thread-direct')
  void dr

  // 4. settings screen
  await cdp.eval(`document.getElementById('settingsBtn').click()`)
  await Bun.sleep(1500)
  await cdp.shot('11-settings', { full: true })
  await cdp.eval(`(() => { const b = [...document.querySelectorAll('#settings button')].find(x => /案件を追加/.test(x.textContent)); b && b.click() })()`)
  await Bun.sleep(600)
  await cdp.eval(`(() => { const box = document.querySelector('.proj-edit.new'); if (!box) return; const ins = box.querySelectorAll('input[type=text], textarea');
    const set = (i, v) => { if (ins[i]) { ins[i].value = v; ins[i].dispatchEvent(new Event('input')) } }; set(0, 'blog'); set(1, '~/work/blog'); set(2, '個人ブログの原稿'); box.scrollIntoView({ block: 'center' }) })()`)
  await cdp.shot('12-settings-add-project')
  await cdp.eval(`(() => { const b = [...document.querySelectorAll('#settings button')].find(x => /会話へ戻る/.test(x.textContent)); b && b.click() })()`)

  // 5. offline hold: stop the worker, send a request, see it held, restart the worker, see it delivered
  await h.stopWorker()
  await h.waitEvent(e => e.kind === 'worker_link' && e.connected === false, 0, T, 'worker offline')
  await Bun.sleep(1000)
  s0 = h.lastSeq()
  await cdp.eval(`(() => { const ta = document.getElementById('t'); ta.value = 'notes の PM に、TODO.md の末尾に「水を買う」を足してもらって。終わったら教えて'; document.getElementById('f').requestSubmit() })()`)
  await h.waitEvent(e => e.kind === 'request_state' && e.state === 'pending_offline', s0, T, 'pending offline')
  await Bun.sleep(1500)
  await cdp.eval(`scrollTo(0, document.body.scrollHeight)`)
  await cdp.shot('13-offline-hold')
  h.startWorker()
  const r3 = await answerUntil(pmReport(s0, 'PM report after restart'), {}, s0)
  await reply(r3.seq)
  await Bun.sleep(1500)
  await cdp.eval(`scrollTo(0, document.body.scrollHeight)`)
  await cdp.shot('14-offline-delivered')

  // 6. stop the PM from the side panel
  s0 = h.lastSeq()
  await cdp.eval(`(() => { const rows = [...document.querySelectorAll('#threads .row')]; const r = rows.find(x => x.textContent.includes('PM')); const b = r && [...r.querySelectorAll('button')].find(x => x.textContent === '停止'); b && b.click() })()`)
  await h.waitEvent(e => e.kind === 'session_state' && e.session === pmKey && e.state === 'stopped', s0, T, 'PM stopped')
  await Bun.sleep(1500)
  await cdp.shot('15-stopped')

  // 7. phone width
  await cdp.viewport(400, 820, true)
  await cdp.goto(h.url('/'))
  await Bun.sleep(1500)
  await cdp.eval(`scrollTo(0, document.body.scrollHeight)`)
  await cdp.shot('16-phone')
  await cdp.eval(`document.getElementById('panelBtn').click()`)
  await Bun.sleep(600)
  await cdp.shot('17-phone-panel')
  log('DONE')
} catch (e) {
  log('ERROR', (e as Error).message)
  try { await cdp.shot('zz-error') } catch {}
} finally {
  const mask = (s: string) => s.split(h.token).join('<webchat-token>').split(process.env.HOME ?? '/Users/x').join('~').split(h.dir).join('<tmp>').replaceAll('/private<tmp>', '<tmp>')
  writeFileSync(join(out, 'events.jsonl'), mask(h.events().map(e => JSON.stringify(e)).join('\n') + '\n'))
  await cdp.close()
  await h.cleanup()
}
