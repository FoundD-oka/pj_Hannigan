# 03 ハブとワーカー間の通信

作成日: 2026-10-13
状態: 2026-10-16 Q1/A〜Q15/B を反映した未実装・未検証の改訂案。Q15/Bの共有フォルダ＋書込直列化を、Q14/Bの資源待機状態（CU・書込）と同じ未実装proto2案で定義する。
関連: [00 全体アーキテクチャ](00-architecture.md)、[01 設定スキーマ](01-config-schema.md)、[02 ワーカー常駐プログラム](02-worker-daemon.md)

この文書は 4 つの接続の形を決める。Q5/A で Discord を4番目の接続として追加し、Q6/B で **一つのハブが複数の会話別秘書セッションを管理する**方式を定義する。

| 接続 | 方向 | 形式 |
| --- | --- | --- |
| VPS ハブ ⇄ Mac ワーカー | Mac から VPS ハブへ接続 | 本番 WSS `/ws/worker`、JSON（2 章） |
| デーモン ⇄ ブリッジ | ブリッジから同じ Mac のデーモン、または同じ VPS のハブへ接続 | localhost WebSocket `/bridge`、JSON（3 章） |
| WebChat ⇄ VPS ハブ | ブラウザから VPS の公開窓口へ | HTTPS と SSE（VPS 内部は HTTP、4 章） |
| Discord ⇄ VPS Discord アダプター ⇄ ハブ | Discord Bot が受信し、VPS 内部からハブに渡す | Discord Bot の公式接続機構とハブ内部のメッセージ配送（4.4 章）。Mac ワーカーへの Discord 直接接続は行わない |

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

鍵の入手はペアリング（01 §6。2026-10-18 実装）: 作業 Mac が HTTP の `POST /pair` に `{ code, worker }` を送り、`{ ok, key, hub_url }` を受け取って `worker-key` と `worker.json` に書く。`/pair` は WebSocket ではなく通常の HTTP で、WebChat トークンを要らない代わりにコードを資格情報とする。鍵は応答本文にだけ載り、ハブの出来事・ログには出ない。

```json
// ワーカー → ハブ
{ "t": "hello", "proto": 2, "worker_id": "home", "key": "…", "version": "0.1.0",
  "next_seq": 42 }
// ハブ → ワーカー
{ "t": "welcome", "proto": 2, "hub_version": "0.1.0", "last_seq": 40 }
```

`last_seq` はハブが最後に受け取った出来事の番号。ワーカーは `last_seq` より後の出来事を outbox から送り直す。 **Q6/B の `request_id` 必須化と `work_item_updated` 追加に伴い通信 `proto=2` の未実装案へ更新する。** `proto=1` の古いワーカーは新しい通信仕様の依頼を処理できないため、バージョン不一致を明示して接続を拒否し、黙って処理を継続しない。

Phase 2〜3 の同一 Mac `ws://127.0.0.1` はローカル実地テストの構成に限る（LAN 内の 2 台目は SSH トンネルで同じ住所に転送する）。**本番トポロジーは VPS ハブ＋別 Mac ワーカー**であり、公開ドメインに TLS を設定して `wss://` を必須とする。平文の `ws://` は localhost 専用とし、外部からの接続を拒否する。SSH トンネルは保守・検証用の代替経路とする。

### 2.2 出来事（ワーカー → ハブ）

```json
{ "t": "event", "seq": 41, "ts": "2026-10-13T00:00:00Z", "event": { "kind": "session_report", "session": "UUID", "project": "notes", "role": "pm", "text": "…" } }
{ "t": "ack", "seq": 41 }   // ハブ → ワーカー
```

- `seq` はワーカーごとの通し番号で、1 から増える。outbox に書いてから送る
- ハブは `seq` が `last_seq` より大きければ処理して `last_seq` を進め、`last_seq` 以下なら処理せずに `ack` だけ返す（重複排除）
- 1 本の WebSocket の中では順序が保たれるので、番号が飛ぶのは outbox が上限を超えて古い出来事を捨てたときだけになる。ハブは飛びを警告として記録し、そのまま処理する。ワーカーは再接続のたびに `inventory` を送るので、セッションの一覧はそこで揃う
- ハブは `last_seq` をワーカーごとに `hub/workers.json` に保存する。ハブを再起動しても重複は起きない
- ワーカーは `ack` を受けた番号までを outbox から消す

出来事の種類は 02 の 5 章のとおり。

**在庫（`inventory` の `projects[]`、`list` の返り値）の `ProjectInfo`**: `{ id, description, pm_enabled, execution_policy, pm: { enabled, autostart, execution_policy, extra_instructions }, path? }`。`pm`（`projects[].pm` の全項目）と `path`（Mac 上の案件フォルダ。ホームの下は `~/…`）は設定画面（01 §25）のために 2026-10-16 に足した。**`path` は命令 `list` と `config_set` の返り値にだけ載せ、出来事 `inventory` には載せない**（ローカルの場所をハブの出来事記録に残さないため）。ハブも `path` を保持・記録せず、設定画面への応答にだけ使う。項目の追加だけで既存の項目の意味は変えないので、`proto=2` のままとする。古いワーカーや試験用のワーカーは新しい項目を省いてよく、ハブは省かれていても動く。

### 2.3 命令（ハブ → ワーカー）

```json
{ "t": "command", "id": "c-01HV…", "name": "pm_send", "args": { "project": "notes", "text": "…", "request_id": "req-01HV", "expires_at": "2026-10-16T12:00:00Z" } }
{ "t": "result", "id": "c-01HV…", "ok": true, "data": { "status": "delivered" } }
{ "t": "result", "id": "c-01HV…", "ok": false, "error": { "code": "not_found", "message": "…" } }
```

- 命令の種類は 02 の 4 章の固定の一覧だけ（`pm_ensure`／`pm_send`／`thread_direct_send` を追加）。ワーカーは一覧にない `name` を `unknown_command` で断る。秘書の `project_pm_send` はハブが `pm_send` に対応づける
- ハブは命令ごとに 30 秒の期限を持つ。期限内に `result` が来なければ秘書へ `timeout` を返す。ワーカーが後から実行しても、結果は出来事として届く
- ワーカーは直近 200 件の命令 ID と結果を覚え、同じ ID が再び届いたら実行せずに前の結果を返す（再送の重複排除）
- **Q12/Cで変更:** オフライン中の**作業指示** `pm_send`／WebChat起点 `thread_direct_send` のみ、ハブで期限付き永続保留する。設定無効・保留不可なら従来の `worker_offline` を返す。承認回答・停止・中断・端末操作などの時限コマンドは保留しない
- **Q6/B:** `pm_send.request_id`（ハブ発行）を必須とする。VPS は `request_id` と実行元の秘書会話セッションを永続的に紐づけ、ワーカーへは外部会話IDを送らない。PMの報告に同じ `request_id` を付与させ、`last_chat_id` や直近依頼で宛先を推測しない。
- `pm_send` は案件に対して冪等な PM 起動／再開を伴う。`result` の `pm_session` は対象 PM の UUID、`status` は `delivered` または `queued`。**配信成功は PM の作業完了を意味しない**。以降 PM が直接処理するか子に委任するかは PM の実行ポリシーで判断し、ハブは通常の依頼ごとに子作成を強制しない
- **設定画面（01 §25）:** `config_set` は `args={ projects: [{ id, path, description?, pm?: { enabled?, autostart?, execution_policy?, extra_instructions? } }] }` で `worker.json` の `projects` 全体を置き換える。返り値は `{ projects: ProjectInfo[], pm_restart_needed: string[] }`（`pm_restart_needed` は PM が動いているため PM 設定の反映が次の起動になる案件）。ワーカーは全項目を検証してから `worker.json` を原子的に書き換え、メモリ上の設定と書込権の対象一覧を差し替えて `inventory` を送る。オフライン保留の対象にはしない（`OFFLINE_QUEUEABLE` は `pm_send` と `thread_direct_send` だけのまま）。命令の追加だけなので `proto=2` のままとする
- **Q4/B・Q5/A:** `thread_direct_send` は WebChat の認証済み直接投稿専用で、Discord アダプターからは実行できない。`args={session,text,message_id}`。受信側で対象 `role`／所属 PM を再確認し、子への投稿なら PM 通知を対で永続化する。応答は `target_delivery` と `pm_notice_delivery` を別々に返す。`delivered` はチャネルへの書き込み完了で、Claude の指示処理・作業完了ではない
- 同じ `(worker,session,message_id)` の再送は **本文の再実行を伴わず**前の配送状態を返す。ハブの HTTP リトライと WSS 命令 ID の重複排除の両段で冪等化する。子指示と PM 通知は単一の永続ジャーナルに同時登録してから配送を開始する。PM 通知を登録できない場合は子への新規投稿を部分受理せずエラーにする

エラーコードは次のとおり。

| コード | 意味 |
| --- | --- |
| `bad_args` | 引数の形が違う |
| `unknown_command` | 命令の種類が一覧にない |
| `not_found` | セッションやプロジェクトがない |
| `busy` | `max_sessions` に達した |
| `invalid_state` | 今の状態では実行できない（停止中のセッションへの送信など） |
| `stale` | 端末ダイアログが既に変わっている |
| `worker_offline` | ハブ側で判定。ワーカーが未接続かつ期限付き保留が無効／不可 |
| `deadline_expired` | Q12/C の `expires_at` に達したため未配送指示を拒否 |
| `delivery_unknown` | ブリッジへの投入成否が確定せず、無条件再送を停止した状態 |
| `timeout` | ハブ側で判定。期限切れ |
| `pm_disabled` | 指定案件で案件 PM が無効 |
| `unauthorized` | WebChat で送信／閲覧権限がない |
| `orphan_task` | 子セッションに有効な案件 PM が関連付いていない |
| `queue_full` | 重要指示・通知を永続キューに受理できない |
| `resource_busy` | CUまたは競合作業領域が使用中。Macが永続受理済みなら `resource_wait` として継続し、永続受理不能なら明示エラー |
| `resource_unknown` | CU所有者や書込可能領域の隔離が不明で、安全側に実行を停止 |
| `forbidden_scope` | PM が他案件や別ワーカーの作業セッションを操作しようとした |
| `project_in_use` | `config_set` が、動いているセッション（PM または子）のある案件を削除するか、フォルダを変えようとした。動いているセッションを `message` に挙げる |
| `internal` | そのほか |

