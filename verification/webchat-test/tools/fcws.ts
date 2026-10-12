// fakechat WebSocket client: connects, optionally sends one message, appends everything received to FC_LOG
import { appendFileSync } from 'fs'
const LOG = process.env.FC_LOG ?? '/dev/stdout'
const [id, ...rest] = process.argv.slice(2)
const text = rest.join(' ')
const log = (line: string) => appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`)
const ws = new WebSocket('ws://127.0.0.1:8787/ws')
ws.onopen = () => { log('OPEN'); if (id && text) { ws.send(JSON.stringify({ id, text })); log(`SENT id=${id} ${text}`) } }
ws.onmessage = e => log(`RECV ${e.data}`)
ws.onclose = () => { log('CLOSE'); process.exit(0) }
ws.onerror = e => log(`ERROR ${String(e)}`)
