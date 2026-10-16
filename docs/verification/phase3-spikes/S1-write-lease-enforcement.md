# S1: 書込枠（write lease）の技術的強制 検証レポート

- 実施日: 2026-10-16
- 対象: Claude Code v2.1.301（`claude --version` で確認）、macOS 26.5.1、bun 1.3.9
- 関連設計: Q15/Q16/Q17（`docs/design/CHANGELOG.md`、`00-architecture.md` §4.1.12〜4.1.14、`02-worker-daemon.md` §18〜20）
- 実機実行: `claude -p` を3回（上限どおり）。ほかに Claude を使わないローカル実験を2件
- 証拠の置き場所: スクラッチ領域 `/private/tmp/claude-501/-Volumes-<vol>-<path>-pj-Hannigan/b05bd651-95df-47b1-8246-c94500c1a57e/scratchpad/s1/`（以下 `$S`）。一時領域なので、恒久保存が必要なら抜粋は本書のコードブロックを正とする

## 結論

実現できる。推奨する仕組みは **`--settings <ファイル>` で各セッションへ注入する PreToolUse フック** で、フックがツール呼び出しのたびにデーモン管理の書込枠ファイルを読み、所有者でなければ exit 2 で拒否する。フックの設定自体は起動時に固定でよい。判定に使う書込枠ファイルを毎回読むので、デーモンはファイルを書き換えるだけで、セッションを止めずに実行中に付与と剥奪ができる。実機では1つの `-p` セッションの中で「拒否→付与→許可→`release_pending` で剥奪→Bash も拒否」の遷移を確認し、`bypassPermissions` モードでもフックの拒否が効いた。セッションの識別は起動時に渡す環境変数 `HANNIGAN_SESSION_KEY` を使う（フックへ継承されることを確認済み）。一方、フックは「これから始まるツール呼び出し」しか止められない。剥奪の時点で既に動いているプロセス（`run_in_background`、Monitor、`&` や `nohup` で切り離した子）は書き続けられるので、`released` に進める前にデーモンが実行中ツールと子孫プロセスを検査する必要がある。Bash サンドボックスの `denyWrite` は Bash と子プロセスを OS レベルで止められるが、`--settings` ファイルの変更は実行中セッションへ反映されなかった。このため、サンドボックスは「恒久的に読み取り専用のタスクセッション」の多層防御として起動時に固定で使う。

## 候補ごとの評価

| 仕組み | 実行中の切替 | Edit/Write/NotebookEdit | Bash＋子プロセス | 再起動の要否 | 根拠 |
|---|---|---|---|---|---|
| 1. PreToolUse フック（`--settings` 注入、書込枠ファイル参照） | **可**。フック設定は固定で、判定データを毎回読む | **止められる**（実機） | 新規の Bash 呼び出しを丸ごと止められる（実機）。剥奪前から動くプロセスは止められない | 不要 | 実験 R1。docs hooks: exit 2 は "Blocks the tool call"。docs permissions: 「exit 2 は permission rules の評価前に止める」 |
| 2. Claude Code の Bash サンドボックス（`sandbox.filesystem.denyWrite`） | `--settings` 経由では**不可**（実機）。user/project/local の設定ファイルは再読込されるが、同じフォルダの全セッションで共有される | 対象外（docs と実機の両方で、Write ツールはサンドボックス外） | **止められる**。echo、python、バックグラウンドのサブシェルまで OS が拒否（実機） | 切替には再起動が要る | 実験 R2、R3。docs sandboxing: "The sandbox covers shell commands only" |
| 3. macOS `sandbox-exec` で claude プロセスごと包む | 不可（プロセスに固定） | 止められる（claude 本体が対象のため） | 止められる（ローカル実験 L2 で shell、python、子プロセスを確認） | 切替には再起動が要る | 実験 L2。`sandbox-exec` は Apple が非推奨扱い。claude 自体の書込（履歴、`~/.claude`）は別パスなので、作業フォルダだけを拒否すれば動く見込み（未検証） |
| 4. `permissions.deny`（`Edit(//abs/path/**)` 等） | `--settings` 経由は不可の見込み。共有の設定ファイルなら再読込されるが、セッションを区別できない | 止められる | 一部だけ。`cat`/`sed`/`tee`/リダイレクトなど認識できるコマンドだけが対象で、python などの任意サブプロセスは対象外（docs permissions） | 切替には再起動が要る | docs settings「When edits take effect」は user/project/local/managed の再読込だけを挙げる。docs permissions L365 |
| 5a. チャネル経由で権限モードを変える | 不可 | - | - | - | `docs/verification/t12-channel-command/README.md` |
| 5b. セッションごとに `CLAUDE_CONFIG_DIR` を分け、その「ユーザー設定」を書き換えてサンドボックス設定を再読込させる | 理屈の上では可 | 対象外 | 理屈の上では可 | 不要の見込み | 未検証。ログイン情報と履歴が設定ディレクトリごとに分かれる（docs authentication）ので運用負荷が大きい。採用は勧めない |
| 5c. フックの `updatedInput` で非所有者の Bash を `sandbox-exec` で包んで実行させる | 可（フックが毎回判断） | - | 読み取り専用の Bash を OS 強制付きで許せる見込み | 不要 | 未検証。Claude のサンドボックスを有効にしたセッションでは入れ子の sandbox 適用が失敗する可能性がある |

