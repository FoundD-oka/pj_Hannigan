# 03 ハブとワーカー間の通信

作成日: 2026-10-13
状態: Phase 1 確定版
関連: [00 全体アーキテクチャ](00-architecture.md)、[01 設定スキーマ](01-config-schema.md)、[02 ワーカー常駐プログラム](02-worker-daemon.md)

この文書は 3 つの接続の形を決める。

| 接続 | 方向 | 形式 |
| --- | --- | --- |
| ハブ ⇄ ワーカー | ワーカーからハブへ接続 | WebSocket `/ws/worker`、JSON（2 章） |
| デーモン ⇄ ブリッジ | ブリッジから同じ Mac のデーモン（秘書はハブ）へ接続 | WebSocket `/bridge`、JSON（3 章） |
| WebChat ⇄ ハブ | ブラウザからハブへ | HTTP と SSE（4 章） |

## 1. 共通の約束

- 1 つの WebSocket フレームに 1 つの JSON を入れる。全メッセージに `t`（種類）を持たせる
- 文字列の ID は英数字、`-`、`_` に限る。長さの上限は 64 文字
- 受け取った側は未知の `t` を記録して無視する。接続は切らない
- 時刻は ISO 8601（UTC）で書く
- 秘密情報（鍵、トークン）は `hello` 以外に載せない。ログには載せない

## 2. ハブ ⇄ ワーカー

### 2.1 接続と認証

1. ワーカーが `hub_url` へ WebSocket で接続する
2. ワーカーが最初に `hello` を送る。ハブは 5 秒以内に `hello` が来なければ切る
3. ハブは `worker-keys.json` の鍵と定数時間で比べる。一致しなければ `bye { reason: "auth" }` を送って切る
4. 一致すれば `welcome` を返す。同じ `worker_id` の古い接続があれば、古い方に `bye { reason: "replaced" }` を送って切る

```json
// ワーカー → ハブ
{ "t": "hello", "proto": 1, "worker_id": "home", "key": "…", "version": "0.1.0",
  "next_seq": 42 }
// ハブ → ワーカー
{ "t": "welcome", "proto": 1, "hub_version": "0.1.0", "last_seq": 40 }
```

`last_seq` はハブが最後に受け取った出来事の番号。ワーカーは `last_seq` より後の出来事を outbox から送り直す。

Phase 2 は同じ Mac の `ws://127.0.0.1` で動かす。Phase 3 で別 Mac につなぐときは TLS（`wss://`）か SSH トンネルを必須にし、平文の `ws://` は `127.0.0.1` 以外で拒否する。

### 2.2 出来事（ワーカー → ハブ）

```json
{ "t": "event", "seq": 41, "ts": "2026-10-13T00:00:00Z", "event": { "kind": "session_report", "session": "UUID", "text": "…" } }
{ "t": "ack", "seq": 41 }   // ハブ → ワーカー
```

- `seq` はワーカーごとの通し番号で、1 から増える。outbox に書いてから送る
- ハブは `seq` が `last_seq` より大きければ処理して `last_seq` を進め、`last_seq` 以下なら処理せずに `ack` だけ返す（重複排除）
- 1 本の WebSocket の中では順序が保たれるので、番号が飛ぶのは outbox が上限を超えて古い出来事を捨てたときだけになる。ハブは飛びを警告として記録し、そのまま処理する。ワーカーは再接続のたびに `inventory` を送るので、セッションの一覧はそこで揃う
- ハブは `last_seq` をワーカーごとに `hub/workers.json` に保存する。ハブを再起動しても重複は起きない
- ワーカーは `ack` を受けた番号までを outbox から消す

出来事の種類は 02 の 5 章のとおり。

### 2.3 命令（ハブ → ワーカー）

```json
{ "t": "command", "id": "c-01HV…", "name": "session_send", "args": { "session": "UUID", "text": "…" } }
{ "t": "result", "id": "c-01HV…", "ok": true, "data": { "status": "delivered" } }
{ "t": "result", "id": "c-01HV…", "ok": false, "error": { "code": "not_found", "message": "…" } }
```

- 命令の種類は 02 の 4 章の固定の一覧だけ。ワーカーは一覧にない `name` を `unknown_command` で断る
- ハブは命令ごとに 30 秒の期限を持つ。期限内に `result` が来なければ秘書へ `timeout` を返す。ワーカーが後から実行しても、結果は出来事として届く
- ワーカーは直近 200 件の命令 ID と結果を覚え、同じ ID が再び届いたら実行せずに前の結果を返す（再送の重複排除）
- ハブは切断中のワーカーへの命令を溜めない。すぐに `worker_offline` を返し、秘書が判断する

エラーコードは次のとおり。

| コード | 意味 |
| --- | --- |
| `bad_args` | 引数の形が違う |
| `unknown_command` | 命令の種類が一覧にない |
| `not_found` | セッションやプロジェクトがない |
| `busy` | `max_sessions` に達した |
| `invalid_state` | 今の状態では実行できない（停止中のセッションへの送信など） |
| `stale` | 端末ダイアログが既に変わっている |
| `worker_offline` | ハブ側で判定。ワーカーが未接続 |
| `timeout` | ハブ側で判定。期限切れ |
| `internal` | そのほか |

### 2.4 生存確認

- ハブは 20 秒ごとに WebSocket の ping を送る。60 秒応答がなければ切断とみなす
- ハブはワーカーの切断を WebChat と秘書へ知らせる。再接続したら同様に知らせる

## 3. デーモン ⇄ ブリッジ

ブリッジは Claude Code が起動するチャネルサーバーで、同じ Mac のデーモン（秘書の場合はハブ）へ接続する。

