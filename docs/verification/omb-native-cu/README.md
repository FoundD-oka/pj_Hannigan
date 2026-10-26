# OpenMausBot の画面から純正 Computer Use を使えるか

実施日: 2026-10-27 01:05〜01:30 JST
実施者: Claude Code（このリポジトリの開発セッション）。OpenMausBot の画面操作は Claude Code の組み込みブラウザで行い、端末（tmux の中の Claude Code）には手で触れていない。
環境: M4 Mac mini（macOS 26.5.1）、Claude Code 2.1.310（Claude Max、claude.ai 認証）、tmux 3.8、Bun 1.3.9。OpenMausBot は本家 main `d690d11`（2026-10-26、`package.json` の version 0.1.127）をソースから起動（Node 24.22.1、pnpm 10.33.0、`pnpm dev:server` と `pnpm dev` の Web 画面）。データは一時フォルダ（`OMB_DATA_DIR`）に分け、`~/.openmausbot` と動いている Hannigan（VPS のハブ、この Mac のワーカー `hn-*`）には触れていない。

[HANDOFF](../../HANDOFF.md) 5.1 の第 1 段階にあたる。

## 結論

OpenMausBot の画面から純正 CU が一巡した。合格条件はすべて満たした。

OpenMausBot は、標準の Claude ドライバーでは純正 CU を使えない。そこで OpenMausBot を改造せず、外部エンジン（`customAcp`、ACP というエージェント接続の取り決め）として試作をつないだ。試作は [`prototype/omb-acp/acp-agent.ts`](../../../prototype/omb-acp/acp-agent.ts) で、Hannigan の `SessionManager`、`pane.ts`、`bridge.ts` をそのまま使い、tmux の中の対話型 Claude を動かす。

| HANDOFF 5.1 の合格条件 | 結果 |
| --- | --- |
| 画面から依頼 | 成立。OpenMausBot のチャットから送った依頼が、チャネル経由で対話型 Claude に届いた |
| 対話型の Claude が純正 CU で作業 | 成立。`mcp__computer-use__request_access`、`screenshot`、`computer_batch`、`zoom` を使い、TextEdit の新規書類に `OMB-CU-1` を入力して拡大表示で確かめた。cua-driver は使っていない |
| 承認を画面から操作 | 成立。端末の「Computer Use wants to control these apps（テキストエディット）」が OpenMausBot の承認カードになり、「今回だけ許可」で端末の `Allow for this session` が選ばれた |
| 拒否を画面から操作 | 成立。計算機の承認カードで「拒否」を押すと端末の `Deny` が選ばれた。ただし拒否の伝わり方に問題がある（下の 3 の 5） |
| 停止を画面から操作 | 成立。停止ボタンで試作が tmux に Esc を送り、1.9 秒でターンが `cancelled` で閉じた。実行中の `computer_batch`（STOP-02〜10 を 3 秒おきに入力）は中断され、追加指示で Claude が画面を確かめると書類は STOP-07 までで、08〜10 は入っていなかった |
| 結果が画面に戻る | 成立。Claude の発言とツールの実行がチャットに出た |
| 同じセッションへ追加指示 | 成立。停止のあとの追加指示で、Claude は同じ会話を覚えたまま書類の中身（8 行）を画面で確かめて返した。ただし途中で Claude が再起動し、CU のアプリ承認は取り直しになった（3 の 7） |
| 端末へ戻らない（初回の OS 権限の付与を除く） | 成立。端末の操作は 0 回。OS 権限は Terminal.app の付与済みの権限を使う回避策をとった（3 の 9） |

統合の形について新しい候補が出た。HANDOFF 5.2 の A〜C に加えて、「D. OpenMausBot を改造せず、Hannigan を ACP エンジンとして外付けする」形でも第 1 段階が通った。試作は Bun のまま動き、OpenMausBot はコマンドを起動するだけなので、実行環境をそろえる必要もなかった。

## 1. 標準のままでは使えないことの確認