## 実験ログ

### L1: フック単体のオフライン確認（Claude 不使用）

```text
lease={"state":"held","owner_session_key":"sess-pm","lease_epoch":1}, self=sess-task
  Write $S/ws1/a.txt            -> exit=2  "[hannigan] write lease not held: state=held owner=sess-pm epoch=1"
  Write /tmp/elsewhere.txt      -> exit=0  (作業フォルダ外は判定しない)
lease={"state":"held","owner_session_key":"sess-task","lease_epoch":2}
  Bash "echo hi > a.txt"        -> exit=0
lease ファイルなし
  Bash "ls"                     -> exit=2  "guard error: ENOENT ..."（fail-closed）
1回の起動時間: 約 0.014s（bun）
```

### R1: 1セッション内での付与と剥奪（実機 `claude -p`、1回目）

デーモン役の `flipper.sh` が、最初の拒否を見たら自セッションへ付与し（epoch 2）、最初の Write 許可を見たら `release_pending` へ移す。

```sh
SID=7d3c2a10-5b1e-4c6f-9a2b-000000000001
echo '{"state":"held","owner_session_key":"pm-other","lease_epoch":1}' > $S/state/lease.json
$S/bin/flipper.sh $S/state/run1.log $S/state/lease.json $SID &
HANNIGAN_SESSION_KEY=$SID HANNIGAN_WORKSPACE=$S/ws1 HANNIGAN_LEASE_FILE=$S/state/lease.json \
HANNIGAN_GUARD_LOG=$S/state/run1.log \
claude -p "Do these steps strictly in order ... 1) Write a.txt 2) Write b.txt 3) Bash: echo C > c.txt 4) Bash: ls ..." \
  --session-id $SID --settings $S/state/hooks.json --permission-mode bypassPermissions \
  --output-format stream-json --verbose
```

`$S/state/hooks.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|NotebookEdit|Bash|Monitor|PowerShell",
        "hooks": [ { "type": "command", "command": "~/.bun/bin/bun $S/bin/lease-guard.ts", "timeout": 10, "onFailure": "block" } ]
      }
    ]
  }
}
```

フックが記録した入力（抜粋、パスは `$S` に置換）:

