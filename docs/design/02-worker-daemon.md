# 02 ワーカー常駐プログラム

作成日: 2026-10-13
状態: 2026-10-16 Q1/A〜Q15/B 反映修正案。FIFO受理・CU排他と、Q15/Bの共有フォルダ＋書込可能セッションの直列化を必須要件として追加（worker v2未実装案、実機未検証）
関連: [00 全体アーキテクチャ](00-architecture.md)、[01 設定スキーマ](01-config-schema.md)、[03 ハブとワーカー間の通信](03-hub-worker-protocol.md)

## 1. 役割

ワーカー常駐プログラム（以下デーモン）は作業 Mac で動く Claude ではないプログラムで、次を受け持つ。**接続先のハブと統括秘書は VPS 上に置く（Q1/A 確定）**。Q7/C の全案件台帳参照、Q8/A のメンション／Bot返信トリガー、Q9/A の許可ユーザーによる実作業依頼、Q10/AのDM拒否、Q11/Aの追加着手承認を設けない判断は**VPSハブ側のみ**で行い、ワーカーにDiscord閲覧者情報や公開先・トリガーの決定を委ねない。

- ハブへ自分から接続し、命令を受け、出来事を返す。Discord 経由の一般的な仕事依頼も **VPS の統括秘書 → `pm_send`** として扱い、Mac 側へ Discord Bot を置かない
- tmux の中で案件 PM（`role=pm`）と作業（`role=task`）それぞれの Claude Code 対話セッションを起動・再開・停止する
- 案件 PM のローカル MCP ツール呼び出しを受け、**同一 Mac・同一案件の作業セッションだけ**を作成・操作する
- 案件 PM が軽量な作業を自分の組み込みツールで処理する経路を維持し、委任が必要な場合のみ子セッションを起動する
- **WebChat の認証済み直接介入だけ**を PM または子への**明示的な直接投稿**として受け付ける。子への投稿は所属 PM に一意な通知として届け、双方の配送状態を記録する。**Discord アダプターには `thread_direct_send` を許可しない**
- ネイティブの Claude Code 会話記録（対象版で取得方法を検証）およびブリッジ通知から、閲覧用のスレッド履歴イベントを生成する
- セッションごとのチャネル中継（後述のブリッジ）と localhost でつながり、指示の流し込みと結果の受け取りを行う
- tmux 画面を読み取り、端末にしか出ないダイアログを WebChat へ中継し、選ばれた選択肢のキーを送る

セッションの起動と画面操作は、VPS 側の秘書セッションでも共通部品（`shared/session-manager.ts`）を使う。ただし秘書は Linux VPS 上で動くため、Mac 向け CU や macOS 権限ダイアログは秘書に適用しない。部品の OS 依存処理は分離する。

## 2. 部品と接続

```text
VPS ハブ ◄──WSS /ws/worker（03 の形式）── Mac デーモン ──tmux──► 案件 PM Claude Code（案件ごと）
                                              │              └────► 作業 Claude Code × N
                                              ▲                        │ stdio（MCP）
                                              └── localhost /bridge ◄──┘ （セッションごとに 1 ブリッジ）
```

### 2.1 ブリッジ（チャネル中継）

ブリッジは Claude Code が子プロセスとして起動する小さなチャネルサーバーで、秘書と作業セッションで同じプログラム（`shared/bridge.ts`）を使う。

- 起動時にデーモン（秘書なら VPS ハブ）の localhost `/bridge` へ WebSocket で接続し、`hello` でセッションキーを名乗る
- デーモンから `instructions` と公開するツールの一覧を受け取ってから MCP サーバーを開始する。`role=pm` には担当案件内の `task_*` 制御ツール、`role=task` には `reply` を原則公開する。役割の識別・権限チェックはデーモン側で行う
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
- tmux 名: `<tmux.prefix>-<project>-<キーの先頭 8 文字>` を基本とする。記録上の `role` により PM／作業を区別し、tmux 名の表示だけに依存しない
- PM 所属キー: `(worker_id, project_id)`。担当 PM のセッション UUID は固定して保存し、停止後は同じ会話 ID を `--resume` する

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

`worker/sessions.json` に次を保存する。**Q6/B から作業依頼の返信先は `last_chat_id` で推定せず、別の依頼ジャーナルに `request_id` を記録する。**デーモンを再起動したら、記録と `tmux ls` を突き合わせて状態を戻す。ブリッジは自動で再接続してくるので、Claude Code 側は何もしなくてよい。

```json
{ "key": "UUID", "project": "notes", "name": "表示名", "tmux": "hn-notes-1a2b3c4d",
  "conversation_id": "UUID", "role": "task", "pm_session": "PM_UUID",
  "state": "ready", "created_at": "...", "updated_at": "..." }
```

### 3.4 案件 PM の一意性と復旧（新設）

- `pm_send(project, text)` は、案件 PM を **その案件につき 1 セッション**だけ特定し、未作成なら起動、停止済みなら再開、起動中ならブリッジ接続まで本文をキューに保持する。競合する同時要求で二重起動しない。
- `projects[].pm.autostart=false` が既定のため、ワーカーを起動しただけでは全案件の PM を起動しない。初回指示で起動し、既存セッションが継続していればそのまま使う。`max_sessions` は PM と作業を合算する。
- PM 自身も通常の状態遷移、承認中継、tmux 再接続の対象となる。デーモン再起動後は `sessions.json` の PM 所属キーと実在 tmux を突き合わせ、必要時のみ再開する。
- 同一案件の複数作業セッションは同時に存在できるが、**Q14/BのCU排他と編集領域の書込競合防止を必須とする**。Q3/BではPMの純正CUは既定運用で使わずGUI操作は子へ委任する。PMのCU呼び出しを技術的に抑止する方法は別途検証する。

### 3.5 案件 PM による直接作業と委任（Q3/B、設計追加）

PM は `projects[].pm.execution_policy` を受け取る。`hybrid` が既定で、PM の判断基準は次のとおり。

