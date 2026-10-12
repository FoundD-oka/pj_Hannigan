# Claude Code Channels × 純正Computer Use 実機検証レポート（第2回）

実施日：2026年10月12日 19:52〜20:25（JST）  
実施者：Claude Code（自律実行セッション `47702cdb-…`、Terminal.app上）。人の操作者は対象Macの前にいて、OS権限の付与だけを行った  
run_id：`r1012b`  
ブランチ：`test/claude-channels-cu`（基準commit `85ea0e6`）  
検証コード：[`prototype/webchat-test/`](../../../prototype/webchat-test/)  
証拠：[`evidence-run2/`](evidence-run2/)（第1回の証拠は [`evidence/`](evidence/)、第1回レポートは [`report-01-20261012-blocked.md`](report-01-20261012-blocked.md)）

## 0. 結論

総合判断は **補助経路を条件に採用可能** です。適用範囲は「対象Mac上のループバック接続で、検証者が別端末の代わりにAPIを叩いた範囲」に限ります。別端末・別ネットワークからの利用は未実施のため判定保留です。

実測で確定したことは次のとおりです。

- 純正Computer Use（以下CU）はChannelsからの指示で動く。TextEditへの入力、同じ会話での再確認つき追記、切断中の結果回収、CLI再開後の会話継続まで、すべて同じClaudeセッションで成立した。
- CUのアプリ承認（「Computer Use wants to control these apps」）はChannelsのpermission relayに**届かない**。端末のダイアログにしか出ないため、WebChatだけでは許可も拒否もできない。通常ツール（Bash、返信ツール）の承認は届く。
- 実行中のGUI操作をChannelsのメッセージで止めることはできない。「停止してください」は処理待ちになり、完了後に通常メッセージとして処理された。端末へEscを送る補助経路なら実行中のバッチを中断でき、その後も同じ会話を続けられた。
- 起動時の開発用チャネル警告と、再開後のアプリ再承認も端末での操作が必要だった。

したがって、独自WebChatを主な窓口にするには、Channelsに加えて「端末の画面を読み、キーを送る」補助経路が、CU承認・停止・起動確認の3場面で必要です。

## 1. 環境

| 項目 | 値 | 確認方法 |
| --- | --- | --- |
| 対象Mac | Mac mini、macOS 26.5.1（25F80）、arm64 | `sw_vers`、`uname -m` |
| 操作用端末 | なし。同じMac上の curl（SSE受信・送信・承認回答）と Bun 製WebSocketクライアント（fakechat用）で代用 | ― |
| 接続経路 | 127.0.0.1 のみ。別LAN・別ネットワークは未実施 | ― |
| Claude Code | v2.1.296、claude.ai認証、Max プラン。モデル Fable 5.1（effort high） | `claude --version`、起動バナー |
| 被験セッションの起動 | Terminal.app（Apple_Terminal 470.2）→ tmux 3.8 の中で対話型CLI。`--permission-mode manual` | [`start-session.sh`](../../../prototype/webchat-test/start-session.sh) |
| 検証者セッション | 同じTerminal.appで `claude --dangerously-skip-permissions`。被験セッションとは別プロセスで、CUは使っていない | `ps` |
| 組み込みCU | `/mcp` で有効化済み（第1回で設定）。`request_access`、`open_application`、`computer_batch`、`zoom` 等 | transcript |
| 独自Channel | `webchat-test` 0.0.1（第1回と同じコード。起動スクリプトのbash 3.2対応のみ修正） | `.mcp.json`、`git diff` |
| fakechat | `fakechat@claude-plugins-official` 0.0.1。`server.ts` の blob SHA `f258a83ebbb0ddfbabfc674389308ab5c97a75c9`（依頼書と一致） | `git hash-object` |
| 利用枠 | 開始時 5時間枠 63%、7日枠 91% 使用済み。終了時 57%／90% | ステータス行 |