### 2.3.1 Q12/C：期限付き保留依頼を復帰後に配送する（VPS ⇄ Mac）

- **受付:** 認可済みの秘書 `project_pm_send` またはWebChat `POST /api/thread/send` が対象Macオフラインの場合、ハブはその場で `request_id`／`message_id` による重複チェックと永続化を実施し、`{status:"pending_offline",operation_id,expires_at}` を返す。キューの期限は**VPS受付時刻＋1,440分（24時間、Q13/C既定）**から算出し、再試行やハブ再起動で延長しない。設定の `ttl_minutes` を省略すれば1,440分を適用し、明示的な不正値は設定検証エラーとする。キュー機能自体はOSS初期設定では無効。
- **送信:** ワーカー再接続時は `hello`／`welcome` と `inventory` の同期後、状態を `dispatching` に遷移し、認可・案件所属・ターゲット・TTLを再検証して、既存 `command` の `pm_send`／`thread_direct_send` に `expires_at` を添えて送る。Macデーモン側もチャネル投入前に失効を検証する。期限を過ぎれば `deadline_expired` を返し流し込まない。
- **受領状態:** ハブには「VPSで保留」「Macデーモンで受理」「ブリッジへ書込み済み」「Claudeの作業中」「完了」を別々に記録する。`result.status=queued` はMac内部の橋渡し待機、`delivered` はチャネルへの送信を示し、Claudeが指示を実行済みとは意味しない。
- **冪等性:** WSSの `command.id` は通信試行ID、`pm_send.request_id` と `thread_direct_send.(worker,session,message_id)` は**実務上の指示ID**。ワーカーは後者の受理・配送状態を永続化して再接続後に照合する。送信・保存の境界で結果が不明な場合は `delivery_unknown` とし自動再送せず、管理画面で確認できるようにする。厳密なClaudeのExactly-once処理は保証しない。
- **認可と取消:** 配送前にDiscord投稿者／チャンネルとQ8・Q9・Q10の許可条件、WebChat利用者・対象セッション所有権、案件PM有効性を再検査する。現在の許可が失われた依頼は失敗として停止する。WebChatの取消APIは**未配送**の状態だけに適用する。取消・失効後に旧キューを復元しても配送しない。
- **失効通知:** 期限切れを `expired` イベントにし、元の秘書会話・WebChatスレッド・Discord返信元へ**許可状態を確認したうえで**通知する。Discord DMに代替送信せず、通知送信できなければWebChat監査履歴に残す。会話の違う返信先へ推測送信しない。
- **キュー対象の固定:** この仕組みは `pm_send`／`thread_direct_send` のみ。`approval_answer`／`terminal_answer`／`session_stop`／`session_interrupt` 等は保留しない。Q11/Aの追加着手承認なしと矛盾しない。
- **Q14/B:** 再接続後のVPS→Mac命令は受付順に送信し、Macの永続受理確認後に次へ進む。Macが `resource_wait` と返しても、その依頼は受理済みであり、非競合の後続を配送できる。未投入の `resource_wait` は `expires_at` の制約を受け続ける。

- **実装メモ（2026-10-16, Phase 3 WP1）:** `pm_send` の `result.status` は 2.3 の `delivered`／`queued` と 02 の 4 章の `delivered`／`worker_queued`／`resource_wait` が食い違うため、02 の値を採用した（`shared/protocol.ts` の `PmSendResult`）。失効のエラーコードは本書の `deadline_expired` を正とし、`expired` は状態名として残す。`thread_direct_send` の `target_role` は任意のヒントで、ワーカーは保存済みの所属で再確認する。

### 2.4 生存確認

- ハブは 20 秒ごとに WebSocket の ping を送る。60 秒応答がなければ切断とみなす
- ハブはワーカーの切断を WebChat と秘書へ知らせる。再接続したら同様に知らせる

## 3. デーモン ⇄ ブリッジ

ブリッジは Claude Code が起動するチャネルサーバーで、同じホストのデーモン（Mac ワーカー）またはハブ（VPS 秘書）へ接続する。

