# 02 ワーカー常駐プログラム

作成日: 2026-10-13
状態: Phase 1 確定版
関連: [00 全体アーキテクチャ](00-architecture.md)、[01 設定スキーマ](01-config-schema.md)、[03 ハブとワーカー間の通信](03-hub-worker-protocol.md)

## 1. 役割

ワーカー常駐プログラム（以下デーモン）は作業 Mac で動く Claude ではないプログラムで、次を受け持つ。

- ハブへ自分から接続し、命令を受け、出来事を返す
- tmux の中で Claude Code の対話セッションを起動・再開・停止する
- セッションごとのチャネル中継（後述のブリッジ）と localhost でつながり、指示の流し込みと結果の受け取りを行う
- tmux 画面を読み取り、端末にしか出ないダイアログを WebChat へ中継し、選ばれた選択肢のキーを送る

セッションの起動と画面操作は、ハブ側の秘書セッションでも同じ部品（`shared/session-manager.ts`）を使う。

## 2. 部品と接続

```text
ハブ ◄──WebSocket /ws/worker（03 の形式）── デーモン ──tmux──► Claude Code（セッションごと）
                                              ▲                     │ stdio（MCP）
                                              └──WebSocket /bridge── ブリッジ（セッションごとに 1 つ）
```

### 2.1 ブリッジ（チャネル中継）

ブリッジは Claude Code が子プロセスとして起動する小さなチャネルサーバーで、秘書と作業セッションで同じプログラム（`shared/bridge.ts`）を使う。

- 起動時にデーモン（秘書ならハブ）の `/bridge` へ WebSocket で接続し、`hello` でセッションキーを名乗る
- デーモンから `instructions` と公開するツールの一覧を受け取ってから MCP サーバーを開始する。役割ごとの違いはデーモン側だけに置く
- `notifications/claude/channel` と `.../permission`（判定）をデーモンの指示どおりに Claude Code へ書く
- Claude のツール呼び出しと `permission_request` をデーモンへそのまま転送する
- デーモンとの接続が切れたら 1 秒から 30 秒まで間隔を延ばして再接続する。切断中のツール呼び出しはエラーで返す

ブリッジへは `--mcp-config` で設定を渡す。2026-10-13 の実測（Claude Code v2.1.296）で、`--mcp-config` で定義したサーバーを `--dangerously-load-development-channels server:<name>` で指定すると、起動画面に「no MCP server configured with that name」と表示されるものの、通知の流し込みと承認の中継はどちらも動いた。表示と実動作が食い違っているため、版を上げるたびに再確認する。

`.mcp.json` を使わない理由は 2 つある。プロジェクトのフォルダを書き換えずに済むことと、初回起動時の「New MCP server found」同意ダイアログを避けられることだ。

ブリッジへ渡す環境変数は次のとおり。秘密情報そのものは渡さない。

| 変数 | 中身 |
| --- | --- |
| `HANNIGAN_BRIDGE_URL` | `ws://127.0.0.1:<local.port>/bridge` |
| `HANNIGAN_BRIDGE_TOKEN_FILE` | `secrets/local-bridge-token.*` の場所 |
| `HANNIGAN_SESSION_KEY` | デーモンが決めたセッションキー（UUID） |
| `HANNIGAN_SERVER_NAME` | MCP サーバー名。既定 `hannigan`（ツール名は `mcp__hannigan__reply` になる） |

Claude Code はブリッジに `CLAUDE_CODE_SESSION_ID` も渡す（実測）。ブリッジは `hello` にこの値も入れ、デーモンが記録する。

## 3. セッション

### 3.1 識別子

- セッションキー: デーモンが UUID を生成し、`claude --session-id <UUID>` で Claude Code の会話 ID と一致させる。秘書とハブはこのキーで呼ぶ
- 会話 ID: Claude Code の会話 ID。作成時はセッションキーと同じ。端末で `/clear` を実行すると新しい会話 ID に変わる（実測、T12）。デーモンは `/clear` を命令として提供しないので、通常は変わらない
- tmux 名: `<tmux.prefix>-<project>-<キーの先頭 8 文字>`

### 3.2 状態遷移