1. **PM が直接処理:** 短い調査、軽微で独立した修正、簡単な検証。`role=pm` の Claude Code が通常の組み込みツールを使うため、`task_create` は行わない。通常の Bash/Write 等の承認経路は変えない。
2. **子に委任:** 長時間・複雑・並列作業、純正 CU を使う GUI 操作。PM が `task_create` / `task_send` で子へ依頼し、子から `task_report` が戻る。PM は成果物とテスト結果を確認して報告する。
3. **途中で切り替え:** 直接処理中に規模が広がれば、PM が進捗と変更済みファイルを整理して子へ残作業を委任する。すでに開始した作業を二重実行しないよう、指示に現状と対象を明示する。
4. **編集の競合回避（Q14/Bで強化）:** PM と子を含む書込可能セッションが同じ実体作業領域を使う場合は、言葉による注意だけでなく技術的な排他が必須。Q15/Bで共有フォルダ＋単一ライター方式を確定した。強制が成立しないときは、同じフォルダの書込可能セッションを1つに限定する直列運用へ縮退する。ここで競合防止が実装済みとはみなさない。

PM 自身の `reply` は直接処理でも委任でも、**秘書起点の依頼には必ず `request_id` を付けて** `role=pm` として VPS へ送信する。子の `reply` はまず PM に届く。従来の `session_state` は実行セッションの状態だけを示し、**PM の思考・ツール実行過程を完全に可視化するものではない**。詳細監視のイベント設計は Q4/B として次節・5章に追加する。

### 3.6 WebChat 直接投稿と親 PM 通知（Q4/B、設計追加）

- WebChat はハブの `POST /api/thread/send` を呼び、ハブが本人のアクセス権、対象 `worker`／`session`、役割 `pm`／`task` を確かめて `thread_direct_send` コマンドを発行する。**秘書の再解釈を挟まない**。ワーカーは保存済み所属情報で宛先を再確認する。
- `role=pm` ならその PM に `meta.kind=user_direct` で投稿する。`role=task` なら先に子への投稿を永続キューに受理し、同じ `message_id` を関連付けて `meta.kind=user_direct_notice` の通知を所属 PM に永続キュー登録する。PM 通知には `project`、対象子の `session`、元の `message_id`、本文、子の配送状態を含める。**子投稿と PM 通知は単一のジャーナル記録として先に確定させる**。片方しか保存できない状態では成功を返さない。
- **PM 通知は新たな作業依頼ではない。** 「子には既に利用者の指示が届く予定。重複して `task_send` しない。既存の作業計画・矛盾・レビュー観点を必要に応じ更新する」と明記する。担当 PM が止まっていれば再開を試みる。再開できなくても通知は保留し、失われた扱いにしない。
- `thread_direct_send` の応答は子／PMへの各通知について `queued` または `delivered` を区別する。`delivered` はチャネルへの書込みであり、Claude による処理完了を意味しない。後から届いた結果は `direct_delivery_state` イベントで反映する。
- ハブとワーカー双方で `(worker, session, message_id)` により重複指示を排除する。通知にも元の `message_id` を引き継ぐ。**子への配送だけ成功、PM 通知だけ未配送**という状態を隠さない。Q12/CによりMacがオフラインならVPSが指示と期限を永続保留する（有効時）。Mac側へ配送する前に `expires_at` と対象子／親PM所属を再検証し、`thread_direct_send` を受け付けた段階で子指示とPM通知を一体ジャーナル登録する。**VPSの保留だけでMacへの配送成功とは扱わない。**
- 子に PM が関連付けられていない、送信対象が削除済み、対象案件が無効などの場合は直接送信を拒否する。ハブの認証済み利用者情報は端末セッションの任意のメタデータから推測しない。
- **返信の振り分け:** PM／子の `reply` は元のセッションの履歴に必ず記録する。秘書起点の案件依頼に対応する PM 報告（有効な `request_id` と関連付けられるもの）だけが**発行元の秘書会話セッション**へ自動配送される。PM への人間の直接指示に対する返信は PM スレッドに表示し、秘書チャットの回答として二重計上しない。対応関係が曖昧ならスレッドに残して要確認とする。子の `reply` はその子スレッドに表示するとともに親 PM に従来どおり送る。**Q5/A・Q6/B:** `request_id` に紐づく元窓口と会話コンテキストの判断、利用者向け返信の送信は、Mac ではなく VPS ハブが行う。

### 3.7 スレッド履歴の取得と記録（Q4/B、設計追加）

- Hannigan が観測できる情報（WebChat からの指示、`session_report`、承認・状態変化、配送結果）は `thread_entry` や既存イベントで必ず記録する。`role`、`project`、`session`、`pm_session`、`origin`、`message_id` を保持し、PM／子別に履歴を再構成できるようにする。
- Claude Code の**途中の発言、ツール呼出しの概要、進行中の経過**を表示するには、各 Mac でネイティブセッションのログを読み取るトランスクリプト・アダプターを追加する。`thread_observation.mode=transcript` が設計目標。ログ形式・配置・Channels 由来メッセージの記録有無・遅延は対象版で実測し、成立しない経路は代替手段と制約を設計し直す。
- 取得した情報は公開可能なメッセージ本文・ツール操作の要約に限定し、モデル内部推論、トークン、環境変数、秘密値、許可されないファイル内容、不要な大きなツール出力を送らない。デーモン側でレダクトしてから outbox に追加し、Hub 側でも表示前に検査する。これらのフィルター性能は要検証。
- ネイティブログと `reply` から同じ発言を観測した場合、`entry_id` または `(session, source_message_id)` で重複排除する。出所と取得範囲（`available` / `partial` / `unavailable`）を WebChat に示す。**思考過程そのものを提供することは要件に含めない。**
- 直接投稿の配送記録とユーザー操作の監査履歴は、単なる `tmux capture-pane` の文字列解析に依存しない。閲覧機能は読み取り専用であり、ユーザーのキー操作を tmux に送る API は新設しない。

## 4. 命令

ハブから届く命令は固定の種類だけを受け付ける。起動や停止に Claude の判断を挟まない。