```json
{"ts":"2026-10-15T23:46:07.484Z","env_session_key":"7d3c2a10-5b1e-4c6f-9a2b-000000000001","input":{"session_id":"7d3c2a10-5b1e-4c6f-9a2b-000000000001","cwd":"$S/ws1","permission_mode":"bypassPermissions","hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"$S/ws1/a.txt","content":"A"},"tool_use_id":"toolu_01LZRPFRAoWXkDqNaSTozjfD","keys":["cwd","effort","hook_event_name","permission_mode","prompt_id","session_id","tool_input","tool_name","tool_use_id","transcript_path"]}}
{"ts":"2026-10-15T23:46:07.485Z","decision":"deny","reason":"state=held owner=pm-other epoch=1","tool":"Write"}
{"ts":"2026-10-15T23:46:11.287Z","decision":"allow-owner","tool":"Write","epoch":2}
{"ts":"2026-10-15T23:46:13.525Z","env_session_key":"7d3c...0001","input":{"tool_name":"Bash","tool_input":{"command":"echo C > c.txt","description":"Create c.txt containing C"}, "...":"..."}}
{"ts":"2026-10-15T23:46:13.525Z","decision":"deny","reason":"state=release_pending owner=7d3c2a10-5b1e-4c6f-9a2b-000000000001 epoch=2","tool":"Bash"}
{"ts":"2026-10-15T23:46:15.532Z","decision":"deny","reason":"state=release_pending owner=7d3c2a10-5b1e-4c6f-9a2b-000000000001 epoch=2","tool":"Bash"}
```

```text
08:46:07 flipper: granted epoch2 to self
08:46:11 flipper: release_pending epoch2
```

Claude が受け取ったツール結果（stream-json の tool_result）:

```text
is_error=true : PreToolUse:Write hook error: [... lease-guard.ts]: [hannigan] write lease not held: state=held owner=pm-other epoch=1. Do not retry; wait for the lease.
is_error=null : File created successfully at: $S/ws1/b.txt
is_error=true : PreToolUse:Bash hook error: [...]: [hannigan] write lease not held: state=release_pending owner=7d3c...0001 epoch=2. ...
is_error=true : PreToolUse:Bash hook error: [...] (ls も同様に拒否)
```

結果: 作業フォルダには `b.txt`（中身 `B`）だけが残った。読み取れる事実は次のとおり。

- `--settings <file>` で渡したフックが、ユーザー設定とプロジェクトの `.claude/` を変えずに動いた
- `bypassPermissions` でもフックの exit 2 が Write と Bash を止めた
- 起動時の環境変数はフックへ継承された。`--session-id` を渡した場合は `session_id` も同じ値になった
- フック設定を変えずに、書込枠ファイルの書換えだけで同一セッションの許可と拒否が切り替わった
- `-p` のフック入力に `scratchpad_dir` は無かった（docs の例にはある）。判定には使わないので影響はない

### R2: `--settings` ファイル内のサンドボックス設定を実行中に変更（実機、2回目）

```sh
# 起動時: {"sandbox":{"enabled":true,"allowUnsandboxedCommands":false,"filesystem":{"denyWrite":[]}}}
# x1.txt 出現の 0.5 秒後に同じファイルを denyWrite:["$S/ws3"] へ書換え
claude -p "... 1) echo 1 > x1.txt 2) sleep 4 && echo 2 > x2.txt 3) python3 -c 'open(\"x3.txt\",\"w\")...' 4) echo 4 > \$TMPDIR/s1-x4.txt" \
  --settings $S/state/sbx.json --permission-mode bypassPermissions --output-format stream-json --verbose
```

```text
08:47:02 x1.txt 作成
08:47:03 flipper: denyWrite cwd added to --settings file
08:47:09 x2.txt 作成   <- 変更後なのに書けた
08:47:13 x3.txt 作成   <- 変更後なのに書けた
s1-x4.txt は /private/tmp/claude-501/ に作成（サンドボックスが TMPDIR を差し替えた＝サンドボックスは有効だった）
```

結果: `--settings` ファイルへの変更は実行中のセッションに反映されなかった。docs の「When edits take effect」も再読込の対象を user/project/local/managed の設定ファイルとしか書いていない。

### R3: 起動時から作業フォルダを `denyWrite` にしたサンドボックス（実機、3回目）

```sh
# {"sandbox":{"enabled":true,"allowUnsandboxedCommands":false,"filesystem":{"denyWrite":["$S/ws4"]}}}
claude -p "... 1) Bash: echo 1 > y1.txt 2) Bash: python3 ... y2.txt 3) Bash: (sleep 1; echo 3 > y3.txt) & wait 4) Write tool: y4.txt 5) Bash: echo \$TMPDIR; ls" \
  --settings $S/state/sbx-deny.json --permission-mode bypassPermissions --output-format stream-json --verbose < /dev/null
```