```text
             session_create / session_resume
                         │
                         ▼
                    ┌─starting─┐ ──端末ダイアログ検出──► awaiting_terminal ──選択キー送信──┐
                    │          │ ◄───────────────────────────────────────────────────────┘
                    │  ブリッジ接続 + 入力欄表示
                    ▼
     ┌──────────► ready ◄──────────┐
     │   流し込み  │   作業の完了     │
     │            ▼                 │
     │         working ─────────────┘
     │            │ 承認ダイアログ → awaiting_approval（中継で回答されると working に戻る）
     │            │
 session_stop  session_interrupt（Esc）→ 画面で入力欄を確認して ready
     │
     ▼
  stopping ──tmux 終了──► stopped
  （どの状態からでも tmux が消えたら exited、起動 90 秒以内に ready にならなければ failed）
```

| 状態 | 判定の根拠 |
| --- | --- |
| `starting` | tmux を作った直後 |
| `awaiting_terminal` | 画面に端末ダイアログ（4 章）があり、通常ツールの承認ではない |
| `ready` | ブリッジ接続済みで、画面に作業中の表示がなく、入力欄（`❯`）が出ている。作業中の表示は `esc to interrupt` か、記号＋語＋`…` の行（v2.1.296 の実測 `✽ Hashing… (11s · ↓ 448 tokens)`） |
| `working` | 流し込み直後、または画面に作業中の表示がある |
| `awaiting_approval` | ブリッジから `permission_request` を受け、まだ判定が出ていない |
| `stopping` / `stopped` / `exited` / `failed` | 上図のとおり |

画面の判定は 1 秒ごとに `tmux capture-pane -p` で行う。状態が変わったときだけハブへ `session_state` を送る。

### 3.3 記録

`worker/sessions.json` に次を保存する。デーモンを再起動したら、記録と `tmux ls` を突き合わせて状態を戻す。ブリッジは自動で再接続してくるので、Claude Code 側は何もしなくてよい。

```json
{ "key": "UUID", "project": "notes", "name": "表示名", "tmux": "hn-notes-1a2b3c4d",
  "conversation_id": "UUID", "state": "ready", "created_at": "...", "updated_at": "...",
  "last_chat_id": "conv-..." }
```

## 4. 命令

ハブから届く命令は固定の種類だけを受け付ける。起動や停止に Claude の判断を挟まない。

| 命令 | 引数 | 動き | 返り値 |
| --- | --- | --- | --- |
| `list` | なし | プロジェクトとセッションの一覧 | `{projects, sessions}` |
| `session_create` | `project`, `name?`, `chat_id?` | 新しいキーで tmux を作り、プロジェクトのフォルダで Claude Code を起動する | `{session}`（状態は `starting`） |
| `session_resume` | `session`（キー） | 停止済みのセッションを `--resume <会話 ID>` で同じフォルダに起動し直す | `{session}` |
| `session_send` | `session`, `text`, `chat_id?`, `message_id?` | ブリッジ経由で `<channel>` として流し込む。ブリッジ未接続なら接続まで待つ（最大 30 件まで保持） | `{status: delivered \| queued}` |
| `session_interrupt` | `session` | tmux へ Esc を送る | `{status: key_sent}` |
| `session_stop` | `session` | `/exit` を送り、10 秒で終わらなければ tmux を終了する。強制終了は同じ起動回のセッションにだけ行う（停止直後の再開は同じ tmux 名を使うため） | `{status}` |
| `approval_answer` | `session`, `request_id`, `behavior` | ブリッジ経由で判定を Claude Code へ書く | `{status}` |
| `terminal_answer` | `session`, `prompt_id`, `option` | 画面を読み直し、同じダイアログが出ていれば選択キーを送る | `{status}` |

`session_send` の本文は tmux のキー入力ではなくチャネル通知で届けるので、端末の操作として解釈されない。

## 5. 出来事（ハブへ送るもの）

| 出来事 | 中身 | 発生条件 |
| --- | --- | --- |
| `session_state` | `session`, `state`, `detail?` | 状態の変化 |
| `session_report` | `session`, `text`, `chat_id?`, `in_reply_to?` | 作業セッションの Claude が返信ツールを呼んだ |
| `permission_request` | `session`, `request_id`, `tool_name`, `description`, `input_preview` | ブリッジ経由の承認要求 |
| `permission_closed` | `session`, `request_id`, `reason` | 判定済み、端末で回答済み、セッション終了 |
| `terminal_prompt` | `session`, `prompt_id`, `kind`, `title`, `body`, `options[]`, `cursor` | 端末ダイアログの出現 |
| `terminal_prompt_closed` | `session`, `prompt_id` | ダイアログが画面から消えた |
| `inventory` | `projects`, `sessions` | 接続直後とプロジェクト設定の変更時 |