| 命令 | 引数 | 動き | 返り値 |
| --- | --- | --- | --- |
| `list` | なし | プロジェクト、各案件 PM、作業セッションの一覧と所属 | `{projects, sessions}` |
| `pm_ensure` | `project` | 案件 PM が存在すれば返す。停止済みなら再開、未作成なら作成（案件 PM 有効時） | `{session}` |
| `pm_send` | `project`, `text`, **`request_id`**, `message_id?`, `expires_at?` | `pm_ensure` とチャネル投入前に期限を検証。永続受信台帳でID重複排除し、担当PMへ1回だけ通知する。Q14/Bの資源待機を適用する | `{pm_session, status: delivered \| worker_queued \| resource_wait}` |
| `session_create` | `project`, `name?`, `chat_id?` | 従来の低レベル作成処理。通常は `role=task` で起動し、PM とは別セッションにする | `{session}`（状態は `starting`） |
| `session_resume` | `session`（キー） | 停止済みのセッションを `--resume <会話 ID>` で同じフォルダに起動し直す | `{session}` |
| `session_send` | `session`, `text`, `chat_id?`, `message_id?` | ブリッジ経由で `<channel>` として流し込む。ブリッジ未接続なら接続まで待つ（最大 30 件まで保持） | `{status: delivered \| queued}` |
| `thread_direct_send` | `session`, `text`, `message_id`, `expires_at?` | 期限と宛先所属を検証。子なら所属PMに `user_direct_notice` を作成し、指示と通知を一体ジャーナル登録する | `{target_delivery, pm_notice_delivery, pm_session?}`（各値 `queued` / `delivered` / `not_applicable`） |
| `session_interrupt` | `session` | tmux へ Esc を送る | `{status: key_sent}` |
| `session_stop` | `session` | `/exit` を送り、10 秒で終わらなければ tmux を終了する。強制終了は同じ起動回のセッションにだけ行う（停止直後の再開は同じ tmux 名を使うため） | `{status}` |
| `approval_answer` | `session`, `request_id`, `behavior` | ブリッジ経由で判定を Claude Code へ書く | `{status}` |
| `terminal_answer` | `session`, `prompt_id`, `option` | 画面を読み直し、同じダイアログが出ていれば選択キーを送る | `{status}` |

`session_send`、`pm_send`、`thread_direct_send` の本文は tmux のキー入力ではなくチャネル通知で届けるので、端末コマンドとは解釈されない。`thread_direct_send` も Claude Code の文章指示であり、端末の `/clear` などのスラッシュコマンドを遠隔実行する機能ではない。

### 4.1 案件 PM 専用のローカルツール（新設）

`role=pm` のブリッジがデーモンに中継する**委任用の**ツール。VPS を往復せずに同じ Mac のセッションマネージャーを使う。Q3/B の PM はこれとは別に自身の組み込みツール（Read、Edit、Bash など）で小規模作業を直接実行できる。

| ツール | 引数 | デーモン側の処理 |
| --- | --- | --- |
| `task_list` | なし | 呼び出し元 PM と同じ `project_id` に属する作業セッションだけを列挙 |
| `task_create` | `name?` | 同じ案件フォルダで `role=task` の Claude Code 対話セッションを起動 |
| `task_resume` | `session` | 同じ案件の停止済み作業セッションを再開 |
| `task_send` | `session`, `text` | 同じ案件の作業セッションへチャネル通知 |
| `task_interrupt` | `session` | 同じ案件の作業セッションへ Esc |
| `task_stop` | `session` | 同じ案件の作業セッションを終了 |
| `reply` | `text`, `request_id?`, `in_reply_to?` | PM の報告・返信を `session_report` として VPS に送り、PM スレッドへ記録。秘書起点の報告は**元の `request_id` 必須**とし、VPS だけが元の会話へ通知 |
| `work_item_create` | `title`, `summary?` | 呼び出し元 PM の案件に新しい `work_item_id` を払い出し、`work_item_created` を永続化してハブへ送る |
| `work_item_update` | `work_item_id`, `title?`, `status?`, `summary?`, `assignee?` | 呼び出し元 PM の案件に存在する作業項目だけを更新するイベントを送る。会話全文を転送しない |

- **権限境界:** `session_key` を認証済みブリッジ接続から求め、`role` と所属 `project_id` をデーモン側で特定する。PM のツール引数からワーカー名や任意パスを指定させず、他案件の作業セッションは拒否する。
- **作業結果の帰属:** `role=task` の `reply` は同じ Mac の親 PM へ `meta.kind=task_report` で届ける。親依頼の `request_id` があればそのまま付与する。監査・画面表示に向けてハブへも `session_report(role=task, pm_session=...)` を送る。PM が不在ならローカルの再送キューで保留し、再開時に渡す（配送後の処理完了を意味するものではない）。
- **複数 PM と作業の衝突（Q15/B）:** PMと子は同じ実体フォルダを共有し、新しいworktreeは作らない。PM自身の編集も子の編集も、Macデーモンの単一ライター制御に従う。強制方法は未実装であり、PMの注意喚起だけでは編集競合を防げない。


## 5. 出来事（ハブへ送るもの）

| 出来事 | 中身 | 発生条件 |
| --- | --- | --- |
| `session_state` | `session`, `project`, `role`, `pm_session?`, `state`, `detail?` | PM／作業の状態の変化 |
| `session_report` | `session`, `project`, `role`, `pm_session?`, `text`, **`request_id?`**, `in_reply_to?`, `origin?` | PM または作業セッションの Claude が返信ツールを呼んだ。全て元のスレッドへ記録し、**秘書宛ては発行元を照合できた `request_id` の PM 報告に限定** |
| `work_item_created` | `project`, `pm_session`, `work_item_id`, `title`, `status`, `summary?`, `request_id?` | 認証済み PM が新規タスクを登録。ハブが検証・永続台帳へ反映 |
| `work_item_updated` | `project`, `pm_session`, `work_item_id`, `title?`, `status?`, `summary?`, `assignee?`, `request_id?` | 認証済み PM が構造化した案件進捗・タスク項目を更新。ハブが検証・永続台帳へ反映 |
| `thread_entry` | `session`, `project`, `role`, `pm_session?`, `entry_id`, `kind`, `source`, `text?`, `message_id?`, `ts` | ネイティブ会話記録／ブリッジ等から安全に抽出できたメッセージやツール要約 |
| `direct_delivery_state` | `session`, `project`, `message_id`, `target_delivery`, `pm_session?`, `pm_notice_delivery`, `reason?` | WebChat の直接指示・PM 通知それぞれの配送状態が変化した |
| `permission_request` | `session`, `request_id`, `tool_name`, `description`, `input_preview` | ブリッジ経由の承認要求 |
| `permission_closed` | `session`, `request_id`, `reason` | 判定済み、端末で回答済み、セッション終了 |
| `terminal_prompt` | `session`, `prompt_id`, `kind`, `title`, `body`, `options[]`, `cursor` | 端末ダイアログの出現 |
| `terminal_prompt_closed` | `session`, `prompt_id` | ダイアログが画面から消えた |
| `inventory` | `projects`, `sessions`（`role`、作業なら `pm_session` を含む） | 接続直後とプロジェクト設定の変更時。PM の帰属を復元できる |
| `resource_lease_state` | `resource_id`, `session?`, `operation_id?`, `lease_epoch`, `state`, `reason?`, `verified_at?` | Q16/Aの書込枠取得・安全確認・自動返却・資源不明の状態変化。`resource_id` は生のローカルパスを漏らさない不透明ID |