```text
1 is_error=true : Exit code 1 / (eval):1: operation not permitted: y1.txt
2 is_error=true : PermissionError: [Errno 1] Operation not permitted: 'y2.txt'
3 is_error=false: (eval):1: nice(5) failed: operation not permitted / (eval):1: operation not permitted: y3.txt
4 is_error=null : File created successfully at: $S/ws4/y4.txt
5 is_error=false: /tmp/claude-501 / y4.txt
```

結果: 起動時に固定したサンドボックスは Bash と子プロセスとバックグラウンドのサブシェルの書込を OS レベルで止めた。Write ツールは止めなかった。

### L2: macOS `sandbox-exec`（Claude 不使用）

```sh
P='(version 1)(allow default)(deny file-write* (subpath "$S/ws5"))'
sandbox-exec -p "$P" /bin/zsh -c 'echo 1 > z1.txt; python3 -c "open(\"z2.txt\",\"w\")..."; (sleep 1; echo 3 > z3.txt) & wait; cat /etc/hosts && echo read-ok; echo 4 > $TMPDIR/s1-z4.txt && echo tmp-ok'
```

```text
zsh:1: operation not permitted: z1.txt
PermissionError: [Errno 1] Operation not permitted: 'z2.txt'
zsh:1: operation not permitted: z3.txt
read-ok
tmp-ok
```

## 推奨する実装

### 全体像

フックが1回ごとの判定を担い、デーモンが状態遷移と剥奪後の安全確認を担う。フックは剥奪後の新しいツール呼び出しを止める。デーモンは剥奪前から動いているものが無いことを確かめてから `released` を確定する。読み取り専用と決まっているタスクセッションには、起動時に固定のサンドボックス `denyWrite` を追加で重ねる。

### デーモンが書くファイル

| パス（例） | 書き手 | 中身 |
|---|---|---|
| `<stateDir>/leases/<resource_id>.json` | デーモンだけ（tmp に書いて rename で原子的に置換） | `{resource_id, workspace_real, state, owner_session_key, operation_id, lease_epoch, updated_at}` |
| `<stateDir>/guard-<session_key>.json` | デーモン（起動時に1回） | `--settings` に渡す設定。PreToolUse と PostToolUse のフック、`"disableAllHooks": false` |
| `<stateDir>/inflight/<session_key>.jsonl` | フック | PreToolUse で許可した `tool_use_id` と、PostToolUse/PostToolUseFailure で終わった `tool_use_id` |
| `worker/resource-leases.json` | デーモン | 既存設計どおりの耐久台帳。leases/ はフックが読むための投影 |

`guard-<session_key>.json` の例:

```json
{
  "disableAllHooks": false,
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|NotebookEdit|Bash|Monitor|PowerShell|EnterWorktree|ExitWorktree|mcp__.*",
        "hooks": [ { "type": "command", "command": "/opt/hannigan/bin/bun /opt/hannigan/worker/lease-guard.ts pre", "timeout": 10, "onFailure": "block" } ]
      }
    ],
    "PostToolUse": [
      { "matcher": "*", "hooks": [ { "type": "command", "command": "/opt/hannigan/bin/bun /opt/hannigan/worker/lease-guard.ts post", "timeout": 10 } ] }
    ]
  }
}
```

`mcp__.*` は書込のできる MCP ツールを想定した広めの指定にしている。Hannigan 自身のブリッジ（`reply` など）はフック内で許可リストに入れる。

### 起動方法（`shared/session-manager.ts` の argv と env への追加）

```ts
argv.push('--settings', guardFile)            // セッション専用の設定ファイル
env.HANNIGAN_SESSION_KEY = s.key             // 識別子。/clear で session_id が変わっても不変
env.HANNIGAN_WORKSPACE = realpath(s.cwd)
env.HANNIGAN_LEASE_FILE = leaseFileFor(s.cwd)
// 恒久的に読み取り専用のタスクだけ、多層防御として追加
// guard の settings に "sandbox": {"enabled": true, "allowUnsandboxedCommands": false,
//   "filesystem": {"denyWrite": [workspace_real]}} を同居させる
```