| 確かめたこと | 結果 |
| --- | --- |
| `claude -p --output-format stream-json --input-format stream-json --verbose`（OpenMausBot の Claude ドライバーと同じ起動方式）を、computer-use を有効にしたフォルダ `~/hannigan-t11` で実行 | 起動時の `init` に computer-use の MCP サーバーも `mcp__computer-use__*` の道具も無い（道具は 29 個）。公式資料の「`-p` では使えない」と一致 |
| 同じフォルダで対話型の `claude` を tmux の中で起動して `/mcp` | `Built-in MCPs` に `✔ computer-use 24 tools`。環境変数を空にした起動（`env -i`）、`--mcp-config`、`--dangerously-load-development-channels` を付けても同じ |

## 2. 試作のつなぎ方

```text
OpenMausBot（Web 画面 → ハーネス 127.0.0.1:8799）
  └ customAcp エンジン: bun prototype/omb-acp/acp-agent.ts（ACP を標準入出力で話す）
      ├ SessionManager（Hannigan）: tmux の中で claude を対話モードで起動
      │   claude --session-id <id> --permission-mode manual --mcp-config <bridge> --dangerously-load-development-channels server:omb
      ├ bridge.ts（Hannigan）: チャネル。依頼を Claude に届ける
      └ 会話記録（~/.claude/projects/…/<id>.jsonl）を読み、発言とツール実行をチャットへ流す
```

| ACP（OpenMausBot 側） | 試作がすること |
| --- | --- |
| `session/new` | ID だけ決める。Claude は最初の依頼で起動する（OpenMausBot のモデル一覧の取得で Claude を起動させないため） |
| `session/prompt` | チャネルで依頼を届ける。会話記録の発言を `agent_message_chunk`、ツール実行を `tool_call` と `tool_call_update` にして返す |
| ターンの終わり | 画面の状態が `ready` に戻り、会話記録に出力があり、2.5 秒静かなら `end_turn` を返す。対話モードの Claude は `result` を出さないため |
| `session/request_permission` | `SessionManager` が見つけた端末ダイアログ（CU のアプリ承認など）を承認カードにする。回答は選択キーとして tmux に送る |
| `session/cancel` | tmux に Esc を送り、画面が `ready` に戻ったら `cancelled` を返す |
| `session/load` | 別のプロセスで始めた会話を `--resume` で再開する |

computer-use は案件フォルダごとに有効にするので、試作は Claude をすでに有効な `~/hannigan-t11` で起動した（環境変数 `HANNIGAN_OMB_ACP_CWD`）。OpenMausBot がボットごとに渡す作業フォルダと、`session/new` で渡す MCP サーバー（OpenMausBot 側の道具）は使っていない。

## 3. 見つかったこと（設計に効くもの）

1. ACP で外付けできる。OpenMausBot の `customAcp` は、エンジンの承認要求（`session/request_permission`）を普通の承認カードとして出す。フォークせずに端末ダイアログを画面へ出せた。起動前に `<cli> --version` が 8 秒以内に返ることを求められる
2. ターンの終わりは、画面の状態と会話記録で決められた。`ready` に戻ってからの待ち時間（2.5 秒）が応答の遅れになる。文字だけの 1 往復は 7〜11 秒だった
3. ボットの権限が「お任せ」（OpenMausBot の `approvalMode: full`）だと、承認要求はすべて OpenMausBot が自動で許可する。新しいボットの初期値がこれだった。CU のアプリ承認も macOS の権限ダイアログも、人が見ないまま通る。今回はボットを「先に確認してほしい」（`ask`）に変えて試した。統合では、CU の承認を「お任せ」でも自動で通さない仕組みが要る
4. macOS の権限ダイアログ（Accessibility と Screen Recording が未付与）を、試作は承認カードとして出してしまった。選択肢が「システム設定を開く」「やり直す」なので、承認ではなく案内として出すべきだった。3 の自動許可と重なり、端末では「Open System Settings → Accessibility」が選ばれた
5. CU のアプリ承認を拒否すると、`request_access` の結果は `{"granted":[],"denied":[]}` になり、拒否されたと書かれない。Claude は名前の指定ミスと考え、日本語名「計算機」で頼み直した。2 回目の拒否で「許可が取れなかった」と報告して止まった。ドライバーが拒否を Claude に伝える必要がある
6. 1 つのダイアログから承認カードが 2 枚出たことがある。描画の途中の画面を別のダイアログとして拾い、`prompt_id` が 2 つできた。片方に答えるとダイアログは閉じ、残りのカードはターンの終わりに OpenMausBot が閉じた。画面が落ち着くまで待ってから出す必要がある。`SessionManager` は Hannigan の WebChat と共通なので、WebChat でも起きうる
7. 停止のあと、OpenMausBot はエンジンのプロセスを立て直して `session/load` を送ってきた。試作はプロセスの終わりで Claude も止めるので、`--resume` で起動し直しになり、CU のアプリ承認が消えた（Phase 0 の T10 と同じ）。CU の承認とロックを保つには、Claude のセッションを ACP のプロセスから切り離し、常駐プログラム（Hannigan のワーカー）に持たせる必要がある
8. OpenMausBot は記憶の整理（memory の CAPTURE）などの裏の仕事にも同じエンジンを使う。そのたびに対話型の Claude がもう 1 本起動し、20 秒ほどかかった。裏の仕事は `-p` のドライバーへ振り分ける必要がある
9. 純正 CU の macOS 権限は、tmux サーバーを起動したアプリから引き継がれる。試作がそのまま起動した tmux では Accessibility と Screen Recording が未付与になった。Terminal.app から tmux サーバーを起動し直すと、Terminal.app の付与済みの権限で動いた（Phase 0 と同じ）。配布版では、OpenMausBot.app と常駐プログラムのどちらに権限を付けるかを決める。launchd で動く今の Hannigan のワーカー（`hn-*` の tmux）で CU が使えるかは未確認
10. OpenMausBot は依頼の本文の前に時刻や更新された文脈を付けて送る。Claude が返答の頭に「No response requested.」と書くことがあった
11. 試作の終わり方に穴がある。ハーネスを止めたとき、tmux の Claude が残ることがあった。後片付けも常駐プログラムの役目にする