出来事は送る前に `worker/outbox.jsonl` に通し番号つきで追記し、ハブの受領確認（`ack`）まで消さない。再送と重複排除は 03 で定める。Q12/CのVPS保留指示については、受信デーモンも `worker/inbound-commands.jsonl` に `request_id`／`message_id` ごとの受理・配送結果を永続記録し、別のWSSコマンドIDで再送されても再実行しない。PM 通知や WebChat 直接指示は永続キューを使い、`outbox.max_events` 到達で古い重要指示を無言削除しない。受理できない場合は明示的なエラーにする。

- **実装メモ（2026-10-16, Phase 3 WP1）:** 出来事の判別子が `kind` のため、`thread_entry` の `kind` 項目は `entry_kind` と名付けた。親 PM の参照はセッション台帳・`SessionInfo` とも `pm_session` に統一した（`parent_session` は使わない）。

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
| ハブとの接続が切れた | 1 秒から 30 秒まで間隔を延ばして再接続する。セッションは止めない。出来事は outbox に溜める。Q12の未配送依頼はハブに保持され、認証・`inventory` 同期の後に期限と認可を照合して配送される |
| ブリッジとの接続が切れた | セッションの状態は画面で判定を続ける。ブリッジの再接続を待つ。直接指示・PM 通知は永続キューから再配送する |
| tmux が消えた | `exited` を送り、未回答の承認要求を `permission_closed` で閉じる |
| デーモンが再起動した | `sessions.json` と `tmux ls` を突き合わせる。tmux が残っていれば監視を再開し、無ければ `stopped` にする。直接指示・PM 通知の未配送キューを復元し、`message_id` で二重配送を避ける |
| Claude Code が 90 秒以内に入力欄を出さない | `failed` にして画面の末尾 20 行を `detail` に入れる |

## 8. 既知の制約

- `/clear` などのコマンドはチャネルから実行できない。チャネルで送った `/clear` は文章として Claude に届き、会話は消えない（T12）。必要なら端末操作の代行で送る（Phase 2 では提供しない）
- 端末で `/clear` を打つと会話 ID が変わる。ブリッジの `CLAUDE_CODE_SESSION_ID` は起動時の値のままなので、再開に使う会話 ID は `~/.claude/projects/<フォルダ>/` の最新ファイルで確かめる必要がある
- 画面の文言は Claude Code の版で変わりうる。検出の文字列は `shared/pane.ts` の 1 か所に集め、版を上げるたびに試験で確かめる
- 1 台の Mac で純正 CU を使えるセッションは同時に 1 つ。**Q14/Bで変更:** デーモンがCUの所有・待機を調整する設計とし、Claude Code任せにはしない。ただし外部から純正CUを確実に制限・解放確認できるかは要実機検証。成立しなければCUを必要とする作業は安全側に直列化／待機させる
- CU のアプリ承認は Channels にも Remote Control にも届かず、端末にだけ出る。承認はセッション単位で、新規作成と再開のたびに最初の CU 利用で 1 回要る（T10、T11）。WebChat へは 6 章の画面読み取りで中継する

## 9. Q1/A による追加確認（VPS 接続）

- `worker.json` の `hub_url` は本番で `wss://<VPSドメイン>/ws/worker` を指定し、Mac から接続を開始する。Mac の受信用ポートを公開しない。
- ワーカーデーモンは VPS 側の秘書 Claude Code のプロセスを操作しない。秘書の起動・再開・停止は VPS ハブが担当する。
- Mac 側の純正 CU はこれまでどおり Mac の Claude Code で実行する。VPS 上で GUI を遠隔代替操作する設計にはしない。
- **Q1 受入試験**: VPS から指示 → Mac で Claude Code を起動 → Channels でタスクを届ける → CU 承認を WebChat で行う → 返信を VPS に返す → 再起動後に復元する。
- **Q2/B 受入試験（追加）**: VPS 統括秘書 → Mac の案件 PM をオンデマンド起動 → PM が同じ案件で子作業を起動・指示 → 子作業の結果が PM に届く → PM が秘書へ報告 → WebChat に返答。重複 PM 作成防止、他案件アクセス拒否、作業中の再起動・切断、同時実行上限も検証。
- **Q3/B 受入試験（追加）**: 小規模な調査と編集は PM が自分で実行して子を作らずに報告。長時間の作業と純正 CU の操作は子へ委任して結果を集約。PM 作業の承認中継、作業途中の委任切替、同じファイルへの二重編集回避、CU 同時利用の制約も検査する。

## 10. Q4/B の追加受入試験（PM／子スレッドの直接操作）

1. WebChat の PM／子一覧と履歴 API が、別セッションへ混線せず、当該 Mac の永続的なメッセージ／報告／状態を表示できる。
2. PM への直接投稿はその PM に一度だけ届き、通常の `pm_send`（秘書からの案件依頼）と送信経路が区別される。
3. 子への直接投稿は子に一度だけ届き、元の本文・対象子・`message_id` が所属 PM に一度だけ通知される。PM が再委任して同じ指示を二重実行しないことを検証する。
4. PM 停止・接続断・再起動・通知キュー満杯・子だけ配送済みのケースで、WebChat に子配送と PM 通知の状態が別々に表示され、メッセージの消失／虚偽の完了表示がない。
5. ネイティブ会話の観測を含むスレッド閲覧を実機確認する。`reply` の最終文だけでは閲覧要件を満たしたことにしない。取得できない項目を UI 上で欠損と示し、内部推論や秘密情報を表示しない。
6. 直接投稿の認可はハブとワーカーの双方で、送信者・対象セッションの帰属を確認する。ターミナルキー操作の API は作らない。