識別には `session_id` でなく環境変数を使う。`/clear` や `--fork-session` で `session_id` が変わる可能性があり、環境変数は起動したデーモンが決めた値を保てるからだ。

### フックのスケッチ（bun / TypeScript）

```ts
// worker/lease-guard.ts  (mode: "pre" | "post")
import { readFileSync, appendFileSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'

const mode = process.argv[2]
const input = JSON.parse(readFileSync(0, 'utf8'))
const self = process.env.HANNIGAN_SESSION_KEY
const ws = process.env.HANNIGAN_WORKSPACE
const leaseFile = process.env.HANNIGAN_LEASE_FILE
const inflight = `${process.env.HANNIGAN_STATE_DIR}/inflight/${self}.jsonl`

function deny(reason: string): never {
  process.stderr.write(`[hannigan] write lease not held (${reason}). Do not retry; wait for the lease.\n`)
  process.exit(2)
}

if (mode === 'post') {
  appendFileSync(inflight, JSON.stringify({ end: input.tool_use_id, at: Date.now() }) + '\n')
  process.exit(0)
}
try {
  if (!self || !ws || !leaseFile) deny('guard env missing')
  const tool: string = input.tool_name
  if (tool.startsWith('mcp__hannigan__')) process.exit(0)              // 自前ブリッジは常に可
  if (['Edit', 'Write', 'NotebookEdit'].includes(tool)) {
    const p = input.tool_input?.file_path ?? input.tool_input?.notebook_path
    if (!p) deny('no path')
    const abs = resolve(input.cwd ?? ws, p)
    const hannigan = process.env.HANNIGAN_STATE_DIR!
    if (abs.startsWith(hannigan + sep)) deny('state dir is read-only for sessions')
    if (!(abs === ws || abs.startsWith(ws + sep))) process.exit(0)       // 作業フォルダ外は対象外
  }
  const lease = JSON.parse(readFileSync(leaseFile, 'utf8'))
  if (lease.state !== 'held' || lease.owner_session_key !== self)
    deny(`state=${lease.state} epoch=${lease.lease_epoch}`)
  appendFileSync(inflight, JSON.stringify({ start: input.tool_use_id, tool, epoch: lease.lease_epoch, at: Date.now() }) + '\n')
  process.exit(0) // 判断なし＝通常の権限フローへ
} catch (e) {
  deny(`guard error: ${(e as Error).message}`) // fail-closed
}
```

### 状態との対応

| 書込枠の状態 | フックの判定 | デーモンの動き |
|---|---|---|
| `held`（owner=自分、epoch=n） | 自分には作業フォルダ内の Edit/Write/NotebookEdit と Bash を許可する。他セッションは拒否 | 付与時に epoch を1増やして原子的に書き込む |
| `release_pending` | 所有者も含めて全員を拒否する。デーモンがファイルを置換した直後の呼び出しから効く（R1 で確認） | (1) inflight の start と end の差分で実行中のツールが無いことを確かめる。(2) claude の PID から子孫プロセスを列挙し、MCP ブリッジ等の既知 PID を除いて残りが無いことを確かめる。(3) `lsof +D <workspace>` で書込用に開いたファイルが無いことを確かめる。全部通ったら検証結果を永続化して `released` へ進める |
| `released` | 全員拒否 | 次の待機者を再検査してから `held`（epoch+1）を付与する |
| `resource_unknown` | 全員拒否（ファイル欠損や破損も同じ扱い） | 自動で解放しない。§20 の再検証へ進む |

`release_pending` の検査が通らない場合は `release_pending` のまま待つ。一定回数で解決しなければ `resource_unknown` にする。どちらも自動 kill はしない（Q17/B）。

### 残る穴

