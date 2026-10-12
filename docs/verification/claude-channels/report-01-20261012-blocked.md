# Claude Code Channels × 純正Computer Use 実機検証レポート（第1回）

実施日：2026年10月12日（JST）  
実施者：Claude Code（自律実行セッション。人の操作者・別端末は不在）  
ブランチ：`test/claude-channels-cu`（基準commit `ffa1194`）  
検証コード：[`verification/webchat-test/`](../../../verification/webchat-test/)  
証拠：[`evidence/`](evidence/)

## 0. 結論

総合判断は **判定保留** です。

対象Macで、純正Computer Use（以下CU）に必要なmacOSの「アクセシビリティ」と「画面収録」の権限が付与されていません。そのためCUを使う試験（T01、T02後半、T05〜T09、T10のCU部分）はすべて止まりました。権限の付与はシステム設定で人が行う操作で、今回の自律実行では行えませんでした。

不足している一点は、対象MacでのCU用OS権限です。次の確認方法は「6. 残りの試験の進め方」の手順1〜3で、権限付与後にT01を再実行します。

CUを使わない部分は、同じMac上からの予備実測として次を確認しました。別端末・人による操作ではないため、正式なPASSには数えていません。

- 独自Channelで、WebChatの発言が同じClaudeセッションに届き、前の発言を踏まえた返答が同じ会話に戻った（T03相当）。
- 通常ツール（Bash、返信ツール）の承認要求がChannelに届き、WebChat API経由の許可・拒否がそのまま実行可否に反映された（T04相当）。
- ブラウザ再接続時に、切断中のイベントを取りこぼさず再取得できた。同じ送信IDの再送は二重に届かなかった（T07の仕組み部分）。
- 前景処理の中断は、Channelsのメッセージでは行えなかった。tmuxへEscを送る補助経路で中断でき、その後も同じ会話を続けられた（T09の予備）。
- `--resume`で同じ会話IDを再開し、Channelを再接続して、前の合言葉を答えられた（T10のCU以外）。

## 1. 環境

| 項目 | 値 | 確認方法 |
| --- | --- | --- |
| 対象Mac | Mac mini（ユーザー名 m1_mini）、macOS 26.5.1（25F80）、arm64 | `sw_vers`、`uname -m` |
| 操作用端末 | なし。同じMac上の curl と Bun 製WebSocketクライアントで代用 | ― |
| 接続経路 | 127.0.0.1 のみ。LAN公開（0.0.0.0:8798）はUIとAPIの応答だけ確認 | curl |
| Claude Code | v2.1.296、claude.ai認証、Max プラン | `claude --version`、`claude auth status` |
| 起動方法 | tmux 3.8 の中で対話型CLIを起動（親環境の変数は `env -i` で除去） | [`start-session.sh`](../../../verification/webchat-test/start-session.sh) |
| 作業ディレクトリ | `~/Desktop/逃し/concierge_test` | ― |
| モデル | Fable 5.1（effort high、ユーザー設定の既定値） | 起動バナー |
| permission mode | manual（`--permission-mode manual`） | ステータス行 `⏸ manual mode on` |
| 組み込みCU | `/mcp` で `computer-use` を有効化。24ツール。`request_access`、`left_click`、`computer_batch` 等 | `/mcp` 画面、ToolSearch結果 |
| 独自Channel | `webchat-test` 0.0.1、`@modelcontextprotocol/sdk` 1.32.1、zod 4.6.6、Bun 1.3.9 | `.mcp.json`、`package.json` |
| fakechat | `fakechat@claude-plugins-official` 0.0.1。`server.ts` の blob SHA は `f258a83ebbb0ddfbabfc674389308ab5c97a75c9` で依頼書と一致 | `git hash-object` |
| 利用枠 | 試験開始時のステータス行で 5時間枠 92%、7日枠 96% 使用済み | ステータス行 |

公式資料は2026年10月12日に次を確認しました。依頼書の前提と食い違う記述はありませんでした。