## 11. Q5/A のワーカー側不変条件（Discord サブ窓口）

- Discord Bot トークン・Discord チャンネル ID の許可設定を Mac ワーカーへ配布しない。
- Discord の入力は VPS 秘書を経由した通常の `pm_send` としてのみ到達する。ワーカーデーモンは Discord の投稿者が PM／子への直接介入権限を持つとみなさない。
- 案件 PM から統括秘書への `session_report` には発行元の `request_id` を保持し、元の WebChat／Discord の秘書会話セッションと返信先の解決は VPS ハブに任せる。
- `thread_direct_send`、`approval_answer`、`terminal_answer` は Discord アダプターから呼び出せる権限・経路を提供しない。自然言語経由で統括秘書が `project_pm_send` を呼ぶ場合はQ9/AのVPS側認可を必須とし、低レベル `session_*` のDiscord代理操作はVPS側で拒否する。

## 12. Q6/B のワーカー追加要件（同一 PM への複数会話からの依頼）

- ワーカーは Discord／WebChat の会話分離を実装しない。秘書の会話ID、Discord許可チャンネル、ユーザー別の許可リストはすべて VPS で保持し、**Mac には不透明な `request_id` と作業内容だけ渡す**。これにより Mac が異なるチャンネルへ勝手に返信しない。
- `pm_send` に必須の `request_id`（ハブ発行）を付け、PM へ届ける `deliver.meta.request_id` にそのまま引き継ぐ。PM は案件タスクごとの `request_id` を保持し、報告用 `reply(request_id, text, …)` に含める。ひとつの PM セッションが複数依頼を処理しても**最後に受けた `chat_id` やセッション全体の最終返信先を使わない**。
- ワーカーの `worker/request-events.jsonl` に少なくとも `{request_id, project, pm_session, delivery_id, status}` を持たせ、永続キューとイベント送信で重複・再起動を処理する。本文の再配送と PM の再実行を防ぐため、`(project, request_id)` を冪等キーとして照合する。
- PM は共有案件台帳の新規タスクを起票するとき `work_item_create`、既存タスクを変更するとき `work_item_update` を使用する。デーモンは接続元の認証済み `role=pm` とプロジェクトを検証し、`work_item_created` または `{work_item_id, title?, status?, summary?, assignee?}` の構造化 `work_item_updated` イベントをハブへ中継する。**私的な会話の発言、作業ログ、生のプロンプトを自動転載しない**。ワーカー自身は台帳の公開先や Discord の閲覧権を判断しない。
- 子の `task_report` は従来通り PM に届き、同一の親依頼がある場合は `request_id` を引き継ぐ。子の報告が異なる会話の秘書へ直接届くことはない。
- `request_id` が欠落・不正の場合、`session_report` はハブ上で所属不明として保管され、WebChat／Discordの別会話へ**最新会話と推測して**配信しない。曖昧な場合はユーザーに帰属確認を求める。
- `worker.json` に新しい設定項目はなく **worker v2 案は維持**する。通信・ツールの実装とバージョン互換性の検証は必要である。

**追加受入試験:** WebChat会話AとDiscordチャンネルBから同じ PM に相反する順番で依頼し、`request_id` ごとに返信先が独立すること、ハブ・Mac再起動／重複配送後も二重実行せずに追跡できること、公開用の台帳に自由会話全文が紛れ込まないことを確かめる。

## 13. Q9/A のワーカー側不変条件（Discordからの実作業委任）

- Discordの許可投稿者全員に案件PMへの作業依頼を認める権限判定はVPSで完結させる。Macは**ハブの認証済み `pm_send` コマンド**を従来どおり扱うだけで、Discord利用者・チャンネルのIDや `work_request_policy` を受け取らない。
- `pm_send` が届いたら、従来どおり登録済み `(worker_id, project_id)` と `projects[].pm.enabled` を検証し、任意パス指定・他案件セッションへの直接送信は認めない。`request_id` により重複コマンドの再実行を防ぐ。
- **Q11/A:** Discord由来だからといってPM／子の `permission_mode`・`allowed_tools`・OSの承認状態を上書きせず、必要な既存のClaude Code承認はWebChat経由で処理する。Hannigan独自の高影響作業の着手承認は追加しない。低レベル `session_*` や `approval_answer` をDiscordアダプターへ公開しない。
- `role=pm` の最終報告には依頼元の `request_id` を保持し、ハブ側で元のDiscordチャンネルへ安全な要約を返す。ワーカーから Discord API に投稿したり、共有可否を独断で決めたりしない。

**追加受入試験:** 許可ユーザーのDiscord依頼が `pm_send` としてMacへ1回届き、PMが直接作業または子へ委任すること、非許可投稿のPMコマンドが生成されないこと、Mac側の実行権限が変化しないこと、同一 `request_id` の再送が二重実行にならないことを検証する。

## 14. Q10/A のワーカー側不変条件（Discord DM不使用）

- Discordの個人DM・グループDMはVPSのアダプターで拒否する。MacワーカーにはDMの受信イベント、DM専用セッション、DM由来の `pm_send` が到達しないことを要求する。
- 既存の `pm_send` は認証済みのVPSハブから受信した命令のみ受け付ける。ワーカーがDiscordイベントや `guild_id` に基づいて権限判断を行う実装は追加しない。
- `worker.json` は**v2案のまま**。ハブ設定v7案でのDM関連項目廃止はワーカーの設定移行を必要としない。

**追加受入試験:** DMで許可ユーザーが進捗確認・実作業依頼・Bot返信を行っても、MacへDM起点の `pm_send`・セッション作成・作業開始が1件も発生しない。許可サーバーチャンネルからのQ9/A依頼は従来どおり到達する。

## 15. Q11/A のワーカー側不変条件（新規の着手承認を設けない）