```json
// ブリッジ → デーモン
{ "t": "hello", "token": "…", "session_key": "UUID", "claude_session_id": "UUID", "pid": 123 }
// デーモン → ブリッジ（MCP サーバーの開始に必要な情報）
{ "t": "setup", "server_name": "hannigan", "instructions": "…", "tools": [ { "name": "reply", "description": "…", "inputSchema": {…} } ] }
// デーモン → ブリッジ：Claude へ流し込む
{ "t": "deliver", "id": "d-…", "content": "…", "meta": { "kind": "task", "chat_id": "…" } }
{ "t": "verdict", "request_id": "abcde", "behavior": "allow" }
// ブリッジ → デーモン
{ "t": "delivered", "id": "d-…" }
{ "t": "tool_call", "id": "k-…", "name": "reply", "args": { … } }
{ "t": "tool_result", "id": "k-…", "ok": true, "text": "sent" }   // デーモン → ブリッジ
{ "t": "permission_request", "request_id": "abcde", "tool_name": "…", "description": "…", "input_preview": "…" }
```

- トークンはデーモンの `local-bridge-token`。ブリッジはファイルから読む
- `meta` のキーは英数字と `_` だけにする（ハイフンを含むキーは Claude Code が黙って捨てる）
- `delivered` は Claude Code への書き込みが終わった印で、Claude が処理した印ではない
- 再接続後の `hello` で、デーモンは同じセッションのブリッジとして扱い直す。未送の `deliver` があれば送る

## 4. WebChat ⇄ ハブ

認証は `Authorization: Bearer <webchat-token>`。SSE だけはブラウザの都合で `?token=` も受ける。トークンが違えば 401 を返して記録する。

| メソッドとパス | 中身 | 返り値 |
| --- | --- | --- |
| `GET /` | WebChat の画面 | HTML |
| `GET /api/events?since=<seq>` | 出来事の SSE。`since` より後を再生してから流し続ける | `text/event-stream` |
| `GET /api/state` | ワーカー、セッション、未回答の承認の一覧 | JSON |
| `POST /api/send` | `{conv_id, msg_id, text}` を秘書へ流し込む。`msg_id` が既出なら無視 | `{status}` |
| `POST /api/answer` | `{approval_id, choice}`。`choice` は `allow` / `deny` か端末ダイアログの選択肢の番号 | `{status}` |
| `POST /api/session/interrupt` | `{worker, session}`。秘書は `worker: "_secretary"` | `{status}` |
| `POST /api/session/stop` | 同上 | `{status}` |

### 4.1 承認の ID

承認の要求は複数のワーカーとセッションから来る。Claude Code の `request_id`（5 文字）は Claude Code の 1 プロセスの中でしか一意でない。
そこでハブが承認ごとに `approval_id`（`ap-` と乱数）を振り、`(worker, session, request_id)` か `(worker, session, prompt_id)` と対応づける。WebChat は `approval_id` だけを扱う。

### 4.2 ハブの出来事

ハブの出来事は `hub/events.jsonl` に通し番号つきで追記し、SSE で流す。WebChat は最後に受け取った番号を覚え、再接続時に `since` で続きから受け取る（検証 T07 と同じ方式）。

| 種類 | 中身 |
| --- | --- |
| `user_message` | `conv_id`, `msg_id`, `text` |
| `secretary_reply` | `conv_id`, `text`, `in_reply_to?` |
| `worker_report` | `worker`, `session`, `project`, `text`, `conv_id?` |
| `approval_open` | `approval_id`, `source`（`secretary` か worker と session）, `type`（`tool` / `terminal`）, `title`, `body`, `options` |
| `approval_closed` | `approval_id`, `result`, `by`（`webchat` / `terminal` / `auto` / `ended`） |
| `session_state` | `worker`, `session`, `project`, `state` |
| `worker_link` | `worker`, `connected` |
| `notice` | 起動、停止、エラーなど人に見せる短い知らせ |

## 5. 秘書へ流し込む形

ハブは秘書のブリッジへ次の 3 種類を流し込む。どちらも `<channel source="hannigan" …>` として秘書に届く。

| `meta.kind` | 本文 | そのほかの meta |
| --- | --- | --- |
| `user` | 利用者の発言 | `chat_id`, `message_id` |
| `worker_report` | 作業セッションの返信 | `worker`, `session`, `project`, `chat_id` |
| `worker_event` | セッションの異常（`exited`、`failed`）、ワーカーの切断 | `worker`, `session?`, `chat_id?` |

`chat_id` は秘書が `session_send` に渡したものをハブがセッションごとに覚えておき、報告に付ける。

## 6. 秘書のツール

秘書のブリッジが公開するツールは次のとおり。ハブが実行し、必要ならワーカーへ命令を送る。

| ツール | 引数 | 中身 |
| --- | --- | --- |
| `reply` | `chat_id`, `text`, `in_reply_to?` | WebChat へ返信する |
| `workers_status` | なし | ワーカーごとの接続状態、役割、プロジェクト、セッション |
| `session_create` | `worker`, `project`, `name?`, `chat_id?` | セッションを作る。起動の完了は `session_state` で分かる |
| `session_resume` | `worker`, `session` | 停止済みのセッションを再開する |
| `session_send` | `worker`, `session`, `text`, `chat_id?` | セッションに指示を送る |
| `session_stop` | `worker`, `session` | セッションを終える |
| `session_interrupt` | `worker`, `session` | 実行中の作業を Esc で止める |

`session_create` は起動を待たずに返る。秘書が直後に `session_send` を呼んでも、デーモンがブリッジの接続まで保持するので届く。