- [Computer use（CLI）](https://code.claude.com/docs/en/computer-use)：Pro/Max、claude.ai認証、対話セッション必須。アプリ承認はセッション単位。停止は Esc または Ctrl+C。ロックはセッション終了まで保持。
- [Channels](https://code.claude.com/docs/en/channels)：research preview。fakechat は localhost:8787。
- [Channels reference](https://code.claude.com/docs/en/channels-reference)：permission relay の対象は「Bash、Write、Edit などのツール承認」。プロジェクト信頼とMCPサーバー同意のダイアログは中継されない。CUのアプリ承認が中継されるかの記述はない。

## 2. ケース別結果

時刻はJST。ログ内の時刻はUTC（JST−9時間）です。

| ケース | 判定 | 実測結果 | 証拠 | 現地操作・補助経路 |
| --- | --- | --- | --- | --- |
| T01 | BLOCKED | 18:10:57 に `mcp__computer-use__request_access`（TextEdit）が呼ばれた。端末に「Computer Use needs macOS permissions」と出て、アクセシビリティと画面収録が未付与だった。ツール結果は「権限が未付与なので再試行しない」。GUI操作は一度も起きていない。子セッションはAppleScript等へ切り替えずに止まった | `T01-pane-permission-dialog.txt`、`transcript-tools-798c4618-….txt` | 権限ダイアログを検証者がEscで閉じた |
| T02 | BLOCKED（往復のみローカル成立） | fakechat に WebSocket で `FC-r1012a-T02` を送り、6秒後に同じ文字列が返った。返信ツールの承認は端末で押した（fakechat に中継機能はない）。CU依頼の手順2はT01と同じ原因で未実施 | `T02-fakechat-ws.log`、`T02-pane-reply-dialog.txt` | 返信承認を端末でEnter |
| T03 | 未実施（遠隔）／ローカル予備は成立 | 合言葉を送り、次の発言で「先ほどの合言葉」を求めた。同じセッション `6d636d6b-…` から `in_reply_to` 付きで同じ会話 `conv-r1012a` に正しい合言葉が戻った | `webchat-events.jsonl` seq 5〜15 | 開発用チャネル警告を端末で承認 |
| T04 | 未実施（遠隔）／ローカル予備は成立 | 許可：返信ツールの要求 `zxbwd` に allow を送ると端末ダイアログが閉じて実行された。拒否：Bash要求 `sqavg` に deny を送ると「Denied via channel webchat-test」となり、目印ファイルは作られなかった。存在しないID `qqqqq` と未認証の回答は無視され、ダイアログは開いたままだった | `webchat-events.jsonl` seq 8〜24、`T04-*.txt` | 回答者は人ではなく検証者のcurl |
| T05 実行 | BLOCKED | T01のOS権限不足のため未実施 | ― | ― |
| T05 CU遠隔許可 | BLOCKED | 同上。CUのアプリ承認がChannelに届くかは未確認 | ― | ― |
| T06 | BLOCKED | 同上 | ― | ― |
| T07 | BLOCKED（仕組みのみ確認） | CUは未実施。WebChat側は `since=<最後のseq>` で再接続すると切断中のイベントを再生できた。同じ `msg_id` の再送は `duplicate_ignored` になりClaudeへ届かない | `webchat-events.jsonl` | ― |
| T08 | BLOCKED | 同上 | ― | ― |
| T09 | BLOCKED（Bashでの予備あり） | 下の「3. 停止の予備実測」を参照 | `transcript-tools-6d636d6b-….txt` | tmuxへEsc送信（補助経路） |
| T10 | 一部実施 | `claude --resume 6d636d6b-…` で同じ会話IDに戻り、Channelも再登録された。合言葉を正しく返した。CUの再利用とアプリ承認の保持は未確認 | `T10-pane.txt`、seq 46〜52 | 開発用チャネル警告を再度端末で承認 |

## 3. 停止の予備実測（CUの代わりにBashを使用）

**予備A：チャットでの「停止してください」。** 子セッションの実行環境が前景の `sleep 40` をブロックしたため、Claudeは処理をバックグラウンドに回してターンを終えました。その後の「停止してください」は新しいターンとして処理され、Claudeが `TaskStop` でバックグラウンド処理を止めました。これは「Channelsのメッセージとして後から停止意図を処理した」例です。実行中のツール呼び出しを割り込みで止めた例ではありません。

**予備B：前景処理の中断。** 前景で約20秒かかる計算を始めた3秒後に、WebChatの「Esc送信」ボタンと同じAPIからtmuxへEscを送りました。端末に「Interrupted」と出て、後続の目印ファイルは作られませんでした。中断後にClaudeからWebChatへの返信はなく、WebChat側は停止を自力で確認できません。次の発言で、同じ会話の続きとして中断結果と合言葉が返りました。

この経路は端末への入力で、Channelsの機能ではありません。WebChat画面では「補助」と表示し、送信結果も `key_sent_unconfirmed` として扱っています。

## 4. 能力ごとの最終回答

| 判断したいこと | 結論と条件 |
| --- | --- |
| 別端末から純正CUを実行できるか | 未確認。対象MacのCU用OS権限が未付与で、CUが一度も動いていない |
| CU固有の許可と拒否をWebChatで扱えるか | 未確認。公式資料も中継対象として明記していない。CUのアプリ承認は `request_access` ツール内の端末ダイアログとして出ることだけ確認した |
| 同じ会話で画面を再確認しながら操作を続けられるか | 未確認。会話の継続自体は成立した |
| WebChat再接続後に結果を回収し、重複なく続けられるか | 仕組みは成立（イベント再生と送信ID重複排除）。CU操作では未確認 |
| 実行中に遠隔停止できるか。どの経路か | Channelsの通常メッセージは割り込みにならない。前景処理はtmuxへのEsc送信という補助経路で中断できた（Bashでの予備）。CU操作中は未確認 |
| 別ネットワークからも実施できたか | 未実施。同じMac内のみ |
| セッション起動・再起動時に何の人手が必要か | 下の「5. 対象Macで必要だった操作」を参照。開発用チャネル警告は起動のたびに端末で承認が必要だった |
| CLI再開後もCUを利用できるか | 未確認。会話履歴とChannel再接続は成立 |

## 5. 対象Macで必要だった操作（介入記録）

すべて検証者（このClaude Codeセッション）がtmux経由で対象Macの端末に入力しました。人による操作はありません。

| 時刻（JST） | 操作 | 区分 | 理由 | 影響したケース |
| --- | --- | --- | --- | --- |
| 18:05頃 | `brew install tmux` | 初期設定 | 端末を保持して遠隔からEscを送るため | 全体 |
| 18:10 | 「New MCP server found: webchat-test」で「Use this MCP server」 | セッション起動時の確認（初回のみ） | `.mcp.json` のサーバー同意 | 全体 |
| 18:10 | Claude in Chrome の案内で「No」 | セッション起動時の確認（初回のみ） | ブラウザ操作を試験から除外 | T01 |
| 18:10 | `/mcp` で `computer-use` を Enable | 初期設定（プロジェクト単位で1回） | 組み込みCUの有効化 | T01以降 |
| 18:11 | macOS権限ダイアログをEscで閉じた | 初期OS設定（未完了） | 権限付与は人の操作が必要 | T01 |
| 18:12、18:17 | 開発用チャネル警告で「I am using this for local development」 | セッション起動時の確認（毎回） | `--dangerously-load-development-channels` の仕様 | T03〜T10 |
| 18:16:50 | WebChat APIからtmuxへEsc | 緊急停止（補助経路） | 停止の予備実測 | T09予備 |
| 18:18 | `claude plugin install fakechat@claude-plugins-official --scope user` | 初期設定 | T02 | T02 |
| 18:19:05 | fakechatの返信承認を端末でEnter | 日常のアプリ承認ではなく通常ツール承認 | fakechatは承認を中継しない | T02 |
| 各試験の終わり | `/exit` | 試験間の切り替え | CUロックの解放 | 全体 |

## 6. 残りの試験の進め方

対象Macの前に人がいる状態で、次の順に進めてください。

1. システム設定の「プライバシーとセキュリティ」で、「アクセシビリティ」と「画面収録とシステムオーディオ録音」にTerminal.appを追加してオンにする。tmux経由の起動でどのアプリ名が要求されるかは未確認なので、最初は `tmux attach -t chcu` した状態で権限ダイアログの「Open System Settings」から開く。
2. Terminal.appを終了して開き直す。画面収録の反映には再起動が必要な場合がある。
3. 通常の `claude` でT01を再実行し、TextEditへの入力とCUツールの記録を確認してから `/exit` する。
4. `verification/webchat-test/start-session.sh` でT03以降のセッションを起動し、`tmux attach -t chcu` で開発用チャネル警告に答えてから detach する（Ctrl+B のあと D）。
5. 別端末で WebChat を開く。同じLANなら `WEBCHAT_HOST=0.0.0.0` を付けて起動し、`http://<対象MacのIP>:8790/#token=<token>` を開く。別ネットワークからは、SSHトンネル等で `127.0.0.1:8790` へ届く経路を用意する。トークンは `~/.claude/channels/webchat-test/token` にある。
6. T05〜T09を依頼書どおり人が操作する。CUの承認がWebChatに出たかは、画面の承認カードと `events.jsonl` の `permission_request` または `unknown_notification` の有無で判定できる。
7. 後片付けとして、試験用TextEdit書類を保存せずに閉じる。

この Mac では `Control_VPS_byClaw` が見つからなかったため、既存VPS経路は使っていません。

## 7. 検証用構成と採用時の最小構成

```
別端末ブラウザ ──HTTP(SSE+POST, Bearerトークン)──> webchat-test (Bun, 対象Mac)
                                                   │ stdio (MCP)
                                                   ▼
                                     Claude Code 対話CLI (tmux "chcu")
                                                   │ 組み込み computer-use
                                                   ▼
                                               TextEdit 等
WebChat「Esc送信(補助)」──> webchat-test ──tmux send-keys Escape──> 同じ端末
```

webchat-test は次を持ちます。

- `claude/channel` と `claude/channel/permission` を宣言し、返信ツール `reply` を公開する。
- すべての受信・送信・承認・切断を `~/.claude/channels/webchat-test/events.jsonl` に追記する。起動時に自分の PID、親の Claude Code の PID、`CLAUDE_CODE_SESSION_ID` を記録するので、ログとセッションを対応付けられる。
- 既知の形式以外の通知を `unknown_notification` として記録する。CUの承認が別の形で届いた場合もここで見える。
- 承認の回答は専用API `/api/verdict` で送る。会話としては送らないので二重送信にならない。

採用する場合も、次の制約は残ります。

- 独自Channelは research preview の間、許可リストに載らず、開発用フラグで起動する必要がある。その警告ダイアログは起動のたびに端末で答える必要があり、中継されない。
- Channelsのメッセージは処理中に割り込めない。実行中の停止には端末への入力という補助経路が要る。
- 承認がWebChatから届いても、端末側のダイアログも同時に開いている。どちらか早い方が採用される。
- CUのロックはセッション終了まで保持されるため、CUを使う会話は1台につき同時に1つだけになる。

## 8. 提案

現時点では、Channelsを主な接続経路として採用するかを判断できません。会話の往復、通常ツールの承認中継、再接続後の回収、CLI再開は予備実測で成立しており、経路としての見込みはあります。

判断に必要な残りは、CUのアプリ承認がChannelに中継されるか（T05）と、CU操作中の停止（T09）の2点です。前者が中継されない場合、CU承認だけは端末の補助経路が必要になります。その場合は、tmuxの画面を読み取ってWebChatに表示し、選択キーを送る補助機能を追加することで、目的を満たせる可能性があります。ただしこれはChannelsの機能ではなく、端末操作の代行として扱う必要があります。

## 9. 再現手順

```bash
# 前提: macOS, Claude Code v2.1.296 以降, claude.ai 認証 (Pro/Max), Bun, tmux
cd ~/Desktop/逃し/concierge_test
git switch test/claude-channels-cu
(cd verification/webchat-test && bun install)
mkdir -p ~/.claude/channels/webchat-test
openssl rand -hex 16 > ~/.claude/channels/webchat-test/token
chmod 600 ~/.claude/channels/webchat-test/token

# 初回のみ: 通常起動で /mcp → computer-use → Enable、macOS権限を付与
claude

# Channel付きで起動 (tmux)
verification/webchat-test/start-session.sh
tmux attach -t chcu        # 開発用チャネル警告に答えて Ctrl+B, D

# 動作確認 (同じMacから)
TK=$(cat ~/.claude/channels/webchat-test/token)
curl -sN "localhost:8790/api/events?since=0&token=$TK" &
curl -s localhost:8790/api/send -H "Authorization: Bearer $TK" \
  -H 'content-type: application/json' \
  -d '{"conv_id":"conv-test","msg_id":"m1","text":"hello"}'
curl -s localhost:8790/api/verdict -H "Authorization: Bearer $TK" \
  -H 'content-type: application/json' -d '{"request_id":"<id>","behavior":"allow"}'

# 後片付け
tmux send-keys -t chcu /exit Enter
```

## 10. 補足

- 子セッションでは、ユーザー設定のフック（`claudecode-monitor/hooks/claude-code-hook.sh`）が見つからないというエラーが毎回出た。動作は止まらず、試験結果には影響していない。
- 対象Macのスクリーンショット取得（`screencapture`）も画面収録の権限不足で失敗した。画面証拠はCUが動く状態になってから取る必要がある。
- WebChat画面（`index.html`）は、スクリプトの構文確認とHTTP応答の確認までで、実ブラウザでの表示確認はしていない。今回の操作はすべて同じAPIをcurlから呼んで行った。
- 今回の全セッションを通じて、`unknown_notification`（既知の形式以外の通知）は一件も記録されなかった。CUが動かなかったため、CU承認の通知の有無はまだ判断材料にならない。
- fakechat付きセッションでも `webchat-test` は通常のMCPサーバーとして起動したが、Channelとして登録されていないため承認要求は届かなかった（seq 53〜54以降に `permission_request` がない）。公式資料の「v2.1.234以降はChannel登録済みのサーバーにだけ承認を送る」という記述と一致する。