- Discord起点であることや依頼内容のリスク種別を、Macワーカー独自の新たな**着手前承認**の条件にしない。認証済みハブから届く `pm_send` は、案件・PM所属・セッション状態・重複配送等の従来の検査を通過したら通常フローでPMへ配送する。MacはDiscordの許可ユーザーID・チャンネルを知らない。
- PMと子はそれぞれ従来のClaude Code `permission_mode`・`allowed_tools`・macOS権限に従う。必要なツール承認は `permission_request` → VPSハブ → WebChat、必要なCUアプリ承認・フォルダ信頼確認などは既存の `terminal_prompt` → WebChat に中継する。
- 既にClaude Code側で許可済みの操作はWebChatの確認が発生せず実行され得る。ワーカーがDiscord依頼を理由に権限昇格・`bypassPermissions` 相当・自動承認回答を追加しない。独自の高影響操作判定AIも追加しない。
- `pm_send` の受理（`queued`／`delivered`）とClaude Codeの着手・承認待ち・実行完了は別の状態として扱う。Q12/CによりMacオフラインはVPSで `pending_offline` に保留できるが、Mac側の `max_sessions` や期限切れは依然として実行制約となる。
- **追加受入試験:** 通常作業と本番反映・大量削除等の高影響依頼が、追加の着手承認コマンドなしで既存の `pm_send` 経路を通ること。Claude Codeが既存ツール承認を求めたケースではWebChatでの回答まで停止し、事前許可済みツールでは追加承認が発生しないこと。Discordから承認回答や低レベルセッション操作ができないこと。

## 16. Q12/C のワーカー側要件（期限付きオフライン依頼の安全な受理）

- **VPSとの責任分離:** デーモンは自分がオフラインだった期間の依頼を勝手に復元しない。VPSで永続化・期限設定された `pm_send`／`thread_direct_send` を復帰後に受信するだけ。`request_id`／`message_id` と `expires_at` を引き継ぐ。
- **期限判定（Q13/C）:** `expires_at` はVPSが受付時に確定した**24時間（1,440分）の期限**（既定値）で、デーモンは受け取った絶対時刻をチャネル投入直前に確認する。`expires_at` ちょうど以降は `deadline_expired` で拒否し、Mac側で24時間を再計算したり再送時に延長したりしない。時計の大きなずれが検出されたら黙って実行せず、時計同期エラーとして通知する。PM／ブリッジが準備できるまでの待機も期限内だけ。
- **永続受理記録:** `worker/inbound-commands.jsonl` に `{operation_id, kind, target, expires_at, state, payload_hash, observed_at}` を追記し、再起動後にも再利用する。`pm_send` の `operation_id=request_id`、`thread_direct_send` は `(worker_id, session, message_id)` を安定キーとする。本文とハッシュが異なる同一キーは拒否。再送された同一依頼を新しい作業と解釈しない。
- **曖昧な結果:** `channel` に投入したかを確認できない状態でクラッシュした場合、デーモンは `delivery_unknown` を返して自動二重投入を止める。`delivered` はブリッジへの書き込み完了でありClaude Codeの処理完了ではない。厳密な外部副作用のExactly-onceは保証しない。
- **子への直接指示:** `thread_direct_send` を受理する段階で対象の `role=task`、所属PM UUID、案件を照合。元の子が消えていたら `not_found`／`orphan_task` を返す。子への指示と担当PMへの `user_direct_notice` は既存Q4/Bに従い**同一ジャーナルで原子的に受理**し、PMには再委任不要と明示する。
- **対象外:** `approval_answer`、`terminal_answer`、`session_interrupt`、`session_stop`、`task_interrupt`、`task_stop` 等を「Macオフラインだったから再開時にまとめて実行」とはしない。既存のWebChatリアルタイム制御を維持する。
- **受入試験（Q13/C追加）:** 受付から23時間59分59秒では期限内、24時間ちょうど以降は `deadline_expired`。再起動・再送・時計ずれがあっても受領済みの元 `expires_at` を変更しない。24時間より前にチャネルへ配送した作業は期限だけで中断しない。他に、セッション消失、ブリッジ起動遅延、子指示のPM通知を検証する。**設計追加のみで実装・実機検証はしていない。** Q14/Bでは資源待機中でも投入前の期限検査を継続する。


## 17. Q14/B：FIFO受理とCU／書込資源の排他（未実装）

1. **FIFO受理:** VPSは対象Macごとに `accepted_at` + `operation_id` の順に指示を送る。デーモンは受信順に、対象・期限・重複・権限境界を検証して `inbound-commands.jsonl` に永続受理し、応答する。先行受理の記録が確定する前に後続を受理したと見せない。`resource_wait` を返した依頼も「受理済み／Claudeには未投入」として区別する。
2. **非競合の並列実行:** 先行指示のClaude作業完了までは待たず、`max_sessions` 内で独立した案件・実体作業領域のセッションを並列に進める。シリアルにすべきなのは**VPS→Macの受理順**と**競合する資源への利用許可**であり、すべてのClaude処理を1件ずつに固定しない。
3. **CUリース:** Mac全体の一意なCU所有セッションをローカル永続状態に持ち、CUを必要とする仕事の開始前に予約する。別のCUセッションは `resource_wait(cu_busy)`。純正CUはセッション存続中の所有が残る可能性があるため、操作1回／タスク本文の終了で即解放しない。所有セッションの終了を確認し、必要なCU側の開放確認が取れてから次を進める。クラッシュ後の所有者不明は**利用可能と推測しない**。別経路からCUを起動できない制限が実証できるまでは、安全側に直列／待機へ縮退する。
4. **書込競合:** オフライン復帰指示に限らず、既に実行中のPM・子、オンラインの `pm_send`、WebChatの `thread_direct_send`、PM自身の `task_send` にも共通の資源排他を適用する。作業ディレクトリはMac上で `realpath` 等により正規化し、同じ領域を指す別設定やsymlinkを競合判定に含める。PM自身のEdit／Write／Bash、子セッションのEdit／Write／Bash等、書込み可能な経路すべてに適用する。Q15/Bで同じ領域の**書込可能セッションを常に最大1つ**と確定した。読取専用が技術的に保証できないセッションは書込可能として扱う。作業ディレクトリの外への書込を既存Claude権限が許し得るため、技術的な封じ込めを実証するまでは「別フォルダだから絶対安全」と断言しない。
5. **待機とTTL:** 資源が使用中なら投入前の待ち行列に残し `resource_wait` をVPSへ報告。既定24時間の期限を引き続き検証し、期限到来なら投入せず `deadline_expired` とする。既にチャネル投入した依頼は期限到来で自動中断しない。重複指示・待機状態・CU所有状態は再起動後に復元し、不明な場合は `delivery_unknown`／資源未確認待ちへ遷移する。
6. **強制力:** Claudeへの「編集しないで」「CUを待って」というプロンプトだけでは排他保証にならない。デーモンの起動制御、必要な権限・ツール・OS側の制約、隔離ワークスペースを組み合わせ、競合中の実行が物理的にできない状態を確認できて初めて並列書込やCU待ち解除を許す。強制力を実証できない経路は並列実行から除外する。