公式資料は2026年10月12日に [Computer use（CLI）](https://code.claude.com/docs/en/computer-use) を再確認しました。「権限はターミナルアプリに付与」「アプリ承認はセッション単位」「停止は Esc または Ctrl+C」「ロックはセッション終了まで」の記述は実測と一致しました。「ターミナルは隠されない」という記述に対し、CUのスクリーンショット結果は「ターミナル」も隠した旨を返しており、ここは食い違いとして記録します。

### 1.1 OS権限の付与と再起動の要否

第1回で未付与だったアクセシビリティと画面収録は、今回どちらもTerminal.appに付与されました。画面収録は検証開始時点で付与済み、アクセシビリティは19:57頃に人が付与しました。

付与前に起動していたClaude Codeプロセスは、付与後に「Try again」を選んでも、新しい依頼を送っても `Accessibility: ✘ not granted` のままでした（`T01-01-permission-dialog.txt`）。同じTerminal.appから新しいtmuxサーバーとClaude Codeを起動し直すと付与済みと判定されました。公式資料は画面収録について再起動を案内していますが、アクセシビリティでも再起動が必要でした。tmux経由でもTerminal.appの権限は引き継がれました。

## 2. ケース別結果

時刻はJST。ログ内の時刻はUTC（JST−9時間）です。「現地操作」は検証者がtmux経由で対象Macの端末に入力した操作で、人の操作ではありません。

| ケース | 判定 | 実測結果 | 証拠 | 現地操作・補助経路 |
| --- | --- | --- | --- | --- |
| T01 | PASS | 20:00 セッション `3727552c`。`request_access` は「TextEdit」「テキストエディット」で未検出となり、bundle ID `com.apple.TextEdit` で承認ダイアログが出た。承認後 `open_application`→`computer_batch`（cmd+N、type）→`zoom`。本文 `CHCU-r1012b-T01`、ウィンドウ「名称未設定 8.txt — 編集済み」 | `T01-02-app-approval-dialog.txt`、`T01-transcript-tools-3727552c.txt`、`screens/T01-zoom-01-*.jpg` | アプリ承認を端末でAllow（20:01:02） |
| T02 | PASS（ローカル） | セッション `edfe3bf9`。WSで `FC-r1012b-T02` を送り、返信ツールの承認後に同じ文字列が返った（送信 11:03:04Z、受信 11:03:20Z）。続けてCU依頼を送ると端末にCU承認が出て、承認後に `CHCU-r1012b-T02` を「名称未設定 9.txt」へ入力、結果がWSに返った（11:04:11Z） | `T02-fakechat-ws.log`、`T02-01/03/04-*.txt`、`T02-transcript-tools-*.txt`、`screens/T02-zoom-01-*.jpg` | 返信承認×2とCU承認×1を端末で押した。fakechatに中継機能はない |
| T03 | PASS（ローカル） | セッション `a482d1dc`。合言葉「ゆうやけ-r1012b-3K」を送り、次の発言で求めると同じセッションから `in_reply_to=m-r1012b-2` で同じ会話 `conv-r1012b` に合言葉だけが戻った（11:06:18Z） | `webchat-events-run2.jsonl` seq 66〜75、`T03-T04-transcript-tools-*.txt` | 開発用チャネル警告を端末で承認 |
| T04 | PASS（ローカル） | 許可：返信ツール要求 `ackqg`、`yeinq` にAPIからallowを送ると実行された。拒否：Bash要求 `ddwpx`（`touch /tmp/chcu-r1012b-deny-marker.txt`）にdenyを送ると「Denied via channel webchat-test」となり、ファイルは作られなかった。存在しないID `qqqqq` は `known_open:false`、トークンなしは401 | seq 68〜84、`T04-02/03/04-*.txt` | 回答者は人ではなく検証者のcurl |
| T05 実行 | PASS（端末承認つき） | セッション `66e6a74b`（Claude PID 75308）。11:07:25Z に送信、11:07:54Z の `request_access(com.apple.TextEdit)` で端末にCU承認が出た。端末で承認後、`computer_batch` で入力し、`zoom` で確認。11:09:14Z に本文 `CHCU-r1012b-A`、「名称未設定 10.txt — 編集済み」がWebChatへ返った | `T05-02-cu-app-dialog-pane.txt`、`T05-T07-transcript-tools-66e6a74b.txt`、`screens/T05-T07-T10-zoom-01-*.jpg`、`screens/R1-doc10-after-type-01.jpg` | CU承認を端末でAllow（20:08:49） |
| T05 CU遠隔許可 | FAIL | CU承認ダイアログが端末に出てから51秒間（20:07:58〜20:08:49）、Channelには `permission_request` も `unknown_notification` も届かず、`/api/status` の `open_requests` は空のままだった。2周目（セッション `2a22d3d1`、20秒以上）も同じ | `T05-01-events-while-cu-dialog-open.txt`、`R2-01-events-while-cu-dialog.txt` | 端末でしか許可できない |
| T06 | PASS（ローカル） | 同じセッション・会話。`screenshot` で確認後、`cmd+↓`→`type "-B"`。本文 `CHCU-r1012b-A-B`（11:10:24Z）。本文クリックは「通知センター」のオーバーレイ判定で2回ブロックされ、キーボード操作に切り替えた | `T06-01-reply.txt`、`screens/R1-doc10-after-type-02.jpg` | なし |
| T07 | PASS（ローカル） | 「-C」送信（11:10:25Z）→処理開始を確認（20:10:27）→SSE切断（20:10:29、最終受信seq 99）。切断中に返信ツールの要求 `otxut`（11:10:42Z）が発生。`since=99` で再接続すると seq 100〜102 と `open_requests` が再生され、allow後に `CHCU-r1012b-A-B-C` を回収。続けて「-D」で `CHCU-r1012b-A-B-C-D`（11:11:10Z）。同じ `msg_id` の再送は `duplicate_ignored` | `T07-01-timeline.txt`、`T07-sse-client3.log`、`T07-02/03-*.txt`、`screens/R1-doc10-after-type-03/04.jpg`、`screens/T05-T07-T10-zoom-02-*.jpg` | なし |
| 2周目 T05〜T07 | 同上 | 新規セッション `2a22d3d1`、会話 `conv-r1012b-run2`、「名称未設定 11.txt」に `CHCU-r1012b-R2-A-B-C-D`。CU承認は再び端末のみ。切断・再接続も同様に成立 | `R2-*`、`screens/R2-doc11-after-type-*.jpg`、`screens/R2-T09-zoom-01-*.jpg` | CU承認を端末でAllow（20:12:57） |
| T08 | FAIL（遠隔拒否）／端末拒否は成立 | セッション `9928d84f`。CU承認が端末に出たが中継されず、端末で「Deny, and tell Claude what to do differently」を選んだ。ツール結果は `{"granted":[],"denied":[]}` で拒否が記録されない。Claudeは別名で `request_access` を再試行（未検出でダイアログは出ず）、次にBashでインストール確認を要求し、これは中継されたのでAPIからdeny。GUI操作ツールの呼び出しは0件。その後の通常質問には同じ会話で回答した | `T08-02/03/08-*.txt`、`T08-01-events-summary.txt`、`T08-06-cu-calls.txt`、`T08-transcript-tools-9928d84f.txt` | CU拒否を端末で選択（20:19:42）。Bash要求の拒否はAPI |
| T09 | 補助経路でPASS／Channels単独では不成立 | 下の「3. 停止の実測」を参照 | `T09-A-timeline.txt`、`T09-B-timeline.txt`、`T09-B-pane-after-esc.txt`、`screens/R2-T09-zoom-02/03-*.jpg` | tmuxへEsc送信（`/api/interrupt`） |
| T10 | 一部PASS | `start-session.sh --resume 66e6a74b-…` で同じ会話IDに戻り、画面に前回のやり取りが表示され、Channelも同じセッションIDで再登録された。CUは使えたが `list_granted_applications` は空で、`request_access` の承認ダイアログが再び端末に出た。承認後に「名称未設定 10.txt」の本文 `CHCU-r1012b-A-B-C-D` を画面確認して返した | `T10-00/02/03/04/05-*.txt`、`T10-session-id.txt`、`screens/T05-T07-T10-zoom-02-*.jpg` | 開発用チャネル警告とCU再承認を端末で押した |

画面証拠は、CUの `zoom` 結果（領域限定）と、`computer_batch` の入力直後スクリーンショットをTextEditのウィンドウ部分だけに切り出した画像です。全画面のキャプチャは無関係なアプリの内容を含むため提出していません。検証者は切り出し前の画像で本文を目視確認しています。

## 3. 停止の実測（T09、セッション `2a22d3d1`）

**T09-A：通常メッセージ。** 「名称未設定 12.txt」に `CHCU-r1012b-T09-01`〜`-10` を3秒間隔で入力する依頼を 11:15:14Z に送りました。Claudeは32アクションを1回の `computer_batch` にまとめ、11:15:33Z〜11:16:07Z に実行しました。「停止してください」は 11:15:24Z に送信し、バッチ開始より前に届いていましたが、処理されたのはバッチ完了後でした（11:16:22Z に「届いた時点で終わっていた」と返信）。10行すべてが入力されました。Channelsのメッセージは実行中の割り込みにはなりません。

**T09-B：補助経路。** 「名称未設定 13.txt」に `CHCU-r1012b-T09B-01`〜`-10` を依頼（11:16:54Z）。今回は1行ごとのバッチになりました。2行目のバッチ開始（11:17:08.9Z）の約3秒後、WebChatの `/api/interrupt`（tmuxへEscを送る）を 11:17:12.0Z に実行しました。端末に「Interrupted · What should Claude do instead?」が出て、ツール結果は「ユーザーが中断」になり、残り8行は入力されませんでした。次の発言（11:17:22Z）に同じ会話で応答し、画面確認で2行入力済みであることを報告しました（`zoom` 11:17:35Z）。

注意点として、Escは2行目の `type` 完了後の `wait` 中に届いたため、ツール結果が「却下」でも2行目は入力済みでした。中断後の実状態は画面で確認する必要があります。この経路は端末への入力で、Channelsの機能ではありません。

## 4. 能力ごとの最終回答

| 判断したいこと | 結論と条件 |
| --- | --- |
| 別端末から純正CUを実行できるか | 同じMac上のAPI呼び出しでは成立（T05、2周目）。別端末・別ネットワークは未実施 |
| CU固有の許可と拒否をWebChatで扱えるか | できない。CUのアプリ承認はpermission relayに流れず、端末ダイアログのみ。通常ツールの許可・拒否はできる |
| 同じ会話で画面を再確認しながら操作を続けられるか | できる（T06、T07、2周目）。本文の重複や作り直しはなかった |
| WebChat再接続後に結果を回収し、重複なく続けられるか | できる。`since` 再生で切断中の承認要求と結果を回収し、`msg_id` の重複送信は無視される |
| 実行中に遠隔停止できるか。どの経路か | Channelsのメッセージでは不可。tmuxへのEsc送信（端末操作の代行）なら実行中のバッチを中断でき、会話も続く |
| 別ネットワークからも実施できたか | 未実施 |
| セッション起動・再起動時に何の人手が必要か | 開発用チャネル警告の承認（起動ごと、端末のみ）。CUのアプリ承認（セッションごと、端末のみ）。OS権限付与後はClaude Codeの再起動 |
| CLI再開後もCUを利用できるか | 利用できるが、アプリ承認はやり直し。会話履歴とChannel再接続は維持 |

## 5. 対象Macで必要だった操作（介入記録）

| 時刻（JST） | 操作 | 区分 | 操作者 | 影響したケース |
| --- | --- | --- | --- | --- |
| 19:57頃 | システム設定でTerminal.appにアクセシビリティを付与 | 初期OS設定 | 人 | T01以降すべて |
| 19:59〜20:00 | 付与前に起動したセッションを `/exit`、tmuxサーバーを再起動 | 初期OS設定の反映 | 検証者 | T01 |
| 20:01:02 | CUアプリ承認をAllow | 日常のアプリ承認 | 検証者（tmux） | T01 |
| 20:03:20、20:04:11 | fakechatの返信ツール承認をEnter | 通常ツール承認 | 検証者（tmux） | T02 |
| 20:03:50 | CUアプリ承認をAllow | 日常のアプリ承認 | 検証者（tmux） | T02 |
| 20:05:22、20:07:16、20:12:11、20:18:56、20:23:31 | 開発用チャネル警告で「I am using this for local development」 | セッション起動時の確認（毎回） | 検証者（tmux） | T03〜T10 |
| 20:08:49、20:12:57、20:23:47 | CUアプリ承認をAllow | 日常のアプリ承認 | 検証者（tmux） | T05、2周目、T10 |
| 20:17:12 | `/api/interrupt` でtmuxへEsc | 緊急停止（補助経路） | 検証者（API） | T09-B |
| 20:19:42 | CUアプリ承認をDeny | 日常のアプリ承認 | 検証者（tmux） | T08 |
| 各試験の終わり | `/exit` | 試験間の切り替え | 検証者（tmux） | 全体 |

通常ツールの承認（返信ツール、Bash）はすべてWebChat API（`/api/verdict`）から回答し、端末では押していません。

## 6. 後片付け

未実施です。試験用の未保存書類「名称未設定 8〜13.txt」がTextEditに開いたまま残っています（8：T01、9：T02、10：T05〜T07とT10、11：2周目、12：T09-A、13：T09-B）。TextEditにはこれら以外の未保存書類もあるため、検証者は誤って閉じないよう操作していません。20:25にosascriptで書類名の一覧取得を試みましたが、20秒以内に応答がなく中止しました（Automation権限の確認が出た可能性があります）。

対象Macの人が、上記6枚だけを「保存しない（削除）」で閉じてください。

## 7. 検証用構成と採用時の最小構成

```
WebChat（別端末想定）──HTTP(SSE+POST, Bearer)──> webchat-test (Bun, 対象Mac :8790)
                                                 │ stdio (MCP, claude/channel + permission)
                                                 ▼
                                   Claude Code 対話CLI (tmux "chcu", manual mode)
                                                 │ 組み込み computer-use
                                                 ▼
                                             TextEdit
WebChat「Esc送信(補助)」──> /api/interrupt ──tmux send-keys Escape──> 同じ端末
```

採用する場合に残る制約は次のとおりです。

- CUのアプリ承認は端末ダイアログにしか出ない。WebChat完結にするには、tmuxの画面を読み取ってWebChatに表示し、選択キーを送る補助機能が要る。これは端末操作の代行であり、Channelsの機能ではない。
- 実行中の停止も同じ補助経路が要る。停止後の実状態（どこまで入力されたか）は画面で確認する必要がある。
- 独自Channelは research preview の間、起動のたびに開発用チャネル警告を端末で答える必要がある。
- CUの再開後はアプリ承認がやり直しになる。
- CUのロックはセッション終了まで保持され、1台につきCUを使う会話は同時に1つ。
- 日本語環境ではアプリ名「TextEdit」「テキストエディット」が解決されず、bundle IDの指定が必要だった。クリック位置によっては「通知センター」のオーバーレイ判定でクリックがブロックされる。
- 通常ツールの承認はWebChatと端末の両方に同時に出る。早い方の回答が採用される。
- 検証者のセッション（`.claude/settings.local.json` の `enabledMcpjsonServers`）がwebchat-testとfakechatを通常のMCPサーバーとして起動し、ポート8790・8787を占有していた。被験セッションを起動する前に止める必要があった。

## 8. 提案

Channelsを会話・通常ツール承認・再接続の主経路として採用し、CU承認・停止・起動時確認の3場面だけ端末の補助経路で補う構成を提案します。追加実装は次の2点です。

1. tmuxペインの画面を定期的に読み取り、CU承認ダイアログや開発用チャネル警告を検出してWebChatに表示し、選択キー（Enter、Down、Esc）を送るAPI。既存の `/api/interrupt` と同じ経路の拡張で済みます。
2. 停止後に画面を再確認して実状態を返す定型指示。中断時のツール結果は部分実行を反映しないためです。

Claude Code側でCUの承認がpermission relayに流れるようになれば、1は不要になります。その時点で再検証してください。

別端末・別ネットワークからの実施は未検証です。採用判断の前に、SSHトンネル等で `127.0.0.1:8790` へ届く経路を用意し、T03・T05・T07を1回ずつ別端末から実施する必要があります。

## 9. 再現手順

```bash
# 前提: macOS, Claude Code v2.1.296 以降, claude.ai 認証 (Pro/Max), Bun, tmux
# Terminal.app に「アクセシビリティ」「画面収録」を付与し、付与後に Claude Code を起動し直す
cd <repo>
git switch test/claude-channels-cu
(cd prototype/webchat-test && bun install)
mkdir -p ~/.claude/channels/webchat-test
openssl rand -hex 16 > ~/.claude/channels/webchat-test/token
chmod 600 ~/.claude/channels/webchat-test/token

# 初回のみ: 通常起動で /mcp → computer-use → Enable
claude

# 検証者側のセッションが webchat-test/fakechat を MCP として起動していればポートを解放する
lsof -nP -iTCP:8790 -iTCP:8787 -sTCP:LISTEN

# Channel付きで起動 (tmux)。開発用チャネル警告に端末で答える
prototype/webchat-test/start-session.sh          # 再開は --resume <session-id>
tmux send-keys -t chcu Enter                         # または tmux attach -t chcu

# WebChat API（別端末からは SSH トンネル等で 127.0.0.1:8790 へ）
source prototype/webchat-test/tools/flow.sh      # send / verdict / waitpr / allow_reply
CONV=conv-test send m1 'hello'
allow_reply $(lastseq)                               # 返信ツールの承認要求を allow して返信を待つ
curl -s -X POST localhost:8790/api/interrupt -H "Authorization: Bearer $TK"   # 補助経路の停止

# 証拠の抽出
python3 -I prototype/webchat-test/tools/extract.py ~/.claude/projects/<slug>/<session-id>.jsonl
python3 -I prototype/webchat-test/tools/images2.py <transcript.jsonl> <outdir> <prefix>   # zoom 画像のみ

# 後片付け: 試験用 TextEdit 書類を保存せずに閉じる。tmux send-keys -t chcu /exit Enter
```

## 10. 補足

- 被験セッションでは、ユーザー設定のフック（`claudecode-monitor/hooks/claude-code-hook.sh`）が見つからないエラーが毎回出た。動作は止まらず、結果には影響していない。証拠のペイン出力からはこの行を除いている。
- 全セッションを通じて `unknown_notification` は一件も記録されなかった。CU承認はMCP通知として一切Channelに送られていない。
- T08で端末からDenyを選んでも `request_access` の結果は `denied: []` で、拒否がアプリ単位で記録されない。Claudeは別名で再要求し、bundle IDで再要求していれば承認ダイアログが再び出た可能性がある。
- 返信ツールの承認は毎回要求される（「don't ask again」は選んでいない）。実運用では返信ツールを許可リストに入れると承認要求が減る。
- `start-session.sh` は macOS 標準の bash 3.2 で `set -u` と空配列の組み合わせにより起動できなかったため修正した。