```json
// ブリッジ → デーモン
{ "t": "hello", "token": "…", "session_key": "UUID", "claude_session_id": "UUID", "pid": 123 }
// デーモン → ブリッジ（MCP サーバーの開始に必要な情報。role に応じてツールを変える）
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
- 案件 PM（`role=pm`）には `task_list` / `task_create` / `task_resume` / `task_send` / `task_interrupt` / `task_stop` / `reply` を提供し、作業セッション（`role=task`）には原則 `reply` のみ提供する。ブリッジは自己申告の `role` を送らず、デーモンが保存済みの `session_key → role, project` により認可する。**PM の小規模な直接作業はローカルの組み込みツールで実行し、この `task_*` プロトコルを通らない**
- 作業セッションの `reply` を担当 PM に配信するときは `deliver` の `meta.kind="task_report"`、`meta.project`、`meta.session`、`meta.pm_session`、親依頼があれば `meta.request_id` を設定する。PM が不在ならデーモンで保留し、PM 再開時に配信する。PM が直接処理した場合は子の `task_report` は発生せず、PM 自身がハブへ `reply` を送る
- **Q4/B 直接投稿:** PM／子に対する直接指示は `deliver.meta.kind="user_direct"`、`message_id`、`project` を使う。子への指示を担当 PM に知らせる通知は `deliver.meta.kind="user_direct_notice"`、`message_id`、`project`、`session`（対象子）、`pm_session`、`target_delivery` を使う。PM 通知は**通知であって再委任の要求ではない**ことを `content` に明記する
- `session_report` も `origin` と照合済みの `request_id`／`in_reply_to` に基づいて秘書由来の案件依頼かユーザーの直接介入かを区別する。直接返信は該当 PM／子スレッドに表示する。帰属を自動特定できない場合はスレッド表示だけを行い、誤ったトップレベル返信を発生させない。
- ブリッジの `delivered` は伝送確認であり、セッションの応答やツール実行を証明しない。ハブ／ワーカーは個々の配送状態を `direct_delivery_state` で追跡する

## 4. WebChat ⇄ ハブ

本番は HTTPS の公開窓口から VPS 上のハブへ接続する。現在の設計案は `Authorization: Bearer <webchat-token>`。SSE だけはブラウザの都合で `?token=` も受ける記載になっているが、**URL クエリに長期トークンを載せる方式はログ等への漏洩リスクがあるため、本番採用を未確定とする**。安全なブラウザ認証／SSE 接続方式の確定までは開発用の扱いとする。

| メソッドとパス | 中身 | 返り値 |
| --- | --- | --- |
| `GET /` | WebChat の画面 | HTML |
| `GET /api/events?since=<seq>` | 出来事の SSE。`since` より後を再生してから流し続ける | `text/event-stream` |
| `GET /api/state` | ワーカー、案件別 PM、作業セッションとその親子関係、未回答の承認の一覧 | JSON |
| `POST /api/send` | WebChat 認可済み利用者から `{conv_id, msg_id, text}` を受け取り、`conv_id` の所有権をサーバーで検証して**該当会話専用秘書セッション**へ送る。`msg_id` 重複は無視。Discord 側の入口には使わない |
| `GET /api/secretary/conversations` | 認可済み利用者のWebChat秘書会話一覧と状態を取得。他利用者の会話は出さない |
| `GET /api/secretary/history?conv_id=...` | 認可済み WebChat 会話のイベント履歴のみページング取得。別会話やDiscordは含めない |
| `GET /api/projects` | その利用者に閲覧権限がある案件の構造化概要・進捗・タスク一覧。会話ログは返さない | `{status}` |
| `GET /api/threads?worker=...&project=...` | 認可済み PM と子セッションの一覧、親子関係、履歴の観測状態（`available` / `partial` / `unavailable`） | JSON |
| `GET /api/thread/history?worker=...&session=...&after_seq=...&limit=...` | 指定スレッドの永続イベント履歴を順序付きで取得。SSE 再接続件数上限には依存しない | `{entries, next_seq?}` |
| `POST /api/thread/send` | `{worker, session, msg_id, text}`。利用者の明示投稿をその PM／子に直接送る。オンラインなら従来配送、MacオフラインならQ12/Cの期限付き保留。子なら復帰後のMac受理時にPM通知を必須とする | `{status, expires_at?, target_delivery?, pm_notice_delivery?, pm_session?}` |
| `GET /api/offline-requests` | 認可された利用者の未配送／失効／不明な作業依頼と期限・発行元・対象を一覧表示（他利用者の会話は除く） | `{requests}` |
| `POST /api/offline-requests/cancel` | `{operation_id}`。未配送の保留依頼だけを取消し。配送済みClaude作業の停止には使わない | `{status}` |
| `POST /api/answer` | `{approval_id, choice}`。`choice` は `allow` / `deny` か端末ダイアログの選択肢の番号 | `{status}` |
| `POST /api/session/interrupt` | `{worker, session}`。秘書は `worker: "_secretary"` | `{status}` |
| `POST /api/session/stop` | 同上 | `{status}` |

### 4.1 WebChat の直接介入と認可（Q4/B）

- `GET /api/threads` と `GET /api/thread/history` は**閲覧権限**、`POST /api/thread/send` は**投稿権限**を要求する。Mac がオフラインでもハブに保存済みのスレッド履歴は閲覧可能。Q12/Cの期限付き保留が有効で正しいTTLが設定されている場合のみ、新規の直接指示を `pending_offline` として受付する（配送成功とは表示しない）。認可済み利用者は WebChat の既存認証セッションから特定する。`worker`、`session`、`project`、`role`、`pm_session` をユーザー入力どおり信用せず、ハブの接続済み inventory と保存済みセッション所属を照合する。
- `POST /api/send` は従来どおり統括秘書宛て。`POST /api/thread/send` は**秘書に文章を再解釈させない直接送信**。利用者の `msg_id` をサーバーで適切なスコープに紐づけ、同じ投稿をリトライしても二重送信しない。対象Macがオフラインなら期限付き永続保留へ入れ、`pending_offline` と失効時刻を返す。**`delivered`／実行完了の成功扱いにしない。**キュー無効または受付不能なら `worker_offline`／`queue_full` 等で拒否する。
- 対象が `role=pm` の場合は PM に直接送る。**PM／子が返した返信は元セッションのスレッドに表示する。** 秘書起点の案件依頼に関連付く PM 報告だけを秘書のチャット回答経路へ流す。人間が PM に直接指示した返信は、通常 PM スレッド内で表示し、秘書チャットへ無条件に複製しない。`role=task` の場合は子と所属 PM の通知経路を連動させ、応答・SSE に `target_delivery` と `pm_notice_delivery` を独立して含める。PM 通知が遅延しているなら画面に「PM 通知待ち」と表示する。PM への通知本文には同じ `msg_id` と対象子を明示する。
- WebChat が送信する `text` には任意の CLI 制御コマンド実行権は付けない。承認・停止・中断はそれぞれ既存の明示的な API だけが処理する。Q4/C のターミナル操作 API は追加しない。
- 本番の利用者認証（トークン配布、Cookie、CSRF、ユーザーごとの権限設定など）は未決定。これが実装・検証されるまで、Web 公開された複数利用者向け環境の安全性を保証しない。

### 4.2 承認の ID

承認の要求は複数のワーカーとセッションから来る。Claude Code の `request_id`（5 文字）は Claude Code の 1 プロセスの中でしか一意でない。
そこでハブが承認ごとに `approval_id`（`ap-` と乱数）を振り、`(worker, session, request_id)` か `(worker, session, prompt_id)` と対応づける。WebChat は `approval_id` だけを扱う。

### 4.3 ハブの出来事

ハブの出来事は `hub/events.jsonl` に通し番号つきで追記する。SSE は**購読者の本人／会話コンテキスト／案件権限**で絞り込んだイベントだけ流す。WebChat は最後に受け取った番号を覚え、再接続時に `since` で続きから受け取る（検証 T07 と同じ方式）。**スレッド表示用の履歴は `hub/thread-events.jsonl` に正規化して保存し、ページング API で取得する。** `hub/events.jsonl` を正のイベント記録、`thread-events.jsonl` を再構築可能な読み取り用インデックスとし、イベント ID を対応づけて整合性を検査する。SSE の再生上限に依存しない。

| 種類 | 中身 |
| --- | --- |
| `user_message` | `context_id`, `conv_id?`, `msg_id`, `text`, `source`（`webchat` / `discord`）、サーバー側の `origin_route_id`（元会話の返信先照合に使用）、**`ingress_id?`**（Q9/A、認可済みDiscordの元投稿に紐づくハブ発行値） |
| `secretary_reply` | `context_id`, `conv_id?`, `text`, `in_reply_to?`, `source`（サーバー側で解決）、`origin_route_id`（元窓口を指す） |
| `worker_report` | `worker`, `session`, `project`, `role`（`pm` / `task`）, `pm_session?`, `text`, **`request_id?`**, `origin?`。PM と子の報告は常に各スレッドに記録。秘書への自動通知は秘書起点の PM 報告に限定 |
| `thread_entry` | `worker`, `project`, `session`, `role`, `pm_session?`, `entry_id`, `kind`（`user_direct` / `assistant_message` / `tool_summary` / `report` 等）, `source`, `text?`, `message_id?`, `origin?`, `ts`。重複を排除し、安全に表示できるものだけ永続化 |
| `direct_delivery_state` | `worker`, `project`, `session`, `message_id`, `target_delivery`, `pm_session?`, `pm_notice_delivery`, `reason?`。対象配送・PM 通知を独立に追跡 |
| `approval_open` | `approval_id`, `source`（`secretary` か worker と session）, `type`（`tool` / `terminal`）, `title`, `body`, `options` |
| `approval_closed` | `approval_id`, `result`, `by`（`webchat` / `terminal` / `auto` / `ended`） |
| `session_state` | `worker`, `session`, `project`, `role`, `pm_session?`, `state` |
| `offline_request_state` | `operation_id`, `request_id?`, `message_id?`, `worker`, `project`, `session?`, `state`（`pending_offline` / `dispatching` / `worker_queued` / `resource_wait` / `delivered` / `expired` / `cancelled` / `delivery_unknown` / `failed`）, `expires_at`, `reason?`（`cu_busy` / `workspace_busy` / `resource_unknown` 等）。Q14/Bの資源待ちを含み、元の文脈に限定して公開 |
| `resource_lease_state` | `worker`, `resource_id`, `session?`, `operation_id?`, `lease_epoch`, `state`, `reason?`, `verified_at?`, `incident_id?`, `recovery_status?`, `last_checked_at?`。Q16/Aの状態とQ17/Bの非破壊復旧・要確認通知。アクセス権に応じて表示 |
| `worker_link` | `worker`, `connected` |
| `work_item_created` | `worker`, `project`, `work_item_id`, `title`, `status`, `summary?`, `request_id?`, `ts`。案件 PM が新しく起票したタスク。重複登録を防止 |
| `work_item_updated` | `worker`, `project`, `work_item_id`, `title?`, `status?`, `summary?`, `assignee?`, `request_id?`, `ts`。案件 PM 所属の検証を通過した構造化の共有台帳更新 |
| `notice` | 起動、停止、エラーなど人に見せる短い知らせ |

### 4.4 Discord ⇄ ハブ（Q5/A：統括秘書の会話専用）

- **VPS 内部アダプター:** Discord Bot アダプターが Discord から受信したイベントを検証し、VPS ハブ内部のメッセージ受信関数へ渡す。**外部公開の `/api/thread/send` やワーカーコマンドを Discord 用に開放しない。** WebChat と同じ**会話ルーター**に到達するが、入力元の許可Discordサーバーチャンネル／スレッド専用の**異なる秘書ブリッジ／Claude Code UUID**を選ぶ。必ず `source=discord` を付与する。入力本文中の「自分は WebChat ユーザー」等の記述では送信元を変更しない。
- **認可:** `discord.allowed_user_ids` と受信先条件（**サーバー `guild_id` の存在・非DM種別・許可チャンネル**、Q8/Aのトリガー）をアダプターで評価する。Bot 投稿・未登録利用者・未許可の場所からのメッセージは Claude Code に届けない。**Q7/C:** 許可したサーバーチャンネルからの認可済み質問に限り、`discord.shared_ledger_visibility=all_allowed_channels` なら共有台帳の全案件を返す。投稿者の受信許可と、チャンネル閲覧者へ返信が公開されることは別の条件である。**Q10/AによりDMは受信段階で無条件拒否し、会話セッションを作らない。** **Q9/A:** `work_request_policy=allowed_users_via_secretary` を有効にした場合は、許可サーバーチャンネルの許可投稿者全員が統括秘書経由で登録済みPM有効案件へ仕事を依頼できる。追加実行者リスト／案件別委任ACLは不要。ただし実行前にハブ側で再認可する。Discord のユーザー ID と WebChat の利用者IDの同一人物対応づけは未決定であり、暗黙に同一視しない。
- **受信形式（内部概念）:** `{source:"discord", ingress_id, external_message_id, author_id, guild_id, channel_id, text, trigger_kind, referenced_bot_message_id?, origin_route_id}` をサーバーが正規化する。`trigger_kind` はアダプターが検証した `bot_mention` / `bot_reply` だけに設定し、ユーザー本文から推定しない。`origin_route_id` はハブが生成し、元の受信場所と返信先を参照する。Discord ID は外部IDとして文字列のまま扱い、Claude からの任意のチャンネル指定を認めない。
- **正規化:** **非DMかつサーバー `guild_id`／チャネル種別を検証し、認可とQ8/Aトリガーに合致した**投稿だけを `user_message` として永続記録し、既存の秘書ブリッジの `meta.kind=user` へ流す。不成立メッセージは会話コンテキストを作成せず、本文を保存しない。`(source, channel_id, external_message_id)` を冪等キーとし、Discord の再配信・再接続で同じ依頼を重複投入しない。受理、チャネル書き込み、秘書処理、外部返信完了は別の状態であり、書き込みだけで「処理完了」と表示しない。
- **返信:** 統括秘書の `reply(chat_id,text,in_reply_to?)` に対して、ハブは既存の対応表から同じ許可Discordサーバーチャンネル／スレッドの返信経路を特定し、**元の利用者投稿を参照するDiscord返信**として送信する。紐づけが曖昧・失効・権限喪失なら**外部へ送らず**エラー／保留として記録する。再送には送信済み外部 ID を記録して重複投稿を抑制する（Discord への exactly-once の保証は実機試験を要する）。返信先はハブの管理対象であり、モデルが自由文で指定した ID では決定しない。
- **通知・機能境界:** Discord へは秘書からの通常返信だけを返す。PM／子の作業ログ全件、承認ボタン、個別スレッドへの投稿・停止・設定操作を Bot には設けない。承認が必要なときは秘書が一般的な「WebChat で承認が必要」と案内するにとどめ、承認本文や機微な操作詳細は Discord に自動転送しない。
- **Q6/B・Q7/C・Q8/A・Q9/A 確定:** WebChat会話・許可Discordサーバーチャンネル／スレッドは物理的な秘書 Claude Code 対話セッションも分ける。共有できるのは構造化された案件台帳であり、明示的に許可したDiscordサーバーチャンネルでは**全案件**を参照可能にする。元会話の分離や他チャンネルの履歴隔離は維持する。送信元検証・秘書セッション別記録・データアクセス制御は実装／検証が必要。

### 4.4.1 Q8/A のサーバーチャンネル受信判定（許可投稿のみ）

**Discordのイベントオブジェクトで判定し、ユーザーが書いた文章で判定しない。** 次の順に行う。

1. `MESSAGE_CREATE` 相当の人間の新規投稿だけを対象とする。送信者が現行Bot自身・その他のBot・Webhookなら除外。編集イベントやシステムメッセージだけで新たに実行を開始しない。
2. `discord.enabled=true`、`allowed_user_ids` に投稿者ID、`allowed_channel_ids` に**その投稿が実際に属するチャンネル／スレッドID**が含まれることを検証。親チャンネルの許可を子スレッドへ黙って継承しない。DMはQ10/Aで全面不使用。`guild_id` なし／DM種別／種別不明は認可以前に拒否し、**Q8/A はサーバーチャンネル用の決定**とする。
3. `discord.channel_trigger=mention_or_bot_reply` の場合、以下のいずれかのみ `trigger_kind` を付けて受理する。a. 投稿メッセージの `mentions[].id` にBot本人のユーザーIDが含まれる（`bot_mention`）。b. 投稿がDiscordの**返信**メッセージで、`message_reference.message_id` が現在の同一チャンネルを参照し、`referenced_message.author.id` または必要に応じてDiscord APIで照会した投稿者IDがBot本人と一致する（`bot_reply`）。`referenced_message` が無い、削除済み、取得拒否、別人の投稿の場合は b を採用しない。
4. `mention_only` の場合は a のみ、`disabled` の場合は受理しない。本文の文字列による `@Bot名`、役職メンション、`@everyone`、返信先が他人のメッセージのみでは起動しない。ただし返信メッセージ自体が a を満たせば a で受理する。
5. 判定が成立し、本文取得可能・入力内容が空でないことを確かめた後、外部メッセージIDの冪等確認を行って `origin_route_id` を発行し、Q6/Bの当該チャンネル専用 `context_id` に**1回だけ**流し込む。トリガー不成立投稿は入力・共有台帳アクセス・長文ログ保存を開始しない。
6. 返信には元の利用者投稿IDをDiscordのメッセージ参照として指定し、送信したBotメッセージIDを永続化する。そのBot返信へさらに人間が返信した場合も、手順3-bを**改めて**満たしてから処理する。Discordへ返信する直前にも投稿者・受信チャンネル・公開可否を再確認する。

**実装／検証上の注意:** Discordの公式メッセージ仕様に `mentions`、`message_reference`、`referenced_message` がある。ただし参照先が返らない場合・削除された場合・メッセージ本文にアクセスできない場合があり得る。必要なGateway Intentsと読み取り権限、返信時のメッセージ参照を実機で検証し、取得できない情報を推測して配送しない。Q8/Aは**受信のきっかけ**を定義するだけで、実作業委任はQ9/Aに基づく `work_request_policy=allowed_users_via_secretary` の明示的な有効化が必要。

### 4.4.2 Q9/A の作業依頼・実行認可（Discord許可ユーザー全員）

**許可するのは「統括秘書を介した案件PMへの実作業依頼」だけ。** 実行権限をDM、全チャンネル、Botの自由操作へ拡張しない。

1. **サーバー発行の帰属情報:** Q8/Aの受信判定後、ハブが各Discord人間投稿に不透明な `ingress_id` を発行し、`{ingress_id, author_id, guild_id, channel_id, origin_route_id, context_id, external_message_id, trigger_kind, accepted_at}` を永続化する。メッセージ本文に書かれたID、Claudeが指定した `chat_id`、`context_id`、`author_id` は許可根拠に使わない。
2. **実行時の判定:** `project_pm_send` は、呼び出した秘書ブリッジの認証済みセッションUUIDと**ハブが追跡した実行中の `ingress_id`**を結び、① `discord.enabled` ②許可投稿者 ③許可チャンネル ④Q8/Aの受信判定済み ⑤ `work_request_policy=allowed_users_via_secretary` ⑥登録済みかつPM有効な `(worker,project)` をすべて検査する。案件単位・投稿者単位の追加委任ACLは設けない。実行前に許可が取り消されていたら拒否する。
3. **並行・継続作業の境界:** Discordチャンネル専用Claude Codeセッションは複数の人が共有するので、`context_id` だけでは実行者を証明しない。同一会話の人間投稿は必要に応じて直列化し、各ツール呼び出しを**現在の元依頼**へ確実に結びつける。PMの途中報告に続く追加委任は既存 `request_id` から発行元 `ingress_id` を復元する。割り込みや曖昧な複数入力で帰属を確定できない場合は `forbidden_origin` で拒否する。この帰属管理がChannels上で成立するか要実機検証。
4. **ツールと経路の境界:** Discord由来の `project_pm_send` は許可するが、秘書が代理で呼ぶ低レベル `session_create`、`session_resume`、`session_send`、`session_stop`、`session_interrupt`、`thread_direct_send`、`approval_answer`、`terminal_answer`、設定／ペアリング操作は拒否する。アダプターがそれらの外部APIへアクセスできないことに加え、**ハブのツール実行層での拒否**を必須とする。
5. **配送・監査:** 許可した委任だけにハブが `request_id` を発行し、元 `ingress_id` と紐づける。PMへは従来どおり `pm_send{project,text,request_id}` を送り、Discord ID・Bot認証情報はMacへ渡さない。監査には送信元ID／対象案件／認可結果／`ingress_id`／`request_id` を保存するが、自由な会話全文を監査項目へ重複保存しない。許可取り消し後は新しい配送を拒否する。すでに実行開始したタスクの停止はWebChatで実施する。
6. **承認・返答（Q11/Aを含む）:** PM／子が行う作業の許可モードとOS権限は従来どおりで、DiscordユーザーをMac側の承認者にはしない。**投稿・委任の認可を通過したらHannigan独自の着手承認は挟まない。** Claude Codeが実際に要求する既存ツール承認はWebChatだけが回答できる。Discordへ返すのは受付状態・進捗・結果の**公開可能な構造化要約**であり、PM／子の生ログやコード全文・秘密値を自動転載しない。受信元チャンネルへの投稿前にも許可状態を検査する。

### 4.4.3 Q10/A：Discord DMを全面不使用とする

1. Discordの個人DM／グループDMは、Botへのメンション、Botの発言への返信、許可ユーザーからの送信であっても**拒否**する。Discordイベントの `guild_id` が欠ける／チャネルがDM種別／種別不明の場合、ハブの正規化前に破棄する。
2. 拒否したDMについて `ingress_id`・`origin_route_id`・`context_id`・秘書Claude Codeセッション・`user_message`・`request_id` を**生成せず**、内容も長期保存しない。台帳の `project_status` と `project_pm_send` に到達させない。
3. Discord返信・再送処理は**保存済みの `guild_id`＋`channel_id` に紐づく許可サーバー宛てのみ**送信する。DMルート、返信元不明、削除済みの宛先への送信を拒否し、DMへの代替配送をしない。
4. hub設定v7案ではDM有効化オプションを持たない。v6案の `allow_dm=true` は明示エラーとして移行を停止し、旧DMの会話UUIDや保留送信を自動再開しない。既存会話の他チャンネルへの統合もしない。
5. 対象外イベントの最小限の診断情報だけを残し、DM本文・添付・秘密情報を監査に複製しない。Discord側でBotにDMが配送され得ることと、Hannigan側でDMを扱うことは区別する。

**受入試験:** 個人DM／グループDM（メンション・返信・進捗照会・作業指示）→入出力0件、案件台帳／ワーカー到達0件。再起動や保留再送を跨いでもDM返信0件。サーバーの許可チャンネルでQ7/C〜Q9/Aが回帰しない。
### 4.4.4 Q11/A：Discord作業依頼の着手承認を追加しない

1. **通常の委任フロー:** Q9/Aの `ingress_id`・投稿者／チャンネル・トリガー・`work_request_policy` の検証を通った `project_pm_send` は、対象 `(worker,project)` が登録済みかつPM有効なら、`request_id` 発行後**別途のWebChat着手承認なしに** `pm_send` へ送る。依頼本文の高影響性を基準にした新規ゲートは挟まない。
2. **禁止される追加機構:** Discord作業依頼を一律に保留する `pending_start_approval` 状態、高影響依頼だけを待機させる承認キュー、Hannigan独自のリスク別着手承認API、承認カードの自動発行を本版に追加しない。既存の `approval_open` はあくまでClaude Codeのツール権限／端末確認を仲介するイベントであり、作業着手の独立承認ではない。
3. **Claude Code既存承認は不変:** 作業MacのPM・子セッションが従来の権限設定で `permission_request` または `terminal_prompt` を出せば、既存のWebChat承認ルートへ送る。Discordへ `approval_answer`／`terminal_answer` を公開しない。すでにClaude Codeで許可済みの操作については新しい確認を挟まない。
4. **配送と完了を分離:** `project_pm_send` の受理・`pm_send` の `queued`／`delivered` は、実行着手や完了の証拠ではない。既存の `session_state`／`session_report`／`approval_open` で状態を追う。ワーカー切断、`busy`、`timeout`、既存承認待ちは従来どおりの結果を返し、無制限の即時完了を保証しない。
5. **境界・版:** 未許可メッセージ／DM／不明な `ingress_id`／無効な案件／実行ポリシー無効の依頼はQ9/A・Q10/Aの既存ガードで拒否。追加のメッセージ型や承認APIは不要なため、**Q11時点ではハブ設定v7案／ワーカー設定v2案／通信proto2案を維持**した。後続Q12/Cでハブ設定をv8案に改訂し、通信proto2案の期限・状態フィールドを拡張する。高影響操作の事前人間確認が必ず行われるとは表明しない。

**受入試験:** 正常なDiscord依頼で追加着手承認イベントが0件、Claude Codeが要求する既存ツール承認イベントは従来どおり発生してWebChatからだけ回答可能。既に自動許可されたツールでは追加承認なし。Discordによる直接セッション／承認操作は拒否。

### 4.5 Q5/A の Discord 用受入条件

1. 許可された Discord 利用者が統括秘書に仕事を頼むと、秘書が通常の `project_pm_send` を使って Mac の PM へ委任し、その報告を元 Discord 会話へ返せる。
2. Discord から `thread_direct_send`・`approval_answer`・`terminal_answer` 等の直接操作経路に到達できない。WebChat の個別セッション UI と承認機能は維持する。
3. 異なる許可DiscordサーバーチャンネルやWebChatが同時に投稿しても、別の場所へ返信を誤投稿しない。返信先不明時は安全に失敗する。
4. Discord イベントの再受信、Bot 接続断、秘書再起動、外部 API の送信失敗後に、状態が復元され、少なくとも重複投入や未配信が検知可能である。
5. Bot トークンが記録・WebChat UI・Mac ワーカー・モデルプロンプト・Discord 返信に漏れない。Discord の受信許可を無効化しても WebChat・Mac ワーカーが継続動作する。

### 4.6 統括秘書の会話コンテキストと共有台帳（Q6/B）

**会話の分離単位**

| 入口 | サーバー側のコンテキスト識別 | 秘書セッション |
| --- | --- | --- |
| WebChat | `source=webchat`, 認証利用者、サーバー生成 `conv_id` | 該当 WebChat 会話専用の UUID |
| Discord サーバーチャンネル | `source=discord`, `guild_id`, `channel_id`（スレッドは固有 `channel_id`） | 該当 Discord チャンネル専用の UUID |
| Discord DM（個人・グループ） | **受理しない（Q10/A）** | **UUIDを生成せず、再開もしない** |

- ハブの `secretary-contexts.json` は `context_id`（ハブ発行の不透明 ID）、`source`、入力元キー、Claude Code `session_uuid`、作業ディレクトリ、稼働状態を保存する。サーバーIDの見かけが同じでも異なるソースの会話は結合しない。別会話の UUID／履歴を推測して使うことを拒否する。
- ハブは秘書ブリッジの接続認証後、**ブリッジの実セッションUUID**に紐づくコンテキストを使って入力を配送する。`chat_id` だけで宛先を決めたり、Claudeが提案した `context_id` を信用したりしない。
- `project_pm_send` 実行時にハブが `request_id` を採番し、`{request_id, context_id, origin_route_id, ingress_id?, worker, project, pm_session?, work_item_id?, state}` を永続記録する。ワーカーへは外部ソースや Discord の ID を渡さず `request_id` だけ渡す。PMからの `session_report` にある `request_id` を照合し、発行元の秘書 UUID へ通知する。**別チャンネルの秘書に報告を一斉配布しない**。
- ブリッジ `deliver` には対象秘書セッションに限り `meta.kind=worker_report`, `meta.request_id`, `meta.worker`, `meta.project` を含める。PMの `reply` に `request_id` がない／不正なら元会話を推測しない。新着報告を `last_chat_id` に配送する旧方式は禁止する。
- `project_pm_send` から始まる実作業はハブが `request_id` に対応する `work_item_id` を作成し、PM への通知に付ける。人間の直接介入や PM が新しいサブタスクを起票した場合は、PM の `work_item_create` をワーカーで採番・永続化し、`work_item_created` イベントとしてハブへ送る。作成後の更新はワーカーの `work_item_updated` に限り、ハブが認証済み PM の `(worker, project)` と `work_item_id` を照合してから記録する。台帳には**構造化進捗・タスク概要のみ**を保持し、元のDiscord投稿やWebChat全文を自動コピーしない。秘書の `project_status` は**Q7/Cの許可Discordチャンネルでは全案件の台帳情報**を返すが、許可チャンネルID・許可投稿者ID・`shared_ledger_visibility` をハブで検証し、DM／未許可チャンネルには流さない。WebChat側の認可は従来どおり適用する。
- `GET /api/events` と `/api/secretary/history` は発行元 `context_id` とユーザー／チャンネルの認可でフィルターする。内部の `events.jsonl` に複数会話が保存されても、認証済み利用者へ全会話のイベントを一括配信しない。スコープ外のイベントは SSE の再接続リプレイでも閲覧不可とする。
- 同一会話への入力は順序保持し、複数会話は互いに独立して進行する。`secretary.contexts.max_active` を超えたときは当該会話をキューイングまたは `busy` にし、別の会話セッションで代行しない。起動中セッションが失われたときは同一 UUID の復帰を優先する。
- **Q7/C・Q9/A確定:** 許可したDiscordサーバーチャンネルでの **`can_read_project` は全案件**（案件別閲覧ACLなし）。`discord.shared_ledger_visibility=all_allowed_channels` を明示し、投稿者・チャンネルを検証する。**実作業の委任は別途** `discord.work_request_policy=allowed_users_via_secretary` を明示すると許可ユーザー全員に付与するが、`project_pm_send` のみとし、子・PMの直接操作や承認権限は付与しない。DMはQ10/Aで全面不使用とし、台帳参照・作業依頼・返信すべてを拒否する。

### 4.7 Q6/B の追加受入条件

1. WebChat会話A・会話B、許可DiscordサーバーチャンネルC・Dはそれぞれ独立したClaude Code UUID／トランスクリプトを持つ。Discord DM-Eはセッションを生成しない。同じ場所への再投稿では履歴を引き継ぐが、異なる場所の過去会話を自動参照しない。
2. 共有案件台帳で更新済みのタスク状態を、認可された別会話から `project_status` で取得できる。元の依頼文・個人的な相談・全ツールログは返らない。
3. WebChat会話AとDiscordチャンネルCが同じPMに同時依頼し、報告到着順が逆になっても `request_id` ごとに正しい秘書セッション／元の送信先へ返る。紐づかない報告はどこにも誤送信しない。
4. ハブ再起動、秘書再開、Discord接続断、PMオフライン、重複イベント、チャンネル権限変更後もコンテキストの隔離・台帳の一貫性・再送の冪等性を維持する。
5. 非許可ユーザーまたは非許可Discordチャンネルから機密案件の状態を尋ねても、共有台帳・SSE・APIで漏れない。WebChatの `conv_id` 差し替えでも他会話を読めない。
6. **未検証点:** Claude Code 複数対話セッションのVPS常駐負荷、セッションの順序制御、Channels の再開、ログとディレクトリの分離、ワーカーとの `request_id` 往復を実機で確認するまでは「完成」としない。

### 4.8 許可チャンネルの全案件台帳参照（Q7/C）

1. `project_status`／`workers_status` を処理するハブは、呼び出し元の**ブリッジUUID**から `context_id` を特定し、保存済みの受信ルートから Discord の `guild_id`／`channel_id` と認可済み `author_id` を検証する。本文中のチャンネルID、モデルが生成したIDや他コンテキストの情報では許可判定しない。
2. Discordの許可サーバーチャンネルかつ `shared_ledger_visibility=all_allowed_channels` なら、**共有台帳に登録されているすべての案件**を取得可能とする。`project` を指定した場合もプロジェクト別ACLは使わない。`none`、未許可チャンネル、未許可投稿者、DMでは台帳読取を拒否する。WebChatには既存の利用者認可を適用する。
3. 会話履歴・ソースコード・環境変数・秘密情報・PM／子の作業全文はこのAPIが保持する**構造化台帳の外**であり、全案件可視化を理由に追加取得させない。各Discordチャンネルの秘書の会話セッションはQ6/Bどおり分離する。
4. Discordへ返信する**直前にも**、元チャンネルの許可・公開モード・送信先有効性を再評価する。許可取り消しやチャンネル削除が起きた依頼を他チャンネル／DMへ振り替えない。表示される回答は当該Discordチャンネルを閲覧できる全員に公開されることを管理者へ明示する。
5. **読み取りと実行を分離する。** 全件閲覧設定だけでは `project_pm_send` を許可しない。Q9/Aの `work_request_policy=allowed_users_via_secretary` を明示したときだけ許可ユーザー全員のPM委任を認める。Discordの低レベル `session_*`・承認／停止操作は禁止（Q5/A）を維持する。
6. Botが許可チャンネルに参加しただけでは、`allowed_channel_ids` と `shared_ledger_visibility` が揃わない限り全案件を公開しない。親チャンネルの許可を別IDのスレッドへ暗黙継承しない。

**受入試験:** 許可チャンネルで案件A〜Zが全件取得できること／案件追加後も対象になること、未許可チャンネル・DM・投稿者では拒否されること、送信直前の許可取り消しで未送信になること、会話全文を取得できないこと、全件閲覧許可から危険なツール実行権が付与されないことを確認する。

### 4.9 Q12/C のAPI／通知受入条件

1. 受付時点のDiscord投稿が許可チャンネル・許可ユーザー・Bot呼出条件を満たし、MacがオフラインならVPSの `pending_offline` と期限を元投稿へ返信する。Mac復帰後もQ9の再認可を通す。途中でチャンネル許可が失われた場合は配送もDiscord通知も止める。
2. WebChatからの子への直接指示が保留された場合、未配送時に子の作業履歴を配送済みとして表示しない。Mac復帰後に対象子／PM所属を検証し、子指示とPM通知の原子的登録を行う。
3. 失効後の初回接続やブリッジ準備が期限に間に合わない場合、`expired` として通知し、対象Macへ新しい指示を送らない。Mac側の送信遅延でも `expires_at` が効く。
4. 再起動、通信切断、重複メッセージ、別の WSS `command.id` での再送では同一 `request_id`／`message_id` の二重実行を避ける。結果が不確かな場合は `delivery_unknown` として停止する。
5. `approval_answer`、停止・中断、端末選択は自動再送しない。Discordには直接スレッド操作や承認機能を増やさない。

- **実装メモ（2026-10-16, Phase 3 WP3 ハブ側）:** `GET /api/thread/history` は `before=<seq>`（古い方へのページ送り、新しいものが末尾）を主とし、`after_seq` も受ける。返り値は `{items, has_more, next_before, coverage}` で、`coverage` は `hannigan_only` / `transcript` / `partial` / `unavailable`。ワーカーのトランスクリプト・アダプターが出す `entry_kind=coverage` の `thread_entry`（本文が `transcript` / `partial` / `unavailable`）を優先し、それが無ければ `thread_entry.source` から判定する（2026-10-16 WP4 で修正。以前は `unavailable` の判定も `source=transcript` のため `transcript` と表示していた）。`/api/threads` の `available/partial/unavailable` はこの `coverage` で代替した。秘書の会話別対応表は `hub/contexts.json`、依頼の対応表は `hub/requests.json` に置いた（4.6 の `secretary-contexts.json` に相当）。`thread-events.jsonl` の読み取り用インデックスは作らず、`events.jsonl` を直接絞り込む。SSE の会話別フィルターは本番の利用者認証と同時に入れる（現状は単一トークンで全イベントを流し、画面側で会話ごとに表示を分ける）。オフライン保留の直接投稿は `direct_delivery_state.target_delivery` に `pending_offline` を入れて記録する。

## 5. 秘書へ流し込む形

ハブは**対象会話専用の**秘書ブリッジへ次の 3 種類を流し込む。いずれも `<channel source="hannigan" …>` として秘書に届く。

| `meta.kind` | 本文 | そのほかの meta |
| --- | --- | --- |
| `user` | WebChat または Discord から認可・正規化された利用者の発言 | `chat_id`, `message_id`, `source`, `origin_route_id`, `context_id`, **`ingress_id`**（Q9/Aのハブ発行・発行元追跡用。Claudeの自己申告は権限に使用しない） |
| `worker_report` | **案件 PM の**統括秘書宛て報告（`role=pm`） | `worker`, `session`, `project`, `role`, **`request_id`**（元コンテキスト照合済み） |
| `worker_event` | セッションの異常（`exited`、`failed`）、ワーカーの切断 | `worker`, `session?`, `chat_id?` |

Q6/B では、`chat_id` は外部会話の相関用途に残しても、**PM報告の配送先決定には使わない**。ハブが `project_pm_send` ごとに発行・保存した `request_id` から、元の秘書セッションUUIDと `context_id` を特定する。**Q5/A・Q6/B ではハブが `request_id` と保存済みの `context_id`／`origin_route_id` から受信元を特定し、WebChat と Discord の該当元窓口へ `reply` を配送する。モデルの任意文字列から Discord の返信先を決めない。** **PM の人間への直接返信**と**統括秘書への報告**の区別はこの紐づけで行い、帰属が曖昧な返信を勝手に秘書の発言として扱わない。`role=task` の報告はハブのイベント／表示用に保存しても、原則として秘書への直接通知はせず、まず同じ Mac の PM に渡す。**PM の直接処理も子への委任後の集約も、秘書へは同じ `role=pm` 報告経路で届く。**Q4/B では会話・進捗の観測イベントを追加するが、Claude Code 内部の全トークン・推論や全ツールログの完全再現までは保証しない。ネイティブ履歴の取得は対象版での検証事項で、欠損時は観測範囲を WebChat に明示する。

## 6. 秘書のツール

秘書のブリッジが公開するツールは次のとおり。ハブが実行し、必要ならワーカーへ命令を送る。

| ツール | 引数 | 中身 |
| --- | --- | --- |
| `reply` | `chat_id`, `text`, `in_reply_to?` | 呼び出し元のブリッジUUIDが記録済みの `context_id` と一致することを検証し、元の WebChat または Discord 会話だけへ返信する。未解決なら保留／エラー |
| `workers_status` | なし | WebChatでは既存の認可に従ったワーカー情報。Q7/Cの許可Discordチャンネルでは全案件に対応するワーカーの状態概要を取得できるが、セッションの生ログや秘密情報は返さない |
| `project_status` | `worker?`, `project?` | Q7/Cの許可Discordサーバーチャンネルでは全案件の共有台帳概要・タスクを参照可能。DM・未許可チャンネルでは拒否。WebChatは従来の認可に従う。他会話の履歴は取得不可 |
| `project_pm_send` | `worker`, `project`, `text`, `chat_id?` | 認証済み秘書セッションとハブが保持する発行元 `ingress_id`／`context_id` を検証。Q9/Aでは許可Discordユーザー全員が委任可能。`request_id` を発行し、オンラインなら `pm_send`、オフラインならQ12/Cの期限付き `pending_offline` を返す |
| `session_create` | `worker`, `project`, `name?`, `chat_id?` | セッションを作る。起動の完了は `session_state` で分かる |
| `session_resume` | `worker`, `session` | 停止済みのセッションを再開する |
| `session_send` | `worker`, `session`, `text`, `chat_id?` | セッションに指示を送る |
| `session_stop` | `worker`, `session` | セッションを終える |
| `session_interrupt` | `worker`, `session` | 実行中の作業を Esc で止める |

`session_create` は起動を待たずに返る。秘書が直後に `session_send` を呼んでも、デーモンがブリッジの接続まで保持するので届く。**通常の委任経路では `project_pm_send` を優先**する。案件 PM が子作業を作成・指示するローカル操作は 02 の 4.1 章に定義する。

## 7. Q1/A の配置・運用に関する確定事項と保留事項

**確定:** ブラウザからの HTTPS/SSE と Mac からの WSS は同じ VPS 上のハブで終端する。VPS 内のハブと秘書ブリッジは localhost 通信で接続する。Claude Code の対話セッションは VPS（秘書）と Mac（作業）でそれぞれ独立して持つ。

**Q2/B 確定:** 案件 PM の配置は担当 Mac。VPS 秘書 → Mac PM → 必要なときだけ同じ Mac の子作業セッションの経路を採用する。ハブとデーモン間の `pm_send`、Mac 内ブリッジの `task_*` ツール、イベントの `role`・`pm_session` によって区別する。

**Q3/B 確定:** 案件 PM は軽量な調査・小規模修正を自身で行い、長時間・並列・純正 CU を伴う作業は子へ委任する。両経路とも PM から VPS 秘書へ `session_report(role=pm)` で報告する。

**Q4/B 確定:** WebChat から PM／子セッションの一覧と履歴を閲覧でき、それぞれに直接投稿できる。子への直接投稿は所属 PM への通知と関連付け、配送状態を区別する。WebChat 直接投稿は秘書に経由させない。

**Q5/A 確定:** Discord は VPS 統括秘書の会話用アダプター。Discord 経由で個別スレッドへの直接投稿・履歴閲覧・承認・設定を行わない。統括秘書が既存の PM 委任経路を使う通常会話は許可する。

**Q6/B・Q10/A 確定:** WebChat会話単位と許可Discordサーバーチャンネル／スレッド単位で複数の秘書セッションを分離し、構造化案件台帳のみを認可付きで共有する。PM報告は発行元 `request_id` で逆引きして戻す。

**Q7/C 確定:** 管理者が許可したDiscordサーバーチャンネルから全案件の共有台帳を閲覧可能にする。会話全文は共有しない。

**Q8/A 確定:** Discordの許可サーバーチャンネルではBot本人への直接メンションまたはBot本人の投稿への検証済み返信にのみ反応する。通常投稿は秘書へ送らない。

**Q9/A 確定:** 許可ユーザー全員が許可サーバーチャンネルでQ8/Aのトリガーを満たすとき、秘書経由の `project_pm_send` を登録済みPM有効案件すべてに依頼可能。直接セッション操作・承認はWebChat限定で、Macの既存権限を変更しない。

**Q11/A 確定:** Q9/Aの認可済み実作業依頼は追加の着手承認を求めず案件PMへ配送。Claude Codeが要求する既存のツール承認だけをWebChatで扱い、すでに自動許可された操作は確認なしに進むことがある。

**保留:** 複数 Mac にまたがる同一案件、ネイティブ履歴アダプターの実測可否、WebChat の本番認証・CSRF 対策、Q16/Aの書込枠自動返却の強制制御・実機成立性、PM の CU 利用を技術的に制限できるか。

**追加の検収条件:** 異なるネットワークの Mac が TLS 接続とペアリング認証を経て VPS に接続できること。再接続・ハブ再起動後もコマンド重複を防ぎ、承認要求とイベント履歴の整合性を保てること。

## 8. Q2/B の追加受入条件（案件 PM 経路）

1. 初回の `project_pm_send(worker, project, text)` で担当 Mac の PM が一度だけ生成され、同時に二重起動しない。
2. PM が `task_create` → `task_send` を実行し、同じ案件の作業セッションが作成される。作業報告が Mac 内 PM に届き、PM の返信が VPS 秘書に到達する。
3. 別案件のセッション UUID を `task_send` に指定しても `forbidden_scope` が返る。PM を偽装したブリッジ要求も拒否される。
4. デーモン・ハブの再起動後も PM の UUID と子作業の所属が維持される。PM 不在時の子作業報告が欠落しない。
5. 監視 UI と人間の直接介入は Q4/B として本書 4 章・10 章に仕様化した。履歴アダプターの実装と実機試験が済むまで「詳細監視が完成した」とは判定しない。

## 9. Q3/B の追加受入条件（2 つの報告経路）

1. 単発の軽量調査では、`pm_send` → PM 自身の組み込みツール → PM `reply` → Hub → 統括秘書となり、子セッションや `task_report` を作らずに完結する。
2. 長時間の実装や純正 CU 操作では、`pm_send` → PM `task_create` / `task_send` → 子 `reply` → Mac PM への `task_report` → PM `reply` → 統括秘書となる。
3. 子が実行した作業の出力が PM を経ずに統括秘書へ「完了報告」として紛れ込まないこと。PM が直接実行した作業にも通常の承認と停止が有効なこと。
4. `session_state` と最終報告だけで完全なツール履歴が得られると誤認させない。人間の直接介入に必要な追加イベント・API は Q4/B として設計に加えた。

## 10. Q4/B の追加受入条件（直接スレッド閲覧・介入）

1. ブラウザから `GET /api/threads` で PM と子が識別できる。スレッドを切り替えても指示・返信・承認・状態が混ざらない。
2. `POST /api/thread/send` で PM に指示すると、その PM の Channels セッションに一度だけ届く。子へ指示すると、子への配送と所属 PM への通知を同一 `msg_id` で対応づける。PM が同じ指示を子へ重複再送しない。
3. 子への直接投稿直後、`target_delivery` と `pm_notice_delivery` が別状態として確認できる。子が先に応答した場合も、PM 未通知を隠さない。PM 停止／再開・Hub再起動・Mac再接続で通知が消えない。
4. 同一 `msg_id` のブラウザ再送・WS コマンド再送でも実際の指示が二重実行されない。他案件の `session` 指定や閲覧をサーバー側で拒否する。
5. Claude Code 対話セッションの途中の発言・作業内容が、どこまで安全かつ適時に抽出可能かを対象バージョンで検証する。少なくとも取得可能な会話本文が確認できず最終報告だけしか表示できない状態では、スレッド閲覧機能の受入を完了としない。欠損部分は明示する。
6. WebChat から tmux の生端末への入力機能を作らない。承認や停止／中断の既存機能は引き続き独立したボタン／APIで操作する。

## 11. Q8/A の追加受入条件（Discordトリガー）

1. `channel_trigger=mention_or_bot_reply` で、許可投稿者・許可チャンネルからのBot直接メンションが同じチャンネル秘書へ1度だけ配送され、元投稿に対する返信となる。
2. 同じチャンネルでBot自身の投稿へ返信した人間のメッセージはメンション無しでも処理。返信先が人間、取得不能、削除済み、別チャンネルの場合は返信判定で起動しない。
3. Botの表示名だけの通常発言、他人宛て返信、役職メンション、`@everyone`、Webhook／Bot自身／他Botの投稿は処理しない。無視メッセージの内容は秘書履歴・案件台帳へ保存しない。
4. `allowed_user_ids`、`allowed_channel_ids` のどちらかを満たさなければトリガー成立でも無視。Discordの別スレッドでは親許可を継承せず、意図しないチャンネルで会話セッションを作成しない。
5. Botへの返信の連鎖でも1チャンネル=1秘書コンテキストを守り、受信イベントの二重配信・再接続による同一メッセージの二重投入を防ぐ。出力先チャンネルと返信参照メッセージが正しいことを確認する。
6. 必要なイベント本文・返信参照・作者情報が取得できない場合は安全に受理しない。Gateway Intents・Discord Bot権限・API参照を実環境で検証する。
7. Q5/Aの個別PM／子への直接操作禁止、Q7/Cの全案件共有台帳の閲覧範囲、DM既定拒否を維持する。実作業依頼の認可はQ9/Aの追加規約に従う。

## 12. Q9/A の追加受入条件（許可ユーザー全員から案件PMへ委任）

1. 許可Discord投稿者・許可サーバーチャンネル／スレッド・Q8/Aトリガー・`work_request_policy=allowed_users_via_secretary` が揃うと、許可利用者全員が全登録PM有効案件に実作業依頼できる。ワーカーで `pm_send(request_id,project,text)` として一意に受け取る。
2. `work_request_policy=disabled`、未許可ユーザー／チャンネル、DM、無関係な会話への委任は拒否する。受信許可・台帳閲覧だけでは `project_pm_send` を自動的に許可しない。
3. 同じチャンネルで二人の許可ユーザーが同時投稿しても `ingress_id` と `request_id` は互いに取り違えられない。帰属を確定できないツール呼び出しは `forbidden_origin` で拒否し、直前の投稿者IDを推測しない。
4. Discord会話の秘書が低レベル `session_*`・直接スレッド投稿・承認・停止・設定に到達しようとしても、サーバー側で拒否する。`project_pm_send` は登録済み `(worker,project)` およびPM有効設定で検証し、任意パス指定を認めない。
5. 作業依頼を受け付けたあと利用者またはチャンネルが削除され、Macへ実行配送する前ならその配送を中止する。既に作業を開始した場合は自動的な取消・巻き戻しを宣言しない。
6. Mac側の permission relay／純正CU承認は従来どおりWebChatに出す。Discord Botに承認権限はない。Discord返信は共有可能な構造化要約に制限し、秘密値や実行ログ・ソース全文を自動公開しない。
7. 実装前の実機試験で、Channelsによる複数ユーザー入力、PM報告での再入、ツール呼び出し時の`ingress_id`復元、受信・ツール時の二重認可を確認する。ハブの設定はQ10/Aを反映した未実装v7案。ワーカーv2案・通信proto2案は据え置く。

## 13. Q10/A の追加受入条件（DMを使用しない）

1. Discord BotのDM・グループDM、`guild_id` 不明、チャネル種別不明の入力は、許可ユーザーID・メンション・Bot返信の有無を問わずClaude Codeへ渡らない。メッセージ本文は保存されず、秘書UUIDは発行されない。
2. DM由来の `project_status`・`project_pm_send`・返信API・返信待ちキューの実行は0件。旧設定や旧キューのDM宛てルートも送らず隔離する。
3. v6案以前の `allow_dm=true` は自動的なv7移行を拒否し、管理者に確認を求める。`allow_dm=false` と `context_scope=channel_or_dm` はv7移行で廃止してサーバーチャンネル専用へ移す。
4. Discordの許可サーバーチャンネル（明示許可スレッドを含む）ではQ8/Aメンション／Bot返信、Q7/C共有台帳参照、Q9/A秘書経由の案件PM委任が従来どおり機能する。WebChatやMacワーカーの権限設定は変更しない。
5. **本項は設計・受入基準であり実装を保証しない。** Discord Gatewayからの受信拒否、再送先ガード、旧キュー隔離を実環境と自動試験で検証する。

## 14. Q11/A の追加受入条件（着手ゲートなし・ツール承認のみ）

1. Q8/A・Q9/Aの認可済みDiscord入力に対し、`project_pm_send` が既存の `pm_send` を実行できる。通常作業・本番デプロイ・大量削除などの依頼でHannigan独自の着手承認キュー／WebChat承認カードを生成しない。
2. `permission_request` またはCUなどの `terminal_prompt` がClaude Code側から発生した場合は、従来の `approval_open`／WebChat回答を経由し、Discordの投稿者が承認操作できない。Claude Code側で許可済みの操作では、余分なHannigan承認が発生しない。
3. `work_request_policy=disabled`、許可ユーザー／チャンネル失効、未許可トリガー、DM、不明 `ingress_id`、登録外案件からは委任されない。Q11/Aを認可のスキップと解釈しない。
4. `pm_send` の `queued`／`delivered` と作業中／承認待ち／完了が取り違えられず、実際の `session_state`・報告で表示される。中断・停止は既存WebChat経路だけで行う。
5. Q11/Aだけを理由とした新しいワイヤーメッセージ・ハブ設定・ワーカー設定は不要。設定hub v7案／worker v2案／通信proto2案に変更がないことを確認する。

## 15. Q12/C の追加受入条件（Macオフライン時の期限付き保留）

1. **オフラインでの受付:** 認可済み秘書委任・WebChat直接指示の双方が、オフラインMacに対して `pending_offline` と有効期限付きで耐久保存される。重複送信でも依頼数は増えずTTLは延長されない。
2. **期限内の復帰:** Mac認証・inventory・元発行者と対象の再認可・PM／ブリッジ準備が期限内に成立すれば、保存依頼が追加着手承認なしで1回だけMacへ配信される。Claudeのツール承認は従来どおり発生し得る。
3. **期限切れ:** 復帰が間に合わない場合、またはMacでチャネル投入直前に期限切れを認めた場合は、指示を実行せず `expired` を1回だけ確定し元窓口へ通知する。Discord許可取消時に他チャンネルやDMへ通知しない。
4. **あいまいな受信結果:** ワーカーが受理後に通信断し、ブリッジへの投入成否が不明の場合は `delivery_unknown`。未実行だと決めつけて自動で二重投入しない。
5. **対象外の即時性:** 許可回答・停止・中断はオフラインキューへ入らず、新規依頼だけが期限付き保留の対象。権限未確定／削除済みの子スレッドへの指示は自動的に別セッションへ回さない。
6. **本番前試験（Q13/C追加）:** `ttl_minutes` 未指定時の1,440分適用、1,439分59秒後の期限内配送、1,440分ちょうど以降の拒否、再試行・再起動後の期限固定、期限内配送済み作業の継続を確認する。キュー永続化・許可取消・WebChat直接介入/PM通知・冪等性の試験も必要。Q12・Q13は設計のみで未実装である。


## 16. Q14/B：FIFO配送・並列受理・資源待機の通信仕様（未実装）

### 16.1 配送順と応答

- Q12/Cの `hub/offline-requests.jsonl` に保存済みの `accepted_at`、`operation_id` でワーカー単位に安定ソートする。ワーカー再接続時の `welcome`・`inventory` 同期後、`pm_send`／`thread_direct_send` を古い順に送る。新しいオンライン依頼は同じワーカーの既存保留を追い越さない。
- 直前の `command` についてワーカー側の**永続受理が確認できてから**次へ進む。`status=worker_queued`／`resource_wait` は受理成功を示すが、**ブリッジへの `deliver` 成功ではない**。`max_sessions`／リソース待ちの間も非競合の後続を受け取れる。FIFOは**ハブ→Mac受理順**でありClaudeへの流し込みや作業完了の順序を保証しない。
- `operation_id`／`request_id`／`message_id` による既存のQ12/C冪等化は維持する。再送で別IDを払い直したり、受付時刻や24時間期限を更新してはならない。

### 16.2 資源待ちと利用状況

- ワーカーから返す受理結果は少なくとも `{status:"worker_queued"|"resource_wait"|"delivered", operation_id, reason?:"cu_busy"|"workspace_busy"|"resource_unknown"}` を識別できるようにする。`worker_queued`／`resource_wait` はチャネル未投入として扱う。既存 `pm_send` の `queued` は移行時に `worker_queued` と表示上で対応させ、Claude投入済みと誤認させない。
- Macの資源待ち状態が変化した場合は、ワーカーの永続イベントから `operation_id`・`state`・`reason` をVPSへ送り、元のWebChat／Discord依頼に紐づけて表示する。受理成功に対する返信を**「作業着手済み」や「完了」**としない。
- CU所有セッションの解放確認が取れない場合、同じMacで別CU要求を実行しない。`resource_unknown` は失敗または安全な保留として記録し、推測によるロック解除はしない。異なる案件でも同一MacならCUは競合する。
- 作業領域が同一実体パスである／同一か不明な場合、書込可能な複数セッションを同時に許可しない。保留からの復帰に限らず、通常の `pm_send`、PMのローカル `task_send`、WebChat直接指示、既存セッションの書込も対象とする。Q15/Bで共有フォルダ＋単一ライターの直列化に確定した。新しいworktreeは作らない。本文の自然言語を排他の根拠にしない。

### 16.3 期限・保護範囲・受入試験

- `expires_at` の判定はVPS側の配送前、およびMac側の**チャネル投入直前**に継続する。Mac受理済みでも `resource_wait` 中に24時間の有効期限を超えたら `expired` として投入を抑止する。既にClaudeに投入済みの作業をTTLだけで中断しない。
- 資源排他は**作業実行に関する強制制御**であり、Q11/Aの独立した「着手承認ゲート」は作らない。Discordへの直接介入・承認権限も増やさない。
- **受入試験:** 再接続時の受理順、後続独立作業の並列化、CU同時実行の排除、同じ作業領域への複数書込拒否、資源待ち後の再開／再起動・TTL失効、UI通知・ `request_id` の帰属を確認する。純正CUのOS／Claude Codeレベルでの強制方法が検証できない間は、並列CUが可能という保証を出さない。

## 17. Q15/B：共有作業フォルダの単一ライター状態（未実装）

- **書込資源の識別:** Macが `projects[].path` を正規化し、同一または重複する実体作業領域を1つの排他資源として扱う。ハブが渡す案件名だけでロック範囲を決めない。案件PMと子は同じフォルダを使い、Hanniganは新しいworktreeを作らない。
- **受理応答:** 競合する指示をMacが永続受理した場合は従来の `{status:"resource_wait",reason:"workspace_busy",operation_id}` を返す。待機中はClaudeへの投入未了。追加で受入を区別する必要がある場合も既存 `command` / `result` / `event` を使い、独立したDiscord用APIや人間の着手承認を増設しない。
- **状態通知:** 資源の所有者・待機者・不明状態はMacの永続資源台帳を正とし、既存の `session_state`／作業待機イベントでハブへ通知する。WebChat表示用情報はアクセスを再認可し、単なる共有案件台帳の公開データとしてDiscordへ書込権情報を無条件転記しない。
- **解放と安全性:** PMと子の書込枠の所有変更は、前所有セッションの書込経路・子プロセス停止／読取専用化を確認した後に限る。Q16/Aにより作業完了と停止・旧所有者の書込不能化を検証できたら自動解放する。検証が不明な場合は引き続き自動解放を禁止。セッション停止・デーモン再起動・通信断だけでロック開放済みと決めつけない。
- **読取並列:** 共有領域での読取専用の並列実行は、全書込経路を技術的に遮断したセッションだけ許可する。制御できなければ同じ領域は保守的な直列化へ縮退。異なる案件が実体パスで重複するときも競合する。
- **24時間期限:** `resource_wait(workspace_busy)` が続き、ブリッジへの投入前に `expires_at` へ達した保留指示は従来どおり失効する。既にClaudeへ届いた指示を単にTTLで中断しない。

**受入:** PM→子→PMの編集引継ぎ、同一フォルダへの異セッションBash/Write試行拒否、symlink・包含パスの扱い、状態復元・ロック所有者不明時のfail-closed、共有フォルダへ作業成果が直ちに見えることを確認する。**設定 hub v8 / worker v2 / 通信 proto2 は維持。新しい実行制御は未検証。**

## 18. Q16/A：書込権自動返却のイベント契約（未実装）

- **責任主体:** 書込権の所有・解除を決定するのはMacワーカーデーモンのみ。VPSやDiscordのメッセージ内容、Claudeの `reply`、UIの `completed` 表示から推定解放しない。VPSは通知されたMacの資源状態を表示するだけで、危険な `force_release` コマンドを設けない。
- **所有ID:** `{resource_id, operation_id, session, lease_epoch}` を不変の関係として監査する。`resource_id` は正規化実体フォルダに対応するMac発行の不透明IDで、ローカル絶対パスをWebChat・Discordへ露出させない。`lease_epoch` は新しい所有権が成立するごとに単調増加させ、古い保留通知・再送を現所有権へ誤適用しない。
- **状態遷移:** 少なくとも `held → release_pending → released` と、安全性不明を表す `resource_unknown` をMacで耐久記録する。完了候補を検出しても旧所有者の書込停止と書込権剥奪が確認できない限り `release_pending` または `resource_unknown` に留める。確定 `released` 後だけ待機者を再判定する。
- **イベント:** 既存 `t=event` の内側に新しい `event.kind=resource_lease_state` を追加する。最低フィールドは `{resource_id, operation_id?, session?, lease_epoch, state, reason?, verified_at?}`。Mac側outbox永続追記→Hub ackで再送・重複排除し、WebChatの対象ワーカー／案件に属するスレッドと資源待機状態に反映する。既存 `t=command`／`result` の形式やproto2の外側のメッセージ種類は変更しない。
- **状態の誤表示防止:** `resource_wait(workspace_busy)` 中の他依頼に対し、`release_pending`・`resource_unknown` は「待機中」のまま表示する。`released` が来ても待機依頼を「作業開始済み」とは表示せず、Macの再割当・実際の `delivered` イベントを待つ。ロック解放通知をClaudeの業務完了報告として秘書へ誤配送しない。
- **既定TTL:** 資源待ちで未投入の指示の元 `expires_at` は変更しない。既に投入済みの操作には24時間経過だけで自動停止を行わない。
- **CUと安全性:** Q16/Aはファイル書込権だけの仕様。純正CUはQ14/Bの独立した所有・解放基準を維持。macOS実機で強制的な権限剥奪／バックグラウンド処理停止を証明できるまで、この遷移を実装済み・検証済みとして扱わない。

**追加受入試験:** 直接修正・子委任・PMレビュー修正における書込権の自動解放、同一会話の継続と再取得、既存ライターの書込不可、`release_pending` 停止・クラッシュ・再送時のfail-closed、WebChat表示の整合性、資源待ちの失効とCU占有の独立性を検証する。**設計確定のみ、実機未検証。**

## 19. Q17/B：異常時の資源再検証・WebChatへの要確認通知（未実装）

- **新規コマンドは設けない:** 安全な自動復旧判定はMacデーモン内部の責務。自動強制終了は行わない。ハブから `force_release`、`kill_session`、異常作業の `retry_execute` を自動発行する仕組みは追加しない。既存の人間による中断・停止APIの範囲は変更しない。Q18でWebChatの手動復旧範囲を確認する。
- **既存イベントの拡張:** 外側の `t=event`／`ack`、`proto=2` を維持し、`event.kind=resource_lease_state` に任意の `{incident_id, recovery_status, last_checked_at}` を加える。`recovery_status` は `checking`、`verified`、`manual_review_required`。`state` はQ16/Aの `held`／`release_pending`／`released`／`resource_unknown` を再利用する。`reason` には検査不能・所有者異常などの短い分類だけを置き、ローカルパス・PID一覧・秘密値・生ログはWebChatへ転送しない。
- **復旧成功:** デーモンが旧書込経路の制限と活動停止を確認し、現リースの `lease_epoch` と永続台帳に整合する証拠を記録した場合だけ `released` を報告する。継続所有を確認できた場合は `held` のまま `verified` とする。**VPSがイベントだけでロックを解放したり、所有者を変更しない。**
- **確認不能:** `resource_unknown + manual_review_required` を永続イベントとして送り、Hubは認証済みWebChat管理画面の対象ワーカー／案件・スレッドへ「書込権を保持して停止中／要確認」の未解決アラートを出す。SSE再接続・WebChat再読み込み時にはハブの永続イベント／状態から復元する。送信元Discordチャンネルへ異常の内部詳細を投稿しない。
- **重複排除:** 同じ `worker_id + resource_id + lease_epoch + incident_id` の再送は新たな別事故とみなさない。再検証は同じインシデントに紐づけて記録し、状態が実際に変化した場合に更新する。古い `lease_epoch` の遅延イベントは現行所有権に上書きしない。
- **失効の独立性:** `resource_wait` 中かつClaude未投入のQ13/C保留依頼は、再検証待ちでも元の24時間期限で `expired` に移る。再検証やMac再接続で `expires_at` を延ばさず、確認不能の依頼を自動再投入しない。

**追加受入試験:** 再起動・ブリッジ再接続・子プロセス残存などの異常を注入し、適切な `resource_lease_state` とWebChatアラートの耐久性、旧イベント・再送の冪等性、未確認状態からの誤解放防止、未投入TTL失効、Discord境界、既存CU排他を検証する。**メッセージ外枠／schema versionは変更しないが、proto2の追加フィールドは実装・検証が必要。**