- **剥奪前から動いているプロセス:** 所有中に `run_in_background`、Monitor、`&`、`nohup`、`setsid` で起動したプロセスは、剥奪後も書き続けられる。フックは新しい呼び出ししか止めない。デーモンの子孫プロセス検査と `lsof` で検出し、残っていれば `released` にしない。`setsid` や launchd 経由で親子関係を切ったプロセスは子孫列挙から漏れるので、`lsof +D` が最後の網になる。それでも確証が無ければ `resource_unknown` にする。
- **実行中のツール呼び出し:** PreToolUse を通過済みの長い Bash は剥奪後も完了まで走る。inflight 台帳で終了を待つ。PostToolUse が来ない異常終了（claude のクラッシュ等）は `resource_unknown` にする。
- **インタラクティブセッションのワークスペース信頼:** docs によると、インタラクティブセッションでは信頼ダイアログを受け入れるまで全設定ファイルのフックを保留する。Hannigan のセッションは tmux 上のインタラクティブ起動なので、未信頼のフォルダではフックが動かず fail-open になる恐れがある。デーモンは起動前に `~/.claude.json` の `projects["<path>"].hasTrustDialogAccepted` を確認し、未信頼なら書込可能セッションとして起動しない。`--settings` 由来のフックにも同じ保留がかかるかは未検証。
- **mod（`tool.check`）による上書き:** docs permissions によると、インストール済みの mod は PreToolUse フックの拒否を承認で上書きできる。例外は managed settings のフックだけ。Hannigan を動かす Mac では mod を入れない運用にするか、起動前に検出して警告する。
- **フック設定の改変:** `--settings` は project/local/user より優先されるので、プロジェクト側の `disableAllHooks: true` は `--settings` の `false` が上書きする（docs settings の優先順位）。フック配列は統合されるので、他の設定からフックを消すこともできない。ただし所有中のセッションは同じユーザー権限の Bash で書込枠ファイルやフックスクリプトを書き換えられる。脅威モデルを「バグや暴走」までとし、悪意ある改ざんは対象外と明記する。必要なら書込枠ファイルにデーモン鍵の HMAC を付ける案もあるが、鍵も同じユーザーから読めるので効果は限定的。
- **ユーザーが tmux で打つ `!` コマンド:** フックもサンドボックスも通らない。人の操作なので対象外とする。
- **Agent のサブエージェントと Workflow:** docs ではサブエージェントのツール呼び出しにも同じフックが動く。Workflow とエージェントチームのチームメイトが環境変数を継承するかは未検証。

## tmux 実機確認（2026-10-16、Phase 3 WP2）

ワーカーデーモン（`worker/daemon.ts`）が tmux の対話セッションとして起動した本物の Claude Code（v2.1.301、`--model haiku`、`permission_mode=acceptEdits`）で、`--settings` で注入したフックが動くかを確かめた。実行は 1 セッションで、指示は 2 回送った。ハブは試験用の偽ハブ（`test/fake-hub.ts`）を使った。駆動スクリプトと出来事の記録はスクラッチ領域 `$S/s1-tmux/`（`probe.ts`、`events.jsonl`）に置いた。

手順は次のとおり。

1. `pm_ensure` で案件 PM を起動した。フォルダ信頼と開発用チャネルの警告はデーモンの `auto_accept` が答えた。書込枠は `released`（epoch 0）のままにした
2. 書込枠を付与しない低レベルの `session_send` で「Write ツールで probe.txt を作る」と指示した
3. 次に `pm_send` で probe2.txt の作成を指示した。デーモンは配送の直前に PM へ書込枠を付与する（epoch 1）

結果は次のとおり。

```text
1) Claude は先に Bash（pwd）を呼び、フックに止められた。Write は試さずに報告した
   tool_result: [error] PreToolUse:Bash hook error: ['bun' '<repo>/worker/lease-guard.ts' pre]:
                [hannigan] write lease not held (state=released epoch=0). ... Do not retry; ...
   probe.txt exists: false
2) pm_send -> {"status":"delivered"}、resource_lease_state: held (granted, epoch 1)
   tool_result: File created successfully at: <project>/probe2.txt
   probe2.txt exists: true
   inflight/<session>.jsonl: {"start":"toolu_01D5…","tool":"Write","epoch":1} / {"end":"toolu_01D5…"}
3) 返答の後、resource_lease_state: release_pending (owner_idle) -> released (verified_idle)
```

