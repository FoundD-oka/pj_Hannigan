// The prompt a person pastes into Claude Code on a second Mac so that Claude sets that Mac up as a worker
// (Phase 3, docs/design/01-config-schema.md §8.1; manual 11 章). Used by scripts/add-worker.ts (key filled in,
// printed once) and by the hub's settings screen (template with placeholders). Pure text, no I/O.

export const REPO_URL = 'https://github.com/FoundD-oka/pj_Hannigan.git'

export const PLACEHOLDER_ID = '<ワーカー ID>'
export const PLACEHOLDER_KEY = '<鍵>'

export type SecondMacPromptInput = {
  worker: string // worker id, or PLACEHOLDER_ID
  key: string // the key, or PLACEHOLDER_KEY
  hubPort: number
  hubHost: string // host name (with .local) or IP of the hub Mac
  hubUser: string // login name on the hub Mac
  hubAddresses?: string[] // LAN IPv4 addresses of the hub Mac, tried when the name does not resolve
  repoUrl?: string
}

// the hub Mac's LAN IPv4 addresses (non-internal), for the prompt
export function lanAddresses(ifaces: Record<string, { family: string | number; internal: boolean; address: string }[] | undefined>): string[] {
  const out: string[] = []
  for (const list of Object.values(ifaces)) for (const a of list ?? []) if (!a.internal && (a.family === 'IPv4' || a.family === 4) && !out.includes(a.address)) out.push(a.address)
  return out
}

export function secondMacPrompt(i: SecondMacPromptInput): string {
  const repo = i.repoUrl ?? REPO_URL
  const p = i.hubPort
  const hub = `${i.hubUser}@${i.hubHost}`
  const ips = i.hubAddresses ?? []
  const ipNote = ips.length
    ? `名前が解決できないときは、ハブ Mac の IP（${ips.join('、')}）で同じことを試す。IP が通ったら以降の <hub> はその IP にする。`
    : '名前が解決できないときは、ハブ Mac の IP を私に聞いてから同じことを試す。'
  return [
    `この Mac を Hannigan のワーカー（作業 Mac）として設定してください。ハブ（WebChat と秘書）は別の Mac「${i.hubHost}」で動いていて、この Mac からは SSH トンネルで ${p} 番ポートをつなぎます。次を順に行い、各段階の結果を短く報告してください。sudo が要る操作、鍵の生成、ファイルの削除は実行前に確認を取ってください。`,
    '',
    '前提の確認',
    '- `bun --version`（1.3 以上）、`tmux -V`、`claude --version`、`ssh -V` が通ること。足りないものは導入手順を示して、そこで止まる',
    '',
    '手順',
    `1. リポジトリ: \`git clone ${repo} ~/pj-Hannigan\`（既にあれば \`git -C ~/pj-Hannigan pull\`）。\`scripts/worker-setup.ts\` と \`package.json\` が無ければ、公開リポジトリが古い（ハブ側で push されていない）ので、最新コミットの ID を添えて私に伝えて止まる。あれば \`~/pj-Hannigan\` で \`bun install\``,
    `2. 設定と鍵: \`bun scripts/worker-setup.ts --worker ${i.worker} --key ${i.key} --hub-port ${p}\`。~/.hannigan/worker.json（案件は空）と ~/.hannigan/secrets/worker-key を書く。hub.json は作らない。鍵は他のファイル・ログ・返答に書かない`,
    `3. ハブ Mac への到達: まず \`ping -c 2 ${i.hubHost}\` と \`nc -vz -G 3 ${i.hubHost} 22\` で届くか見る。${ipNote}名前も IP も届かないなら、この Mac とハブ Mac は同じネットワークにいない（この Mac の IP は \`ipconfig getifaddr en0\` で分かる。ハブ Mac と先頭 3 つの数字が違えば別ネットワーク）。その場合は Bonjour で他の Mac を探して当てずっぽうにつながず、両方の Mac の IP を添えて「同じネットワークにつなぐか、Tailscale のような仕組みが要る」と私に伝えて止まる`,
    `4. SSH の疎通: \`ssh -o BatchMode=yes -o ConnectTimeout=5 ${hub} true\` で確認する。「Permission denied (publickey,password)」はリモートログインが有効で鍵が無いだけなので、\`ssh-keygen -t ed25519\` と \`ssh-copy-id ${hub}\` の手順を示す（パスワードは私が入力する）。「Connection refused」なら、ハブ側 Mac の「システム設定 > 一般 > 共有 > リモートログイン」をオンにするよう私に伝えて止まる`,
    `5. トンネル: \`tmux new -d -s hn-tunnel 'ssh -N -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes -L ${p}:127.0.0.1:${p} ${hub}'\`。数秒待って \`curl -s http://127.0.0.1:${p}/health\` が \`{"ok":true}\` を返すことを確認する`,
    '6. ワーカーの起動: `scripts/start.sh worker`。`~/.hannigan/logs/worker.log` に `connected to hub` が出れば成功。`worker auth rejected` が出たら鍵違いなので、ハブ側で鍵を作り直す必要があると私に伝える',
    '7. 報告: 各段階の結果、変更したファイル、残っている問題をまとめる。案件の登録はハブ側の WebChat の設定画面で行うので、ここではしない',
    '',
    'やらないこと',
    '- hub.json を作らない。ハブのポートを LAN に公開しない（`listen` を変えない）。渡した鍵を書き換えない。この Mac で Hannigan のハブや秘書を起動しない',
    '- トンネルの tmux セッション `hn-tunnel` はワーカーを動かす間ずっと残す。終了は `tmux kill-session -t hn-tunnel`',
  ].join('\n')
}

export function secondMacPromptTemplate(i: Omit<SecondMacPromptInput, 'worker' | 'key'>): string {
  return secondMacPrompt({ ...i, worker: PLACEHOLDER_ID, key: PLACEHOLDER_KEY })
}