**追加受入試験:** FIFO受理と独立案件の並列実行、CUの所有競合・解放・再起動復旧、PM+子・子+子・シンボリックリンク同一領域の書込競合拒否、資源待ちの24時間失効、待機→配送状態のUI連携、権限を迂回するBash実行に対する隔離性能。Q14/Bは設計のみで、純正CUの外部排他や書込の強制が現時点で成立したという意味ではない。

## 18. Q15/B：共有作業フォルダと単一ライター実行制御（未実装）

1. **作業パス:** `role=pm` と同じ案件の `role=task` は `projects[].path` の共有フォルダを作業ディレクトリに使う。新しいworktree・子専用作業コピー・専用ブランチを自動作成しない。異なる `project_id` でも実体パス・親子関係・別名を正規化して重複資源を認識する。
2. **所有者と待機:** デーモンがワーカー内で共有作業領域の書込枠を一意に管理する。所有者は `worker_id, session_key, normalized_workspace, operation_id` で識別し、状態変化を `worker/resource-leases.json` 等の耐久記録に残す。取得できないセッションへの書込可能な指示は `resource_wait(workspace_busy)` とし、チャネルへ投入したと扱わない。既に動作するPMと子も例外にしない。
3. **全書込経路:** PM自身と子のEdit/Write/Bash、シェル・バックグラウンドプロセス・外部から起動した書込処理を対象に、所有者以外の書込を技術的に防止する。単純なファイルロック・自然言語指示・ `--allowedTools` の指定だけを完全な強制機構とみなさない。実証できない場合は同じ領域の書込可能セッションを1つだけ起動させる保守的な縮退運用とする。
4. **読取専用作業:** 同じフォルダの複数セッションでも、全書込経路をOS／ツール実行制御で塞げる場合だけ読み取り調査を並列実行してよい。読取専用化ができないセッションは書込可能として扱い、書込枠の所有者と同時実行させない。別フォルダへの書込が許可される構成は、重複資源判定を再確認する。
5. **PM→子の受け渡し:** PMが子を作成しても書込権は自動で複製されない。子が編集を始める前にPMの既存書込経路が安全に休止／読取専用化したことを確認し、書込枠の譲渡を行う。逆方向（子→PMのレビュー修正）でも同じ。Q16/Aにより作業完了＋書込停止と旧所有者の書込不能化を検証したら自動譲渡可能にする。不明な書込継続プロセスがあれば譲渡しない。
6. **クラッシュ・TTL:** 所有者が消失しただけで安全に書込枠が解放されたと推定しない。再起動時はセッション・プロセス・実体作業領域と永続記録を突合し、不確定なら `resource_unknown` にして停止する。オフライン受付後の指示は `expires_at` 前にClaudeへの投入が完了しなければ失効（既定24時間）。別途の作業着手承認ゲートは設けない。

**追加受入試験:** 共有フォルダでPMと子が同じ変更を確認できること、PM+子と子+子の同時書込拒否、`Bash` で別プロセス経由の書込みも拒否、リアルパス／別名／入れ子フォルダの競合判定、書込停止確認が取れないときはロックを譲渡しないこと、読取専用の非競合作業と別案件の並列実行、デーモン再起動時の安全な資源復旧。**本方式は設計確定のみであり、macOS実機の強制力は未検証。**

## 19. Q16/A：作業完了・停止確認後の書込権自動解放（未実装）

1. **作業単位の特定:** 各書込要求を安定した `operation_id`（VPS起点は `request_id`／`message_id`、PMのローカル `task_send` はMacが永続採番）に紐づける。所有記録は `{resource_id, normalized_workspace, session_key, operation_id, lease_epoch, lease_state, verified_at?}` の形式を持つ。再起動しても同じ操作を別の新規書込権として二重に扱わない。同一Claudeセッションへ作業指示が重なった場合、同時書込を許可せず作業単位の開始を直列化する。
2. **解放候補:** 当該作業の終了報告やClaudeが入力待ちに戻った状態を、解放可否の**調査開始信号**として扱う。`reply`、`ready`、モデルの「終わった」、処理時間の経過だけでは解放せず、未完了ツール呼び出し・Bash・バックグラウンドプロセス・外部ジョブ・同一操作に属する保留書込がないことを追跡する。
3. **解放の二段階:** 書込枠を `held → release_pending` に永続遷移させ、現所有者から新たな書込権を取り消す。旧所有セッションが存続する場合も、Edit/Write/Bash・派生プロセスを含む書込経路をOS／実行境界で確実に遮断する。実行中の書込処理が無く、書込不能化が成功した検証結果を永続化してから `released` に確定する。次の所有者を許可するのは**その後のみ**。
4. **古い所有者の排除:** `lease_epoch` 等の単調増加する所有世代とプロセス制御で、旧所有者が後から遅延書込・復帰書込できないようにする。**台帳の世代番号だけ**では任意Bashプロセスの書込を止められないため、OS／ツール側の強制力が必要。新しい依頼を受けた同じセッションは、再び書込権を取得するまでは書込不可。
5. **安全性不明・復旧:** プロセス監視不能、残存子プロセス不明、書込権取消失敗、デーモン／ホストのクラッシュで権限境界が不明な場合は `resource_unknown` にして新ライターを開始しない。ハブ断だけではロックを外さない。再起動後も所有台帳・プロセス・実体パス・権限境界を検証できて初めて安全に復旧する。Q17/Bにより安全な状態再検証を試し、未確認なら保持・WebChat通知とし、自動強制終了しない。具体的な手動復旧操作はQ18の判断事項。
6. **待機者の再検査:** `released` を確認してから次の競合待機者を選ぶ。その候補のキャンセル、認可、セッションの所属、元 `expires_at` を再確認し、未投入の指示が既定24時間に達していれば `expired` にして届けない。Q14/BのVPS→Mac FIFO受理順は維持するが、資源待機者間の取得優先順位は新たに規定しない。
7. **CU独立:** 書込リースの自動解放は同一Macの純正CUリースを解放しない。CU占有がセッション終了まで残り得るQ14/Bの制約を変更しない。追加のHannigan独自着手承認は作らない。
8. **実装成立の前提:** 長期継続するClaude CodeとBashの全書込経路を確実に遮断できるかは実機未検証。成立しなければ同じ作業領域の書込可能セッションを直列化し、必要なら安全にセッションを休止／終了して履歴から再開する縮退経路を別途検証する。**書込不能化が実証されない状態で `released` を通知しない。**