出来事は送る前に `worker/outbox.jsonl` に通し番号つきで追記し、ハブの受領確認（`ack`）まで消さない。再送と重複排除は 03 で定める。

## 6. 端末画面の読み取り（補助経路）

Channels で届かない端末ダイアログを WebChat から扱うための仕組みで、Channels の機能ではなく端末操作の代行である。

### 6.1 検出

画面の最後の罫線（`─` が 40 文字以上続く行）から下を対象にし、次の両方を満たすとダイアログとみなす。

- 選択肢の行がある。カーソル行は `❯` で始まり、ほかの選択肢は同じ字下げで並ぶ
- 末尾近くに `Enter to confirm` または `Esc to cancel` を含む行がある

実測した形は次のとおり（2026-10-12〜13、v2.1.296）。

| 種類 | 見分け方 | 選択肢 | カーソルの初期位置 |
| --- | --- | --- | --- |
| `dev_channel_warning` | `WARNING: Loading development channels` | `1. I am using this for local development` / `2. Exit` | 1 |
| `workspace_trust` | `Is this a project you created or one you trust` | `No, exit` / `Yes, I trust this folder`（番号なし） | 1（No） |
| `cu_app_approval` | `Computer Use wants to control these apps` | `Deny, and tell Claude what to do differently (esc)` / `Allow for this session (N app)` | 1（Deny） |
| `tool_permission` | `Do you want to proceed?` | `1. Yes` / `2. Yes, and don't ask again …` / `3. No` | 1 |
| `unknown` | 上のどれでもない | 画面から読んだ行 | 画面のとおり |

`tool_permission` はチャネルの承認中継（`permission_request`）と同じものなので、WebChat には中継側だけを出し、端末ダイアログとしては送らない。

### 6.2 回答

1. WebChat で選ばれた選択肢の番号を受ける
2. 画面を読み直し、`prompt_id`（種類とタイトルと選択肢から作るハッシュ）が一致することを確かめる。違えば `stale` で断る
3. カーソル位置との差だけ `Down` か `Up` を送り、最後に `Enter` を送る。番号つきの選択肢でも同じ方法を使う
4. 1 秒後に画面を読み、ダイアログが消えたかを結果として返す

`auto_accept` の設定がある種類（01 の 4.1）は、デーモンが 2〜4 を自分で行い、その事実を出来事として記録する。`workspace_trust` の自動承認は `projects` に登録されたフォルダのときだけ行う。

### 6.3 停止

`session_interrupt` は Esc を送るだけで、実行中のツールがどこまで進んだかは分からない（検証 T09）。秘書には「停止を送ったので、画面か作業結果で実状態を確かめる」と返す。

## 7. 失敗と再接続

| 場面 | 動き |
| --- | --- |
| ハブとの接続が切れた | 1 秒から 30 秒まで間隔を延ばして再接続する。セッションは止めない。出来事は outbox に溜める |
| ブリッジとの接続が切れた | セッションの状態は画面で判定を続ける。ブリッジの再接続を待つ |
| tmux が消えた | `exited` を送り、未回答の承認要求を `permission_closed` で閉じる |
| デーモンが再起動した | `sessions.json` と `tmux ls` を突き合わせる。tmux が残っていれば監視を再開し、無ければ `stopped` にする |
| Claude Code が 90 秒以内に入力欄を出さない | `failed` にして画面の末尾 20 行を `detail` に入れる |

## 8. 既知の制約

- `/clear` などのコマンドはチャネルから実行できない。チャネルで送った `/clear` は文章として Claude に届き、会話は消えない（T12）。必要なら端末操作の代行で送る（Phase 2 では提供しない）
- 端末で `/clear` を打つと会話 ID が変わる。ブリッジの `CLAUDE_CODE_SESSION_ID` は起動時の値のままなので、再開に使う会話 ID は `~/.claude/projects/<フォルダ>/` の最新ファイルで確かめる必要がある
- 画面の文言は Claude Code の版で変わりうる。検出の文字列は `shared/pane.ts` の 1 か所に集め、版を上げるたびに試験で確かめる
- 1 台の Mac で純正 CU を使えるセッションは同時に 1 つ。デーモンはこれを管理せず、Claude Code の判定に任せる
- CU のアプリ承認は Channels にも Remote Control にも届かず、端末にだけ出る。承認はセッション単位で、新規作成と再開のたびに最初の CU 利用で 1 回要る（T10、T11）。WebChat へは 6 章の画面読み取りで中継する