ここから読み取れる事実は次のとおり。

- tmux の対話セッションでも、`--settings` で渡した PreToolUse フックが動いた。フォルダ信頼ダイアログを自動で承認した後のセッションで確認した。未信頼のフォルダでフックが保留されるかは確かめていない
- 書込枠を持たないセッションの Bash は、読み取りだけのコマンド（`pwd`）でも止まった。設計どおりの動作で、書込枠を持たない間は Bash を使えない
- PostToolUse と `PostToolUseFailure` を含む設定ファイルはエラーなく読み込まれた。PostToolUse は reply などの MCP ツールでも動き、inflight 台帳に `end` だけの行が残る。`start` は書込枠の判定を通ったツールだけに付く
- デーモンが付与した後、同じセッションの Write は通った。返答の後、デーモンの検証（実行中ツール、新しく生まれた子孫プロセス、`lsof +D` による書込中ファイル）を通過し、`released` まで自動で進んだ。本物の Claude Code が付与時に持っていた子プロセス（MCP サーバー等）は、付与時の一覧として除外している
- 同じ実行で、v2.1.301 のチャネル経由の指示が `origin.kind="channel"` の user 行として記録されることも確かめた（S2 の未検証事項）。トランスクリプト・アダプターはこれを `channel_message` として出した

未確認のまま残るものは次のとおり。

- Write ツール自体の拒否は、この実行では起きなかった。Claude が Bash の拒否を見て Write を試さなかったためだ。Write の拒否は R1（`-p`）とフック単体の試験で確認済み
- `onFailure: "block"` でフックがタイムアウトした場合の動作
- 剥奪前から動くバックグラウンドプロセスを `released` の前に検出する動作（デーモンの検証処理は単体試験で確認した。本物のセッションでの試験はしていない）

## 未検証事項

- ワークスペース信頼が未承認のときにフックが保留されるか（tmux 起動でフックが動くことは「tmux 実機確認」で確認済み）
- `"onFailure": "block"`（docs では v2.1.295 以降）でフックのタイムアウトや異常終了が実際に拒否になるか。今回は設定が受け付けられたことだけを確認した
- `--resume` で再開したときの `session_id` と環境変数の扱い
- `/clear` 後の `session_id` の変化（設計では環境変数を使うので影響しない想定）
- Workflow ツールとエージェントチームのチームメイトでのフック発火と環境変数の継承
- フックの `updatedInput` で非所有者の Bash を `sandbox-exec` で包む案（5c）。Claude のサンドボックス有効時に入れ子の適用が失敗する可能性がある
- `CLAUDE_CONFIG_DIR` をセッションごとに分けてサンドボックス設定を実行中に切り替える案（5b）
- `sandbox-exec` で claude プロセスごと包んだときに claude 自体が正常に動くか（L2 はシェル単体で確認しただけ）
- PreToolUse の matcher に `MultiEdit` を入れる必要性。v2.1.301 のツール一覧（docs tools-reference）に `MultiEdit` は無く、ファイル変更系は Edit/Write/NotebookEdit だった

## 出典（取得日 2026-10-16）

- https://code.claude.com/docs/en/hooks （PreToolUse の入力、exit code、matcher、環境変数の継承、サブエージェントでの発火、ワークスペース信頼、ConfigChange）
- https://code.claude.com/docs/en/settings （`--settings` の優先順位、「When edits take effect」の再読込対象）
- https://code.claude.com/docs/en/sandboxing （対象が shell コマンドだけであること、子プロセスへの適用、denyWrite、ファイル一覧の実行中反映）
- https://code.claude.com/docs/en/permissions （Edit deny の Bash への適用範囲、フックと権限ルールの優先関係、mod による上書き）
- https://code.claude.com/docs/en/tools-reference （v2.1.301 時点の組込ツール名）
- https://code.claude.com/docs/en/iam は認証ページだったので、権限の根拠には使っていない
- ローカル: `claude --version` = 2.1.301、`claude --help`（`--settings`、`--session-id`、`--setting-sources`、`--bare` の存在）