**受入試験:** PMが修正完了→自動解放→子が同じフォルダに編集→自動解放→PM再取得。各段階で会話IDを維持し、権限の無い旧所有者がBashやバックグラウンドジョブから書き込めないことを確認する。`reply`のみ／まだ実行中／遅延ジョブ／デーモンクラッシュ／プロセス消失による不明状態では誤解放せず `resource_unknown` または保持状態にする。資源状態と変更理由をVPSのWebChatへ同期する。**実装・実機検証は未完了。**

## 20. Q17/B：書込リース異常時の安全な自動再検証（未実装）

1. **トリガー:** 書込権を持つPM／子の予期せぬ終了・ハング疑い、tmux／ブリッジ喪失、`release_pending` 中のデーモン再起動、所有記録と実際の書込境界の不一致を検出したら、当該資源の新規ライター付与を保留し、自動再検証を開始する。検査実行を記録するが、この時点で**所有権を解放しない**。
2. **非破壊の検査:** `resource_id`、正規化パス、所有 `session_key`、`operation_id`、`lease_epoch`、保存された権限状態、tmux／Claude CodeのPID・子孫プロセス・バックグラウンドジョブ・ツール中の書込処理を再照合する。既存ブリッジへの再接続と情報更新は許可するが、問題のタスクを新規セッションへ自動再投入しない。
3. **安全を証明できた場合:** 旧所有者の全書込経路に対する新規書込禁止が**技術的に強制され**、進行中の書込が無いことを確認できた場合のみQ16/Aの `release_pending → released` を進める。継続実行中の所有者が健全で、安全に書込権保持を確認できた場合は `held` として管理を復元するだけで、他セッションへ所有権を渡さない。どちらも再検証結果・世代を永続記録する。
4. **確認不能の場合:** プロセス一覧を取り切れない、子プロセスが残る、書込権剥奪の強制が不明、元の所有世代が照合できない、tmux画面だけでしか判断できない場合は `resource_unknown` に留める。新しいライターは `resource_wait(reason=resource_unknown)`。**自動 `Esc`、`/exit`、kill、tmuxセッション破棄、Mac再起動、強制解放、ロック台帳削除は行わない**。一定時間無応答・プロセス名が見つからないだけで安全と判定しない。
5. **状態の耐久性と通知:** `worker/resource-leases.json` 等に `{resource_id,session_key,operation_id,lease_epoch,incident_id,last_checked_at,recovery_status,reason}` を残し、既存の `resource_lease_state` をoutbox経由でVPSへ送る。`recovery_status` は `checking`／`verified`／`manual_review_required` を想定。理由は機密を除いたカテゴリ（例: `owner_hung`、`writer_unverified`、`lease_mismatch`）に限定する。同じ `incident_id + lease_epoch` の通知は重複排除できるようにする。
6. **異常状態の継続:** 資源の異常が未解消でも、非競合の別案件・作業フォルダはQ14/Bの範囲で続行可能。待機している未投入の依頼はQ13/Cの元の24時間期限を継続検査し、期限到来で `expired` にする。届いたか不明な過去の指示はQ12/Cの `delivery_unknown` を維持して自動二重配送しない。
7. **手動復旧の境界:** Q17/Bは「検証可能なら自動で管理状態を復旧する」までの決定。自動強制終了や、手動でも検証なしに解放してよいという許可は含まない。WebChatからの診断・人間の停止指示をどこまで提供するかはQ18で決める。純正CUの占有状態には別基準が必要。

- **実装メモ（2026-10-16, Phase 3 WP2）:** 書込枠は `worker/lease.ts`（台帳 `worker/resource-leases.json`、フック用の写し `worker/leases/<resource_id>.json`）と `worker/lease-guard.ts`（`--settings` で注入する PreToolUse／PostToolUse フック）で実装した。`resource_id` は正規化した実体パスの sha256。付与は配送の直前に行い、所有者が `ready` に戻って 1.5 秒続いたら `release_pending` にする。実行中ツール・新しい子孫プロセス・`lsof +D` の書込中ファイルが無ければ `released`、60 秒確認できなければ `resource_unknown`（`manual_review_required`）とする。`resource_unknown` は 10 秒ごとに再検証し、所有者の記録が残っていて検証が通れば `released` に戻す。所有者不明と写しの破損は再検証しない。待機者はデーモンの配送キュー `worker/deliveries.jsonl` が持ち、再起動後も残る。対象はワーカーの全セッションで、PM を持たない Phase 2 の子も低レベル `session_send` が配送キューと書込枠を通す（PM と PM の子への `session_send` は `invalid_state`、2026-10-16 WP5）。フックは書込先を実パスにして全案件フォルダ（`worker/workspaces.json`）と照らし、別案件のフォルダへの書込にはそのフォルダの書込枠を求める。入れ子・同一フォルダの案件は設定読込時に拒否する。CU の排他（`cu_busy`）は未実装。

**追加受入試験:** クラッシュ時に書込主体が完全に消え権限制御が証明できる場合のみ安全解放、子プロセス残存時の非解放、tmuxハング中の所有保持、再起動時の世代整合性、長時間タイムアウトだけで強制終了しないこと、同一リソースへの重複ライター拒否、24時間失効、`incident_id` 単位のWebChat通知の重複排除と再接続後の未解決表示を検証する。**実装・macOS実機での強制検証は未完了。**