## 4. 確かめていないこと

- Electron のデスクトップ版（今回は Web 画面と開発用サーバー）
- 複数の Mac、VPS 経由（HANDOFF 5.1 の第 2 段階）
- Bash や Edit などのツール承認の中継（チャネルの permission relay）。今回の依頼では発生しなかった
- computer-use を有効にしていないフォルダでの動き
- 「お任せ」のまま CU の承認を自動で通さない方法（3 の 3）

## 5. 再現手順

```bash
# 1. OpenMausBot をソースから入れる（Node 24 以上、pnpm）
git clone https://github.com/milind-soni/OpenMausBot && cd OpenMausBot && pnpm install
# 2. 試作用の tmux サーバーを、CU の権限を持つ端末アプリ（例: Terminal.app）から起動しておく
tmux -L omb-acp new-session -d -s keepalive 'sleep 86400'
# 3. $OMB_DATA_DIR/config.json にエンジンを登録する（下の JSON）
# 4. pnpm dev:server と pnpm dev を起動し、http://127.0.0.1:5199 でボットを作る。
#    エンジンに "Claude Code (interactive, Hannigan)" を選び、「CU Test が行動する前に」を「先に確認してほしい」にする
```

```json
{
  "instances": {
    "hannigan": {
      "driver": "customAcp",
      "displayName": "Claude Code (interactive, Hannigan)",
      "environment": {
        "HANNIGAN_TMUX_BIN": "<pj-Hannigan>/prototype/omb-acp/tmux-omb.sh",
        "HANNIGAN_OMB_ACP_DIR": "<試作の状態を置くフォルダ>",
        "HANNIGAN_OMB_ACP_CWD": "<computer-use を有効にしたフォルダ>",
        "HANNIGAN_OMB_ACP_CLAUDE": "<claude の絶対パス>"
      },
      "config": { "cli": "<bun の絶対パス> <pj-Hannigan>/prototype/omb-acp/acp-agent.ts" }
    }
  }
}
```

OpenMausBot を使わずに試作だけを試すときは `bun prototype/omb-acp/smoke.ts "依頼 1" "依頼 2"` を使う。OpenMausBot の ACP クライアントと同じ順で呼び、承認はすべて許可で答える。

## 6. 後に残したもの

- TextEdit に未保存の書類「名称未設定 6」が開いたまま（`OMB-CU-1` と `OMB-STOP-01〜07`）。閉じるときは保存しない
- Terminal.app に、tmux サーバーを起動したウィンドウが残っている場合がある
- OpenMausBot、試作の tmux サーバー（`-L omb-acp`）、試作の Claude はすべて止めた。OpenMausBot のデータは一時フォルダに置いた
