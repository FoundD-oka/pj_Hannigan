# 01 設定スキーマ

作成日: 2026-10-13
状態: 2026-10-16 Q1/A〜Q15/B 反映。2026-10-16 設定画面（最小、25 章）を追加。Q15/Bで共有作業フォルダ＋単一ライター方式を確定。hub v8・worker v2未実装案を維持し、強制制御・資源追跡を追加設計する。
関連: [00 全体アーキテクチャ](00-architecture.md)、[02 ワーカー常駐プログラム](02-worker-daemon.md)、[03 ハブとワーカー間の通信](03-hub-worker-protocol.md)

## 1. 方針

- 設定ファイルを唯一の正とする。設定画面（Phase 5。最小限を Phase 3 で前倒し、25 章）はこのファイルを読み書きする道具で、ファイルを直接編集しても同じように動く
- 利用者ごとに変わる値（ポート、フォルダ、ワーカー名、役割の説明、承認方針）はすべて設定ファイルに置く。コードには「設定が省略されたときの既定値」だけを置き、既定値はこの文書の表に載せる
- 秘密情報は設定ファイルに書かない。`secrets/` フォルダ（権限 700）の中に 1 値 1 ファイル（権限 600）で置く
- 読み込み時に zod で検証し、不正な値があれば起動を止めて項目名を表示する。未知の項目は警告だけ出して無視する（新しい版の設定を古い版で読んでも止まらないため）
- 各ファイルに `version` を持たせ、形を変えるときは版を上げて移行処理を書く

## 2. 保存場所

設定の根フォルダは環境変数 `HANNIGAN_HOME` で決める。省略時は `~/.hannigan`。**VPS と各 Mac で独立した設定フォルダを持つ**。

```text
$HANNIGAN_HOME/
├── hub.json                ハブの設定（VPS のみ）
├── worker.json             ワーカーの設定（各作業 Mac のみ）
├── secrets/                権限 700
│   ├── webchat-token       WebChat のアクセス用トークン（ハブ）
│   ├── discord-bot-token   Discord Bot トークン（VPS、Q5/A、Discord 有効時のみ）
│   ├── local-bridge-token  同一ホスト内でブリッジとハブ／デーモンをつなぐトークン（VPS と各 Mac で別の値）
│   ├── worker-keys.json    ハブが受け入れるワーカーの鍵 { "<worker_id>": "<key>" }（ハブ）
│   └── worker-key          自分の鍵（ワーカー）
├── hub/                    ハブの実行時状態（events.jsonl、thread-events.jsonl、discord-routes.jsonl、discord-outbox.jsonl、secretary-contexts.json、request-routes.jsonl、offline-requests.jsonl）
│   ├── work-items.jsonl     認可付き共有案件台帳の更新イベント（会話全文を保存しない）
│   └── work-items-index.json   上記から再構築可能な表示インデックス
├── worker/                 ワーカーの実行時状態（sessions.json、outbox.jsonl、bridge-*.json）
└── secretary/              秘書セッションのルート（VPS）
    └── contexts/            会話ごとに独立したディレクトリ／Claude Code 履歴
```

本番では VPS に `hub.json`、各 Mac に `worker.json` を置く。従来の「同じ Mac にハブとワーカーを置く」構成は単体テスト専用とし、本番の既定構成にはしない。
`local-bridge-token` はハブ用を `secrets/local-bridge-token.hub`、ワーカー用を `secrets/local-bridge-token.worker` として分ける。

## 3. hub.json

| 項目 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `version` | `8` | 必須 | Q12/C のVPS期限付きオフライン依頼キューを追加した**未実装hub v8案**。v7案から設定移行する |
| `listen.host` | string | `127.0.0.1` | VPS 内部で HTTP/WebSocket を受ける住所。公開アクセスは HTTPS/WSS リバースプロキシ経由を原則とする |
| `listen.port` | int | `8800` | 同上のポート |
| `public_url` | string \| null | `null` | 本番は `https://<公開ドメイン>` を設定。`null` のローカル推定 URL は開発用に限る |
| `secretary.project_dir` | string | `$HANNIGAN_HOME/secretary` | VPS の秘書セッション群のルート。会話ログを共有する作業ディレクトリとしては使わない |
| `secretary.autostart` | bool | `false` | Q6/B では会話先未確定の共有セッションを作らず、各会話の初回入力時に起動する（従来の単一秘書用 `true` から変更） |
| `secretary.session` | object | 下表 | **各会話に新規作成される**秘書セッション共通の起動条件（4 章の共通形式） |
| `secretary.contexts.mode` | enum | `per_conversation` | WebChatの会話、Discordの許可サーバーチャンネル／スレッドごとに独立した Claude Code 対話セッションを割り当てる。Q6/B で確定 |
| `secretary.contexts.root_dir` | string | `$HANNIGAN_HOME/secretary/contexts` | コンテキスト固有の作業ディレクトリと履歴を置くルート。利用者が指定した外部 ID をそのままパスにしない |
| `secretary.contexts.max_active` | int | `8` | VPS の同時起動する秘書 Claude Code セッション上限。既定は暫定で容量計測後に調整する |
| `secretary.contexts.max_pending_per_context` | int | `100` | 会話別の永続待機キュー上限。溢れたら明示エラーとし、別会話へ配送しない |
| `secretary.contexts.idle_minutes` | int | `30` | 入力待ちの秘書プロセスを停止してもよい目安。終了前に未処理・承認状態を確認し、再入力時は同じ UUID を `--resume` する |
| `secretary.shared_ledger.enabled` | bool | `true` | 案件・進捗・タスク情報の構造化台帳を利用する（Q6/B） |
| `secretary.shared_ledger.events_path` | string | `$HANNIGAN_HOME/hub/work-items.jsonl` | 構造化された案件更新イベントの記録先。会話ログとは分離 |
| `secretary.extra_instructions` | string | `""` | 秘書への追加指示。チャネルの `instructions` の末尾に足す |
| `secretary.persona.name` | string | `Hannigan` | 秘書の名前。WebChat の見出しと返信の名札に使い、秘書自身も自分の名前として名乗る。1〜40 文字（3.1 節。2026-10-17 追加） |
| `secretary.persona.character` | string | `""` | キャラ設定。性格、口調、話し方、やらないこと。毎回の返信で守らせる文章。4000 文字以内 |
| `secretary.persona.user_name` | string \| null | `null` | 利用者の呼び名。`null` なら呼び名を使わない。40 文字以内 |
| `secretary.persona.language` | string | `""` | 返信の言語。空なら相手の言語に合わせる。40 文字以内 |
| `secretary.persona.verbosity` | enum | `short` | 返信の長さ。`short` / `normal` / `detailed` |
| `secretary.routing_notes` | string | `""` | 振り分けの判断基準。どのワーカー・案件に頼むかの決め方で、`workers[].role` と合わせて秘書の指示文の振り分けの節に入る。4000 文字以内（Phase 5 の「秘書の使い分け」を前倒し） |
| `workers` | array | `[]` | 秘書に教えるワーカーの一覧（下表） |
| `workers[].id` | string | 必須 | ワーカー ID。`worker.json` の `worker_id` と一致させる。英数字、`-`、`_` で 1〜32 文字 |
| `workers[].display_name` | string | id と同じ | WebChat と秘書への表示名 |
| `workers[].role` | string | `""` | 役割の説明文。秘書が振り分けに使う（例: 「仕事用。会社のリポジトリはこちら」） |
| `offline_queue.enabled` | bool | `false` | OSS配布時は無効。Q12/Cの運用で管理者が明示的に有効化する。TTLの既定値があっても自動有効化しない |
| `offline_queue.ttl_minutes` | int | `1440` | **Q13/C確定。** 受付から24時間＝1,440分を既定値とする。省略時は1,440を適用し、明示的な `null`／0／負数／非整数はエラー。正の整数で設定変更可能 |
| `offline_queue.max_pending_per_worker` | int | `100` | Macごとの保留上限（容量上の暫定値）。超過時は `queue_full` を返し古い指示を無断で削除しない |
| `offline_queue.events_path` | string | `$HANNIGAN_HOME/hub/offline-requests.jsonl` | VPS上の追記型永続台帳。未配送指示本文は共通案件台帳と分け、ファイル権限・保存期間を厳格管理する。Q14/Bでは `accepted_at` / `operation_id` でFIFOに復元する |
| `log.max_events_replay` | int | `2000` | WebChat 再接続時に再生する最大件数。スレッド履歴 API の保存件数とは独立 |
| `log.max_thread_history_page` | int | `200` | `/api/thread/history` の1回の最大取得件数 |
| `webchat.conversation_scope` | enum | `conversation` | 統括秘書の会話をサーバー生成 `conv_id` 単位で分離する。入力された任意IDは認証利用者への帰属を検証する |
| `webchat.threads.enabled` | bool | `true` | PM／子セッション一覧と履歴閲覧を有効にする |
| `webchat.threads.direct_send_enabled` | bool | `true` | WebChat から PM／子への直接投稿を許可する（本番は適切なユーザー認証・アクセス制御が必須） |
| `discord.enabled` | bool | `false` | VPS 側 Discord Bot アダプターを有効化する。OSS の初期状態では無効とし、明示設定が必要 |
| `discord.bot_token_file` | string | `$HANNIGAN_HOME/secrets/discord-bot-token` | Bot トークンのファイルパス。トークン文字列自体は設定・ログに置かない |
| `discord.allowed_user_ids` | string[] | `[]` | Discord の許可利用者 ID。未登録利用者からの依頼を拒否する。Discord 側の ID は数値変換せず文字列で保持 |
| `discord.allowed_channel_ids` | string[] | `[]` | Bot 宛てメッセージを受け入れるサーバーチャンネル／スレッドの ID。空なら入力不可。親チャンネルの許可を別IDのスレッドへ暗黙に継承しない |
| `discord.shared_ledger_visibility` | enum | `none` | `none` / `all_allowed_channels`。**Q7/C** に従い、後者を明示的に設定した許可チャンネルでは共有台帳の全案件を閲覧可能にする。案件別ACLは使わない。DMには適用しない |
| `discord.channel_trigger` | enum | `mention_or_bot_reply` | **Q8/A 確定。** `mention_or_bot_reply` / `mention_only` / `disabled`。許可サーバーチャンネルでBot本人への直接メンション、またはBot本人の投稿への返信を受理。`mention_only` はより厳格な設定、`disabled` はチャンネル入力停止用。通常会話を無条件に処理するモードは設けない |
| `discord.work_request_policy` | enum | `disabled` | **Q9/A 確定。** `disabled` / `allowed_users_via_secretary`。後者を明示した場合、認可済みの許可サーバーチャンネル投稿者全員が、登録済みPM有効案件へ**統括秘書経由の `project_pm_send`**を依頼できる。追加の実行者リスト／案件別委任ACLは設けない。DMには適用しない。**Q11/A：別の着手承認ゲートは設けない** |

`discord.enabled=true` では Bot トークンの存在・利用者許可リストを確認する。**Q8/A の `channel_trigger=mention_or_bot_reply` をサーバーチャンネルの既定とし、認可とトリガーが両方成立して初めてメッセージを受理する。**Botの自己投稿／Webhook／他Botは除外し、Bot投稿への返信はDiscordの参照メッセージ作者IDを検証できる場合だけ認める。**本文にBot名を含むだけではトリガーにならない。**未設定または検証失敗時は **Discord 受信を fail-closed で止め**、WebChat・ワーカー通信の稼働を巻き込まない。`discord.allowed_user_ids` は**発言を秘書へ受け付ける投稿者の制御**で、`discord.allowed_channel_ids` は**受信場所と公開先**の制御である。Q7/Cは台帳の案件別閲覧ACLを廃止し、`discord.shared_ledger_visibility=all_allowed_channels` にした許可チャンネルからの認可済み質問に限り全案件の構造化情報を返す。**チャンネル内の閲覧者全員にBotの回答が見える**。Q10/Aで個人DM・グループDMは不使用。DM由来のメッセージや再送は入口・出口の両方で拒否し、DM向け会話セッションも作成しない。投稿者・チャンネル・公開モードはツール実行時／Discord返信直前にも評価する。**Q9/Aでは `work_request_policy=allowed_users_via_secretary` を明示した許可ユーザー全員が、許可サーバーチャンネルから登録済み案件PMへ作業を依頼できる。**受信許可や台帳閲覧許可だけでは実行させず、ハブがツール実行時に発行元投稿を再検証する。Discord由来の `session_*` や承認・設定APIの代理呼び出しは禁止する。MacワーカーへBot秘密情報や許可リストを転送しない。**Q10/Aのv7案では `discord.allow_dm` と `discord.context_scope` を提供しない**。`guild_id` を検証できる許可サーバーチャンネル／スレッドのみを入口・返信先とする。旧設定に `allow_dm=true` が残る場合、移行完了までDiscord入力を拒否し、意図しないDM処理を防ぐ。

**Q12/Cの設定上の扱い:** 保留対象は `project_pm_send` に対応する `pm_send` と、WebChatの `thread_direct_send` のみ（許可リストは固定）。`offline_queue.ttl_minutes` 省略時は既定の `1440` 分を設定し、`null`／0／不正値を明示した場合は起動時検証エラーとし、無期限キューにしない。`enabled=false` の場合も既定TTLは1,440分だが配送保留を開始しない。期限はVPS受付時刻から計算し、保留と配送済み・作業中を混同しない。保留依頼を保存する権限・本文の暗号化／削除方針・VPS停止中の失効復元は実装・試験を要する。Discordへの直接子セッション操作や承認回答を許可する変更ではない。

**Q11/Aの設定上の扱い:** `discord.work_request_policy=allowed_users_via_secretary` でQ9/Aの委任条件を満たした場合、Hannigan独自の作業着手承認やリスク別の承認設定は追加しない。`discord.start_approval_policy` のような新キーは設けず、**Q11時点では**`hub.json` v7案を維持した（後続Q12/Cではオフラインキュー用にv8案へ改訂）。Mac側のClaude Codeが要求するツール承認・CU等の既存確認は、下記の `permission_mode`／`allowed_tools`／`terminal_prompts` に従って従来どおり処理する。Discordの許可ユーザーへ承認回答権を与えるものではない。

`secretary.session` は全会話に共通の**起動テンプレート**として次を適用する。秘書は振り分けと共有台帳の認可済み参照だけを行うので、組み込みツールを持たせない。会話履歴と Claude Code UUID は共有しない。

| 項目 | 既定値 |
| --- | --- |
| `permission_mode` | `manual` |
| `builtin_tools` | `""`（組み込みツールなし。`--tools ""` を渡す） |
| `allowed_tools` | `["mcp__hannigan"]`（ハブのツールは承認なしで呼べる） |

### 3.1 秘書のキャラ設定（`secretary.persona`。2026-10-17 追加、Phase 5 前倒し）

秘書は利用者が WebChat で話す相手なので、名前と人格を設定で持つ。ハブは `secretaryInstructions()` で次の順に指示文を組む。人格の部分は冒頭に置き、振り分けとツールの規則はその後ろに固定で続く。キャラ設定がどう書かれていても、振り分けの規則、依頼元の会話にだけ返す規則、結果を推測しない規則は変わらない。

1. 冒頭: `You are "<name>"` と、1 会話専任で作業は PM に任せる役割
2. `character` があれば「Your character」の段落、`user_name` があれば呼び名の指示
3. 受信する出来事の種類（固定）
4. ワーカーと役割の一覧（`workers[]`）
5. 振り分けの手順（固定）。1 番目の手順の直後に `routing_notes` を「Routing guidance from the person」として差し込む
6. 返信の規則（固定）、`language`、`verbosity` に応じた文
7. `extra_instructions`

キーは全部に既定値があるので、`persona` を持たない v8 の `hub.json` はそのまま読める。版は 8 のままとし、移行は要らない。既定の名前は `Hannigan` で、`scripts/dev-setup.ts` は初回起動時に既定値を書いた `persona` を `hub.json` に残す。

反映の時期: 指示文は秘書セッションの起動時（再開を含む）にチャネルの `setup` で渡すので、変更は次に起動する秘書から入る。動いている秘書は古い指示文のままで、設定画面はその件数を表示し、すぐ反映するには一覧で「停止」して次の発言で再開するよう案内する。名前だけは画面の表示にすぐ反映する。

## 4. worker.json

| 項目 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `version` | `2` | 必須 | worker 設定の新しい版。v1 からの移行が必要（本書 10 章） |
| `worker_id` | string | 必須 | ハブの `workers[].id` と一致させる |
| `hub_url` | string | `ws://127.0.0.1:8800/ws/worker` | **開発専用既定値**。本番では `wss://<VPSの公開ドメイン>/ws/worker` を設定する |
| `local.host` | string | `127.0.0.1` | Mac 内のチャネル中継の接続先。外へは開けない |
| `local.port` | int | `8801` | 同上のポート |
| `projects` | array | `[]` | このワーカーで使えるプロジェクト |
| `projects[].id` | string | 必須 | 秘書が指定する名前。英数字、`-`、`_` で 1〜32 文字 |
| `projects[].path` | string | 必須 | 絶対パス。`~` は展開する |
| `projects[].description` | string | `""` | 秘書と案件 PM への説明 |
| `projects[].pm.enabled` | bool | `true` | 当該 Mac の案件で PM セッションを使用する。Q2/B の既定は有効 |
| `projects[].pm.autostart` | bool | `false` | デーモン起動時に PM も起動するか。既定は初回依頼時に自動起動 |
| `projects[].pm.extra_instructions` | string | `""` | 担当案件 PM の役割・運用指示。案件ごとに設定する |
| `projects[].pm.execution_policy` | enum | `hybrid` | PM が自分で実行するか子に委任するかの既定方針。`delegate_only` / `hybrid` / `direct_first`（下記）。Q3/B で `hybrid` に決定 |
| `pm_session` | object | 本書 4.2 | Mac 上で起動する PM のセッション条件。作業セッションと別設定 |
| `session` | object | 下表 | `role=task` の作業セッション条件（共通形式） |
| `max_sessions` | int | `4` | 同時に動かす PM・作業セッションの合計上限（PMも1枠）。Q14/Bでは独立作業の並列化の上限として使うが、**CU・編集領域の排他保証を代替しない** |
| `tmux.prefix` | string | `hn` | tmux セッション名の先頭。`<prefix>-<project>-<短い ID>` になる |
| `tmux.width` / `tmux.height` | int | `160` / `48` | tmux 画面の大きさ。画面読み取りの安定のため固定する |
| `claude_bin` | string | `claude` | Claude Code の実行ファイル。試験では偽物に差し替える |
| `bun_bin` | string | `bun` | チャネル中継を動かす Bun の実行ファイル |
| `outbox.max_events` | int | `5000` | ハブへ未送信の出来事を保持する上限。ユーザー直接指示や PM 通知の欠落を許容しないため、容量不足時は黙って削除せず失敗を返す |
| `thread_observation.mode` | enum | `transcript` | `transcript`（ネイティブ記録から閲覧用の会話本文を抽出する設計目標）／`reports_only`（可視化欠損を明示する縮退モード）。実装・可用性は要検証 |
| `thread_observation.redact_sensitive` | bool | `true` | 履歴イベントからトークン・秘密値などを除去する。実際の除去性能は受入試験対象 |

### 4.1 セッションの起動条件（共通形式）

秘書（hub.json の `secretary.session`）、作業セッション（worker.json の `session`）、案件 PM（worker.json の `pm_session`）は同じ基本形を使う。**ただし役割ごとにツール許可は独立**している。

| 項目 | 型 | 既定値（作業セッション） | 説明 |
| --- | --- | --- | --- |
| `permission_mode` | enum | `manual` | `--permission-mode` に渡す。承認を WebChat に中継したいので `manual` を推奨 |
| `model` | string \| null | `null` | `--model`。null なら Claude Code の既定 |
| `builtin_tools` | string \| null | `null` | `--tools`。null なら渡さない |
| `allowed_tools` | string[] | `["mcp__hannigan__reply"]` | `--allowedTools`。返信ツールは承認なしにする |
| `extra_args` | string[] | `[]` | そのほか Claude Code へ渡す引数 |
| `env` | object | `{}` | 追加の環境変数 |
| `terminal_prompts.dev_channel_warning` | enum | `relay` | 開発用チャネル警告の扱い。`relay` は WebChat に承認カードを出す。`auto_accept` は常駐プログラムが「I am using this for local development」を選ぶ |
| `terminal_prompts.workspace_trust` | enum | `relay` | フォルダの信頼確認。`relay` か `auto_accept`。`projects` に登録したフォルダだけが対象 |
| `terminal_prompts.other` | enum | `relay` | そのほかの端末ダイアログ（CU のアプリ承認、ツール承認の端末側）。`relay` のみ |

`auto_accept` は利用者が明示的に選んだときだけ有効にする。既定は `relay` とし、無人運用で手間を減らしたい場合に切り替える。


### 4.2 案件 PM セッションの既定値（新設）

PM は同じ Mac の案件フォルダを読み、必要に応じてローカルの子作業セッションへ仕事を委任する。専用の `pm_session` には以下の既定値を使い、それ以外の共通項目は 4.1 を継承する。役割やツール制限は CLI 起動だけに頼らず、デーモン側でも強制する。

| 項目 | 既定値 | 説明 |
| --- | --- | --- |
| `permission_mode` | `manual` | PM のファイル・ツール操作も通常の承認方針に従う |
| `model` | `null` | Claude Code の既定モデル。案件 PM 固有に変更可能 |
| `builtin_tools` | `null` | 案件ファイルの調査に加え、軽量なコード編集とテストを PM 自身で行える。通常ツールの権限承認は維持する。純正 CU は原則子へ委任（実際のツール隔離の可否は要実機検証） |
| `allowed_tools` | `['mcp__hannigan__reply', 'mcp__hannigan__task_list', 'mcp__hannigan__task_create', 'mcp__hannigan__task_resume', 'mcp__hannigan__task_send', 'mcp__hannigan__task_interrupt', 'mcp__hannigan__task_stop', 'mcp__hannigan__work_item_create', 'mcp__hannigan__work_item_update']` | 同じワーカー／案件の子セッションと構造化タスク台帳だけ操作できるローカルツール |

#### 実行ポリシーの意味（Q3/B）

| 値 | 判断の傾向 | 純正 CU の扱い |
| --- | --- | --- |
| `delegate_only` | PM は調査・計画・指示・レビューに専念し、変更作業は子へ委任 | 子へ委任 |
| `hybrid`（既定／選択済み） | 単発調査・小規模なコード修正・簡単なテストは PM 自身。長時間・複数段階・並列化したい作業は子へ委任 | **原則子へ委任** |
| `direct_first` | PM が対応できる作業はまず自分で処理し、複雑化／並列化が必要なら委任 | 子へ委任 |

- `execution_policy` は案件 PM の `instructions` に注入し、判断基準を示す**運用設定**とする。デーモンは役割・案件境界・承認を強制するが、「軽量かどうか」を秒数／LOC 等の固定数値で強制はしない。
- PM 自身の組み込みツールは利用可能（`pm_session.builtin_tools=null`）。この設定だけでは CU の利用禁止を強制できない可能性があるため、PM に CU を公開しない方法・権限制限の実効性は対象版で検証する。設定文による自己制御を技術的な権限隔離と表現しない。
- `projects[].pm.enabled=false` の案件は `pm_send` を拒否する。WebChat による直接投稿は **既存の PM／子セッションへの利用者の明示的な介入**であり、秘書による通常の案件依頼を PM から迂回させる機能ではない。親 PM がない子への直接送信は拒否する。
- 同じ Mac の複数案件はそれぞれ別 PM セッション・別会話履歴を持つ。`max_sessions` 超過時は既存の `busy` を返し、既存セッションを無断停止しない。
- PM は開始時に案件フォルダの `CLAUDE.md` などの既存設定を引き継ぐ。PM が軽量な編集を直接行えるため、子と同じフォルダへの並行書き込みが発生し得る。Q15/Bで**同じ実体作業領域の書込可能セッション全体を直列化**すると確定。PMと子でworktreeは作らない。Q16/Aで作業完了と書込停止確認後の自動返却を採用。セッション継続時の権限剥奪方法は実機検証が必要。

## 5. 秘密情報

| ファイル | 置く場所 | 中身 | 作り方 |
| --- | --- | --- | --- |
| `webchat-token` | ハブ | 32 バイトの乱数（16 進） | 導入 CLI（Phase 5）か `scripts/dev-setup.ts` が生成 |
| `discord-bot-token` | VPS ハブ／Discord アダプター | 利用者が Discord の Bot 設定で取得したトークン | 利用者が導入 CLI／安全な設定経路で保存。OSS に同梱・ハードコードしない |
| `local-bridge-token.hub` / `.worker` | VPS／各 Mac | 同上 | 起動時に無ければ生成 |
| `worker-keys.json` | ハブ | ワーカー ID と鍵の対応 | Phase 2〜3 は `dev-setup` が生成。Phase 4 からペアリングで追加 |
| `worker-key` | ワーカー | 自分の鍵 | 同上 |

- フォルダは 700、ファイルは 600 で作る。読み込み時に権限が緩ければ警告する
- 秘密情報はログ、出来事の記録、エラーメッセージ、`ps` に出る引数に載せない。チャネル中継へはファイルの場所だけを環境変数で渡す
- Mac では将来 OS のキーチェーンに移せるよう、読み書きは `shared/secrets.ts` の 1 か所に閉じ込める。Linux VPS では少なくともファイル権限と運用ユーザー権限を厳格に管理する

## 6. ペアリング（Phase 4 で実装、形だけ確定）

1. 利用者が WebChat の設定画面で「ワーカーを追加」を押す。ハブが 8 桁の一時コード（10 分有効、1 回限り）を発行する
2. 作業 Mac で `hannigan pair <hub_url> <code>` を実行する。ワーカーが一時コードと自分の `worker_id` をハブへ送る
3. ハブがコードを確かめ、新しい鍵を生成して `worker-keys.json` に追記し、ワーカーへ返す。ワーカーは `worker-key` に保存する
4. 以後の接続は鍵で認証する。鍵の取り消しはハブの `worker-keys.json` から消すだけで済む

Phase 2〜3 のローカル実地テストではペアリングを作らず、`scripts/dev-setup.ts` が同一ホストに両方の鍵ファイルを書く。VPS と Mac を分離した本番構成では、Phase 4 のペアリングを前提とする。

## 7. 設定に入れないもの

次の値は Claude Code 側の準備で、ハブやワーカーの設定からは変えられない。導入 CLI（Phase 5）が書き込み、設定画面は状態の表示だけを行う。

- Claude Code へのログイン、組織の `channelsEnabled` 方針
- 純正 Computer Use の有効化（`/mcp`）と macOS の権限（アクセシビリティ、画面収録）は Mac ワーカーのみ。Linux VPS の秘書には適用しない
- ユーザー設定のフック、出力スタイル、CLAUDE.md（作業セッションにもそのまま効く）

## 8. 例（本番: VPS ハブ＋Mac ワーカー）

**VPS 上の `$HANNIGAN_HOME/hub.json`**（公開ドメインは説明用の例）

```json
{
  "version": 8,
  "secretary": { "autostart": false, "contexts": { "mode": "per_conversation", "max_active": 8 }, "shared_ledger": { "enabled": true } },
  "webchat": { "conversation_scope": "conversation", "threads": { "enabled": true, "direct_send_enabled": true } },
  "offline_queue": { "enabled": false, "ttl_minutes": 1440, "max_pending_per_worker": 100 },
  "discord": { "enabled": false, "allowed_user_ids": [], "allowed_channel_ids": [], "channel_trigger": "mention_or_bot_reply", "shared_ledger_visibility": "none", "work_request_policy": "disabled" },
  "listen": { "host": "127.0.0.1", "port": 8800 },
  "public_url": "https://hannigan.example.com",
  "workers": [
    { "id": "kabosu", "display_name": "Kabosu", "role": "作業用 Mac。登録された案件を実行" },
    { "id": "lime", "display_name": "Lime", "role": "別の作業 Mac。登録された案件を実行" }
  ]
}
```

**Q7/C・Q8/A・Q9/A のDiscord公開・トリガー・実作業依頼設定例（有効化時だけ適用、IDは仮値）**

```json
{
  "discord": {
    "enabled": true,
    "allowed_user_ids": ["<許可投稿者のDiscordユーザーID>"],
    "allowed_channel_ids": ["<許可するDiscordチャンネルID>"],
    "channel_trigger": "mention_or_bot_reply",
    "shared_ledger_visibility": "all_allowed_channels",
    "work_request_policy": "allowed_users_via_secretary"
  }
}
```

これは `hub.json` の `discord` 部分だけを抜き出した例。**Q11/Aでは本設定が有効な認可済み作業依頼を追加の着手承認なしで案件PMへ配送する**（既存ツール承認は別）。追加の開始承認フラグは必要ない。IDは設定画面またはCLIで実際の値に置き換える。`allowed_user_ids` に入っていなくても**チャンネルの閲覧権がある人はBotの回答を読める**点に注意。

**作業 Mac 上の `$HANNIGAN_HOME/worker.json`（例: Kabosu）**

```json
{
  "version": 2,
  "worker_id": "kabosu",
  "hub_url": "wss://hannigan.example.com/ws/worker",
  "projects": [
    { "id": "notes", "path": "~/work/notes", "description": "メモと下書き",
      "pm": { "enabled": true, "autostart": false, "execution_policy": "hybrid", "extra_instructions": "この案件の進捗・作業セッションを管理する" } }
  ],
  "session": { "terminal_prompts": { "dev_channel_warning": "relay" } },
  "pm_session": { "permission_mode": "manual" },
  "thread_observation": { "mode": "transcript", "redact_sensitive": true }
}
```

**Q12/C・Q13/Cで本機能を運用する場合**、管理者が `offline_queue.enabled=true` に設定する。`ttl_minutes` を省略しても**24時間（1,440分）**が適用され、設定する場合は正の整数のみ許可する。上のJSONはキュー無効のOSS初期状態の例であり、自動配送は行わない。既存保留依頼の `expires_at` は設定変更・再起動で延長しない。

**今回の希望を適用する運用設定（`hub.json` の該当部分）:**

```json
{
  "offline_queue": {
    "enabled": true,
    "ttl_minutes": 1440,
    "max_pending_per_worker": 100
  }
}
```

この部分を既存の `hub.json` にマージする。`max_pending_per_worker=100` は容量の仮値であり、実測前の確定数ではない。**OSS公開時の初期値は引き続き `enabled=false`** とする。

上の公開ドメインと役割文は実際の設定値ではない。VPS に TLS 終端を用意し、ブラウザは HTTPS、ワーカーは WSS で接続する。VPS 上の秘書 Claude Code は独立したログイン・常駐管理が必要。Discord は明示的に有効化し、**Bot トークンファイルと最低 1 人の許可利用者**、利用するサーバーチャンネル／スレッドを明示的に許可する。DMは使用しない。初期状態は Discord 無効で安全側に倒す。

### 8.1 例（Phase 3: ローカル実地テスト。ハブとワーカーを同じ Mac で動かす）

Phase 3 では VPS を使わず、ハブ・秘書・WebChat を手元の Mac で起動する。スキーマは上の v8 案と同じで、値だけをローカル向けにする。`scripts/dev-setup.ts` がこの形で生成する。

**`$HANNIGAN_HOME/hub.json`**

```json
{
  "version": 8,
  "secretary": { "autostart": false, "contexts": { "mode": "per_conversation", "max_active": 2 }, "shared_ledger": { "enabled": true } },
  "webchat": { "conversation_scope": "conversation", "threads": { "enabled": true, "direct_send_enabled": true } },
  "offline_queue": { "enabled": true, "ttl_minutes": 1440, "max_pending_per_worker": 100 },
  "discord": { "enabled": false },
  "listen": { "host": "127.0.0.1", "port": 8800 },
  "public_url": null,
  "workers": [ { "id": "home", "display_name": "自宅 Mac", "role": "私用。個人の開発" } ]
}
```

**`$HANNIGAN_HOME/worker.json`**

```json
{
  "version": 2,
  "worker_id": "home",
  "hub_url": "ws://127.0.0.1:8800/ws/worker",
  "projects": [
    { "id": "notes", "path": "~/work/notes", "description": "メモと下書き",
      "pm": { "enabled": true, "autostart": false, "execution_policy": "hybrid", "extra_instructions": "" } }
  ],
  "session": { "terminal_prompts": { "dev_channel_warning": "relay" } },
  "pm_session": { "permission_mode": "manual" },
  "thread_observation": { "mode": "transcript", "redact_sensitive": true }
}
```

- `offline_queue.enabled` は実地テストのために `true` にする（OSS 初期値は `false` のまま）。ワーカー常駐プログラムを止めて保留と再配送を再現する
- `discord.enabled=false` 以外の `discord.*` は Phase 7 まで読み飛ばす。`public_url=null` のローカル推定 URL は開発用
- LAN 内の 2 台目を足す場合は `ws://` を LAN に晒さず、SSH トンネルで `127.0.0.1:8800` を転送する。ペアリングは Phase 4 まで作らず、ハブ側で `scripts/add-worker.ts --worker <id>` が鍵の発行と `workers[]` への追加を行い（ハブの再起動が要る）、2 台目で `scripts/worker-setup.ts --worker <id> --key <鍵>` が `worker.json`（案件は空、`hub_url` はトンネル先の `ws://127.0.0.1:<port>/ws/worker`）と `secrets/worker-key` を書く。2 台目に `hub.json` は置かず、`scripts/start.sh worker` だけを使う。手順は [docs/manual/README.md の 11 章](../manual/README.md#11-2-台目の-mac-をつなぐ)（2026-10-17 追加）
- 既存の v1 設定からの移行（10 章）はこの段階で実装し、Phase 2 のセッション台帳を `role=task` として引き継ぐ

## 9. VPS 構成で追加確認する項目（Q1決定の実装条件。Phase 4 で実施）

- VPS 上で Claude Code の対話セッションを起動・維持・再開できること（Linux 用 Claude Code、tmux、適切な実行ユーザー）。
- ハブと秘書ブリッジは同じ VPS 内の localhost で通信すること。`worker.json` は VPS 本番構成では不要。
- `hub.json` の `listen.host` はループバックに保ち、HTTPS/WSS のリバースプロキシで公開すること。外部の非 TLS WebSocket を受け付けない。
- VPS 停止・再起動時にハブと秘書が復帰すること。サービス管理方式（例: systemd）の詳細は実装時に確定する。
- **確定 Q2/B**: 案件 PM は担当 Mac の Claude Code セッションとして起動。案件 PM の配置・設定項目は本書 4.2 に定義。
- **確定 Q3/B**: 案件 PM は `execution_policy=hybrid`。軽量調査・小規模編集を直接実行し、長時間・並列・純正 CU 作業は子に委任する。
- **確定 Q4/B**: WebChat の PM／子スレッドを閲覧し、そのスレッドに直接投稿する。子への投稿は所属 PM への通知と配送状態を必須とし、ログ抽出の可否を対象版で確認する。
- **確定 Q5/A**: Discord は VPS 上で秘書の通常会話のみ中継。Discord から PM／子の直接投稿 API や承認・設定 API は呼べない。許可ユーザー／チャンネル、Bot トークンの分離、送信元返信、重複入力の抑制を設計条件とする。
- **確定 Q6/B**: WebChat は会話ID単位、Discord は許可サーバーチャンネル／スレッド単位で秘書の物理セッションを分離し、認可された構造化案件台帳のみ共有する。
- **確定 Q7/C**: 許可チャンネルから認可済みの質問には全案件の共有台帳を返す（`discord.shared_ledger_visibility=all_allowed_channels`）。DMと未許可チャンネルには適用しない。
- **確定 Q8/A**: Discordサーバーチャンネルでは、Botへの直接メンションまたはBot投稿への検証済み返信のときだけ受信する（`discord.channel_trigger=mention_or_bot_reply`）。雑談・Bot自己投稿は無視。
- **確定 Q9/A**: 許可サーバーチャンネルの許可ユーザー全員が、Bot呼び出し条件を満たせば全登録案件PMへ秘書経由で実作業依頼可能。`discord.work_request_policy=allowed_users_via_secretary` を明示する。DMは対象外。
- **確定 Q10/A**: Discordの個人DM・グループDMを不使用とし、入口・会話作成・台帳取得・実作業委任・出口のすべてで拒否する。
- **確定 Q11/A:** Discordの認可済み実作業依頼は追加着手承認なしに配送。Claude Code側のツール承認／端末承認を維持し、既定権限で自動許可された操作は追加確認なしに進み得る。
- **保留**: WebChat の本番認証・利用者別アクセス権、SSE 認証、履歴保存期間、同一案件の複数 Mac 所属、作業フォルダの隔離方式。

## 10. hub v1〜v7案 → v8、worker v1 → v2 の移行

- **改訂案の版:** Q10/AはDM対応を撤去したhub v7未実装案、Q11/Aはそのv7を維持。**Q12/Cで `offline_queue.*` を新設するためhub v8未実装案**へ移行する。`worker.json` は従来の v2 改訂案のまま（ただし実装コードに期限判定と受信台帳が必要）。
- worker v1→v2 では既存 `projects[]` に `pm.enabled=true`、`pm.autostart=false`、`pm.execution_policy="hybrid"`、`pm.extra_instructions=""` を補い、`pm_session` と `thread_observation` の既定値を設定する。worker v2 に Q6 の新設定は不要。
- 既存ワーカーセッションの会話ファイルや UUID は維持し、旧 `sessions.json` のセッションを `role=task` とみなす。PM は新しい UUID を持つ。**旧秘書の単一会話は異なるチャンネルへコピーせず**、管理者限定のレガシー履歴として隔離し、新しい会話別セッションを作成する。
- **実装前に必要:** ハブ v1〜v6案からv7案への移行、ワーカー v1→v2 の移行、バックアップ・ロールバックを設計／実装する。すべて未実装。
- **v3→v4:** `discord.shared_ledger_visibility="none"` を安全な初期値として補い、管理者の明示的な許可があるときのみ `all_allowed_channels` を設定する。
- **v4→v5:** `discord.require_mention_in_channels` を廃止し、`channel_trigger="mention_or_bot_reply"` を導入。旧値が `false` の場合は自動移行せず管理者確認を要求する。
- **v5→v6:** `discord.work_request_policy="disabled"` を初期値として補う。Q9/Aの利用者が明示的に有効化するときだけ `allowed_users_via_secretary` に変更する。
- **v6→v7:** `discord.allow_dm` と `discord.context_scope` を廃止。`allow_dm=true` の旧設定があれば自動移行を停止し、管理者の確認を要求する。`false` は廃止項目として削除できる。旧DMセッション・DM宛てキューは隔離し、自動再開・再送しない。v7読込時にも `allow_dm=true` を単なる未知項目として黙認せず、明示エラーにする。
- **v7→v8（Q13/C反映）:** `offline_queue.enabled=false`、`ttl_minutes=1440` を補い、既存システムから自動で期限付き配送を有効にしない。管理者は必要な環境で `enabled=true` に切り替える。旧版の `worker_offline` は新しい依頼にのみ適用され、旧来の失敗記録を勝手に作業キューへ変換しない。旧Q12草案の `enabled=false, ttl_minutes=null` は警告付きで1,440に正規化する。
- **会話状態の移行:** 従来の `secretary.autostart=true` は `false` にし、`context_id→秘書UUID` の永続対応表と案件台帳を新設。旧 `last_chat_id` に依存した返信先推定を廃止し、依頼単位 `request_id` を使用する。

- **実装メモ（2026-10-16, Phase 3 WP1）:** 8.1 の「`discord.*` は Phase 7 まで読み飛ばす」と 3 章の検証方針が食い違うため、`discord.*` は型を検証したうえで `enabled=true` を「Phase 7 で実装」として起動エラーにした。v8 ファイルに `allow_dm` が残る場合は値を問わずエラーにする。`secretary.contexts.root_dir` の既定は `project_dir` を変えても `$HANNIGAN_HOME/secretary/contexts` のまま。移行の書き戻しは検証に通った後だけ行い、元ファイルを `<file>.bak-v<旧版>-<UTC時刻>` に残す。

## 11. Q3/B の受入条件（PM が直接作業／子へ委任）

1. `execution_policy=hybrid` の PM が単発の調査・小規模修正を自身の組み込みツールで実行し、子を新規作成せずに `reply` で報告できる。
2. 長時間・並列・純正 CU を要する依頼で PM が `task_create` / `task_send` を使い、子の結果を受けて統括秘書へ報告できる。
3. PM の自身の編集に対しても通常の承認フローが機能し、子の権限境界を迂回しない。
4. Q15/BによりPM／子は共有フォルダの単一ライター排他に従い、同時書込を**技術的に拒否**する。検知や運用上の注意だけでは足りず、強制機構は要実測。
5. PM の純正 CU 不使用を制御できるか対象の Claude Code 版で検証し、制御できない場合は制約として明記する。

## 12. Q4/B の設定と受入条件（スレッド閲覧／直接投稿）

1. `webchat.threads.enabled=true` で PM と子作業のスレッドがともに一覧に表示され、メッセージ・報告・承認・状態が同じスレッドへ関連付けられる。
2. `direct_send_enabled=true` で宛先を PM または子に明示して送れる。`false` にした場合は既存履歴の閲覧のみ可能。履歴閲覧権限と投稿権限はハブの認可で判定する。
3. 子への直接投稿は子配送と PM 通知を**別々の配送状態**として保存し、PM 不在時の通知キューを復旧後に届ける。Q12/Cのオフライン保留有効時は `pending_offline` と期限を返し、**配送済みと表示しない**。設定無効／期限不正の場合は `worker_offline`／設定エラーを返す。
4. `thread_observation.mode=transcript` は、ネイティブセッションの公開可能な会話本文と必要な作業記録の抽出を目標とするが、対象 Claude Code 版で実測するまで機能成立とはみなさない。内部推論・秘密情報を WebChat に表示しない。
5. スレッド履歴の保存期間・内容の機微性・アクセス権の粒度は別決定事項。公開利用する本番環境への展開前に確定する。


## 13. Q5/A の設定と受入条件（Discord は秘書会話専用）

1. `discord.enabled=false` では Discord アダプターは稼働せず、WebChat・Mac ワーカーの動作へ影響を与えない。`true` でも Bot トークン／許可ユーザー不足時は外部入力を許可しない。
2. 許可済み利用者・許可済み受信先だけがメッセージを統括秘書へ届けられる。Bot の自己メッセージ／他 Bot／非許可チャンネルの入力はタスクを生成しない。
3. Discord 起点の秘書メッセージに `source=discord` と外部メッセージ ID、返信先を紐づける。秘書の返信は同じ依頼の元チャットへルーティングされる。返信先不明なら勝手に別チャンネルへ投稿しない。
4. Discord の接続断、同じ外部 ID の再受信、秘書／Discord 側の送信失敗でも、未達と重複を識別できる。Discord の通知成功は子セッションの作業完了を意味しない。
5. Discord Bot／その API から `GET /api/threads`、`POST /api/thread/send`、承認／停止／設定 API を操作できない。通常の作業委任は必ず統括秘書の既存ツールを介す。
6. Bot トークン・内部認可情報をログや返信に流さず、Discord チャンネルの参加者に機微な WebChat 会話を意図せず流さない。Q6/B では会話セッション分離とアクセス制御で対応する（実装・検証が必要）。
## 14. Q6/B の設定・移行・受入条件（会話分離と共有案件台帳）

1. ハブは WebChat の `conv_id`、Discord の許可サーバーの `guild_id + channel_id` のみを**別々の `context_id`** に正規化する。DM由来の入力は `context_id` を作らず拒否する。Discord のスレッドチャンネルにも固有 ID を使う。入力元で確定した `context_id` は変更不可で、利用者が本文中で名乗った ID は無視する。
2. 各 `context_id` に対し独立した Claude Code UUID・作業ディレクトリ・会話ログを持たせる。WebChat 会話Aの履歴をDiscordチャンネルBに投入せず、Discordチャンネル間でも自動共有しない。役割プロンプトとツール定義だけ共通化する。
3. 既存 `secretary.autostart` はコンテキスト未確定の秘書を1つ起動する方式から変更し、既定を `false` とする。コンテキスト入力時に起動し、必要に応じて停止・同じ UUID で再開。未処理メッセージを上限超過時に別コンテキストへ流用しない。
4. 秘書から案件 PM へ委任するときにハブが `request_id` に対応する `work_item_id` を払い出す。PMが独自に新タスクを作る場合は `work_item_create` を使用し、更新には `work_item_update` を使用する。共有台帳は `hub/work-items.jsonl`（追記専用イベント）と再構築可能な読み取りインデックスに保存する。最初は `{worker_id, project_id, work_item_id, title, status, summary, assignee?, updated_at, source_request_id?}` のような**明示的な構造化項目のみ**を保持。会話全文、ツールログ、生のユーザー指示、認証情報は登録対象外とする。
5. **Q7/C確定:** Discordの許可チャンネルでは、`shared_ledger_visibility=all_allowed_channels` を明示した場合のみ、認可済み投稿者の `project_status` に共通台帳の全案件を返す。案件別閲覧ACLは使わない。DM・未許可チャンネル・公開モード未指定の場合は共有台帳を出さない。WebChat側の認可モデルは変更しない。
6. `request_id` と `context_id`、`origin_route_id`、案件 PM、作業項目を VPS で永続的に対応づける。同じ PM へ WebChat と複数 Discord チャンネルから同時依頼しても、完了結果は最終メッセージの会話ではなく**依頼元の秘書セッションだけ**に渡す。帰属不明時は返信を推測せず記録して保留する。
7. 再起動・切断後に全ての `context_id → session UUID` と未処理の依頼／台帳イベントを再構築できること。コンテキストの最大同時起動数超過、返信先の削除、チャンネル許可取り消し時に情報が別会話へ漏れないことを検証する。
8. `hub.json` は Q12/C を加えた未実装の **v8 案**に更新する。v1〜v7案からの移行を定義・検証する。`worker.json` は Q7・Q8 で設定項目を増やさず **v2案のまま**。ワーカーの `request_id` 中継と `work_item_created`／`updated` は **通信 proto v2** の追加実装・試験が必要。設定ファイルの worker v2 とは別のバージョンである。


## 15. Q7/C の設定と受入条件（許可Discordチャンネルでは全案件を参照）

1. `discord.enabled=true`、許可投稿者、許可チャンネル、Q8/Aの「Botへの直接メンション／Bot投稿への返信」起動条件、`discord.shared_ledger_visibility=all_allowed_channels` を満たす場合は、登録された全案件の共有台帳概要を取得できる。後から新規追加した案件も自動的に参照範囲に入る。
2. `shared_ledger_visibility=none`、未登録チャンネル、未登録投稿者、DMのいずれかでは、共通案件台帳をモデルへ返さない。公開モードの誤設定やIDが不正な場合は fail-closed とする。
3. 案件別閲覧ACLは要求しない。ただしBotへの**投稿者認可**およびDiscordの**チャンネル閲覧者への公開リスク**は明確に区別する。公開するのは案件台帳であり、個人会話・実行ログ・認証情報は含めない。
4. チャンネルの許可取り消し後は、ツール再呼び出しだけでなく返答の送信直前にも公開先を再検証し、取り消し済みなら投稿しない。削除されたチャンネルへ代替配送しない。
5. `project_pm_send` 等の作業実行権限を、**全案件の閲覧許可から自動的に導出しない**。Q9/Aによる明示的な `work_request_policy=allowed_users_via_secretary` で `project_pm_send` だけを許可し、低レベル `session_*` や承認・停止・設定権限は与えない。
6. v3案の設定をv4案以降へ移行した直後は `shared_ledger_visibility=none`。管理者の明示的な設定がない限り全件公開を始めない。

## 16. Q8/A の設定と受入条件（Botへのメンション／返信のみ反応）

1. `discord.channel_trigger=mention_or_bot_reply` では、許可投稿者・許可サーバーチャンネルにおいてBotユーザーIDへの**直接メンション**があれば受理する。`mentions` の構造化情報を使い、単なる表示名文字列、役職メンション、`@everyone` は起動条件にしない。
2. Bot自身が**実際に投稿したメッセージへの返信**は、Botへのメンション無しでも受理する。`message_reference` に加え、返信先の `referenced_message.author.id` またはDiscord APIで取得した作者IDを現在のBotユーザーIDと照合する。作者未確認・参照削除・別チャンネル・権限不足なら受理しない。
3. `allowed_user_ids`、`allowed_channel_ids`、`discord.enabled`、`channel_trigger` のいずれかが不適切なら受理しない。Bot／Webhook／他Botは無視する。親チャンネルの許可を子スレッドに自動適用しない。
4. トリガー未成立の通常投稿はClaude Codeへ配送せず、秘書の会話コンテキストを起動しない。本文や雑談全文をログ／台帳へ保存しない。無視理由は非機微な診断情報にとどめる。
5. Botからの返信は**起点となった利用者のメッセージへの返信**として同じチャンネルに投稿し、外部IDと内部ルートを対応づける。返信を連鎖させても同一チャンネルの秘書セッションを用い、Discordの再送・再接続でも二重指示を防止する。
6. `mention_only` は返信のみでの起動をしない厳格モード、`disabled` はサーバーチャンネルで受け付けないモード。**全投稿を処理するモードはQ8/Aに含めない。**DMはQ10/Aで不使用と確定し、受信イベント・Botへの返信・実作業依頼・返信をすべて拒否する。
7. DiscordのGateway Intents（特にメッセージ本文へのアクセス）、返信参照のイベント情報／必要時API取得の可否を実接続で検証する。検証が完了するまでQ8/Aを実装済み・動作確認済みとは扱わない。
8. v4案からv5案への移行では旧 `require_mention_in_channels=true` を `channel_trigger=mention_or_bot_reply` に変更。`false` の設定は安全性が異なるため**自動移行せず**明示的な管理者判断を要求する。`worker.json` はv2案、ワーカー通信 `proto=2` 案のまま変更なし。

## 17. Q9/A の設定と受入条件（許可利用者全員の実作業依頼）

1. `discord.work_request_policy=allowed_users_via_secretary` の場合、Botが有効で、投稿者が `allowed_user_ids`、サーバーチャンネル／スレッドが `allowed_channel_ids`、受信内容がQ8/Aトリガーに合致したとき、**すべての許可ユーザー**が `project_pm_send` を利用できる。登録済み `projects[].pm.enabled=true` の案件に案件別委任ACLはかけない。
2. `work_request_policy=disabled`（OSS既定）では、受信・会話やQ7/Cの台帳閲覧を許可していても、実作業を委任しない。移行 v5→v6 では自動的な権限拡張を行わず `disabled` を補い、管理者が明示的に切り替える。
3. ハブは各受信イベントに内部 `ingress_id` を採番し、`author_id`、`guild_id`、`channel_id`、`context_id`、`origin_route_id`、トリガー検証結果を永続記録する。ツール呼び出しは**現在の認証済みブリッジセッションとサーバーが追跡した依頼帰属**から権限判定し、モデルの `chat_id` や投稿本文を権限の根拠にしない。同一チャンネルの別ユーザー／別発言を取り違える場合は fail-closed とする。
4. Discordに認める代理操作は、登録済みの案件 PM に指示する `project_pm_send` のみ。WebChat専用の PM／子への直接介入、`session_create`／`session_send`／`session_stop`／`session_interrupt`、`approval_answer`、`terminal_answer`、設定変更や任意パス指定はDiscord由来の呼び出しでは拒否する。
5. 許可取り消しは新しいPMへの配送前にも評価する。既に始まったMac作業は遡って取り消せないので、WebChatで進行状況と承認・停止を扱う。Macの既存権限・許可ツール設定は変更せず、すべての書き込みで人間承認が必須になるとは主張しない。
6. Discordへ自動返信する作業結果は共有可能な進捗・成否・要約に限定。コード全文、秘密情報、生の実行ログ、他会話の本文は返さない。監査は `ingress_id`・投稿者・チャンネル・`request_id`・作業対象・判定結果を記録し、生メッセージ全文やトークンは監査ログへ複製しない。
7. 対象版Claude Code Channelsで、同一チャンネルの複数入力・PM報告の割り込み時にも `ingress_id` の帰属を確実に保持できるか実証する。できない場合は同一コンテキスト内の入出力を直列化するなどの方式を検討し、未検証のまま本番利用可能としない。DMはQ10/Aにより全面不使用であり、実作業依頼も受け付けない。

## 18. Q10/A の設定と受入条件（Discord DMは使用しない）

1. Discordの個人DM・グループDMはアダプター受信時に拒否する。許可ユーザーからのメンション／Botへの返信／案件質問であっても、**DMイベントから `ingress_id`、`context_id`、秘書セッション、台帳読取、PM委任を作らない**。
2. `guild_id` が存在し、許可リストに登録済みの**サーバーチャンネルまたはサーバー内スレッド**のみ受理する。`guild_id` が欠落、チャネル種別がDM、種別確認不能なら拒否する。親チャンネル許可の自動継承はしない。
3. Discord返信前および送信キュー再送前に、保存済みの `guild_id`・`channel_id` と最新の許可設定を検証する。DM宛て、送信元不明、削除されたチャンネルへの返信は送らず、**DMへ代替送信しない**。
4. `hub.json` v7案はDM用の `discord.allow_dm`・`discord.context_scope` 設定を提供しない。v6案以前の `allow_dm=true` は暗黙に移行せず、管理者へ明示エラー。`false` なら設定項目を削除できる。旧DMのコンテキスト、返信待ちキューは自動再開・再送させず隔離する。
5. DMイベントは本文を永続化せず、必要最小限の拒否理由を監査に残す。Discord側の配信そのものを止められない場合も、アプリ上では処理しない。
6. WebChatの会話、許可Discordサーバーチャンネル／スレッドのQ6/B分離、Q7/C全案件参照、Q8/A起動、Q9/A委任、Macの既存ツール承認は維持する。**Q10/Aは設計上の決定であり、受信拒否と再送拒否は実装・検証が必要**。

## 19. Q11/A の設定と受入条件（Discordの追加着手承認なし）

1. `discord.work_request_policy=allowed_users_via_secretary` の運用で、Q8/Aのトリガー・Q9/Aの投稿者／チャンネル再認可・登録済み案件PM確認を満たした依頼は、**追加のWebChat着手承認フラグなしで** `project_pm_send` → `pm_send` に進む。通常作業・高影響作業の別を問わない。
2. `discord.work_request_policy=disabled` のOSS初期値や、未許可／DM／発行元不明の場合は従来どおり委任を拒否する。Q11/AはQ9/Aの実行権限を広げない。
3. Q11で独自着手承認キーは追加しない。Q11当時は **hub v7案**を維持し、後続Q12でオフラインキュー用に **hub v8案**へ移行する。**Q11だけなら**設定スキーマ移行は不要。Q12ではhub v7→v8移行が必要。`worker.json` はv2案、ハブ⇄ワーカー通信 `proto=2` 案のまま。
4. `pm_session` と `session` の `permission_mode`／`allowed_tools`／`terminal_prompts` を変更しない。Claude Codeの通常ツール承認が発生すれば従来のWebChat経路で答える。CUのアプリ承認等、既存の端末確認も維持する。Discord Botから `approval_answer` を実行できない。
5. 既にClaude Code側で自動許可された操作には、Hannigan側のリスク別追加承認は掛からない。高影響な操作でも事前の人間確認が発生する保証はない。Hanniganの設計書・WebChat UIでこの制約を明記する。`bypassPermissions` 相当の新たな権限付与・既存承認の自動回答は行わない。
6. オフライン・`max_sessions` 上限・Claude Code承認待ちに起因する配送遅延は、着手承認待ちとは区別する。開始・承認待ち・完了を各実際の状態に基づいて表示する。

## 20. Q12/C の設定・移行・受入条件（期限付きオフライン依頼）

1. **Q13/C確定:** 受付からの既定TTLは**24時間＝1,440分**。`offline_queue.enabled=true` とした場合、`ttl_minutes` を省略すると1,440分を適用する。明示的な `null`／0／負数／非整数は設定検証エラー。無期限キューへは切り替えない。
2. `hub.json` は**未実装v8案を維持**し、旧v7からの移行で `offline_queue.enabled=false` と `ttl_minutes=1440` を補う。Q12版の旧草案にある `enabled=false, ttl_minutes=null` は移行時に警告付きで1,440へ正規化する。`enabled=true` と `null` の組み合わせはエラーとして停止。旧依頼や既存の `worker_offline` エラーを自動キュー化しない。`worker.json` v2案には新規設定キーを追加しない。通信proto2案は期限フィールドと配送状態を拡張する（未実装）。
3. `pm_send` と WebChatの `thread_direct_send` だけを期限付きVPSキュー対象とする。`approval_answer`／`terminal_answer`／`session_stop`／`session_interrupt`／設定等は対象外。
4. オフライン時の受付日時と `expires_at` をVPSのUTCで生成・保存し、同じIDの投稿リトライでは元の有効期限を再利用する（リトライで期限を延長しない）。
5. 再接続後は送信直前に許可投稿者・チャンネル・WebChat所有権・対象案件／セッションを再認可し、期限切れ／対象消失／認可取消なら配送しない。Mac側もチャネル投入直前に失効検査する。
6. VPS再起動時に待機キューと失効状態を復元。`expired` を1回だけ確定し、通知は元の返信先が許可される場合に限る。送信先が無効ならWebChatの状態履歴に残し、Discord DMへ代替しない。
7. 保留上限では古い依頼を破棄せず `queue_full`。本文と秘書チャットの機微情報は共通案件台帳に混ぜず、限定権限のキューファイルに置く。保存期間・暗号化は本番前の別判断事項。
8. 現在の `max_pending_per_worker=100` は容量の設計仮値であり利用者が選択したものではない。**TTLの設定値はQ13/Cで確定済み**で、キュー容量・負荷は実測して検証する。


## 21. Q14/B のFIFO配送・並列実行・排他方針（設定と受入条件）

- **確定ルール（既定）:** ワーカーごとのオフライン依頼は `accepted_at`、同一時刻なら `operation_id` の順でFIFO配送する。Q12で既に保存する不変ID・受付時刻を使うため、今回のための新たな `hub.json` 設定キーは増やさない。再起動や再送で順番を変更しない。
- **並列上限:** Mac側の既存 `max_sessions=4` はPMを含む**起動セッション数上限**であり、同時書込数・CU同時数とは別。タスク開始前にはワーカーデーモンが資源利用条件を判断する。先にMacが依頼を受理したからといって安全な並列実行を保証しない。
- **CU制約:** MacあたりCU所有セッションは最大1（固定の必須安全条件）。待機中は `resource_wait(cu_busy)` とし、所有セッション終了・純正CU占有解放の確認が必要。CUを呼べる他セッションを技術的に抑止できるかは検証事項。検証不成立のときはCUを並列可と表示せず直列運用に縮退する。
- **編集領域:** 実体パスの重複がある書込可能セッション（案件PMを含む）は、Q15/Bにより**共有フォルダ・単一ライター**を確定。新たなworktreeや専用ブランチを生成しない。Q16/Aでは作業完了と安全確認後の自動返却を採用。OS・ツール・プロセスで書込経路を強制的に制限し続けられるかは今後検証する。読み取り専用と確実に制限できないセッションを単に `read_only` と宣言するだけでは並列実行を許可しない。
- **状態と永続化:** ハブの `offline-requests.jsonl` とワーカーの `inbound-commands.jsonl` で受理順・資源待機・期限切れを再構築し、Mac側にCU所有者と編集領域の資源待機を復元できるローカル状態を追加する（保存形式は実装時に確定）。`worker_queued`／`resource_wait` は**チャネル投入済みではない**ため、受付24時間のTTL検査を続ける。
- **バージョン:** 設定キーは増やさず **hub.json v8案・worker.json v2案のまま**。Q14/Bの資源状態は既存の未実装通信 `proto=2` 案に追記する。Q15/Bは固定安全規約として設定キーを増やさず、ロック状態はランタイム台帳へ保存する。Q16/Aの作業単位自動解放は新しい利用者設定キーを増やさず、同じスキーマ案を維持する。

**受入:** 保留依頼4件のFIFO、独立した複数案件の並列実行、PMと子による同一作業領域への同時書込の拒否、CU競合待ちと所有者復元、待機中のTTL失効、未知資源状態でのfail-closed、UI上の待機理由表示を自動／Mac実機で試験する。**本項は未実装の設計要件。

## 22. Q15/B の共有フォルダ・単一ライター制御（確定方針と受入条件）

- **選択:** Q15はB。「案件PMと子は `projects[].path` の同一実体作業フォルダを共有し、同時に書込可能なセッションを最大1つにする」。Git worktree・子ごとのブランチ・作業用コピーはHanniganの標準機構として新設しない。Gitの有無は問わない。PMが他の作業成果物を同じフォルダから閲覧する。
- **競合単位:** `projects[].path` の `realpath` と包含関係で判定。同じ案件IDだけでなく、別IDでも実体パスが同じ／重なるなら同じ排他ドメインとして扱う。別の非重複作業フォルダはQ14/Bの条件下で並列実行を認める。
- **強制条件:** PM自身のEdit/Write/Bashと子の同種ツール、シェル・子プロセス・外部書込経路にも適用。読取専用として並走させるには、ツール制限やOS権限を実機で確認したうえで全書込経路を封じる必要がある。**指示文による禁止、一般的なロックファイルだけでは強制力を保証しない。**未実証時は同じ作業フォルダで書込可能なClaude Codeセッションを並行稼働させない。
- **管理状態:** 書込枠はMacデーモン側の永続ランタイム情報（例: `worker/resource-leases.json`／追記イベント）として所有セッション・実体パス・待機依頼IDを保持する。これはユーザーが書き換える設定項目ではない。`resource_wait(workspace_busy)` と `resource_unknown` をWebChatで区別して表示する。
- **ロック解除（Q16/A確定）:** 完了した作業単位の書込が停止し、旧所有セッションの書込権を技術的に剥奪したと確認できたら自動解放する。セッションID・会話履歴は維持し、次の書込時に再取得。不明なら `resource_unknown` で待機する。Q13/Cの24時間はブリッジ未投入の指示に限り継続する。
- **スキーマ版:** Q15/BをHanniganの固定安全方針として定義するため、新しい `worker.json` 設定キーを増やさず、**hub.json v8案・worker.json v2案・通信proto2案を維持**。UIはロックの状態を表示するが、今回新しい利用者切替設定や承認画面は追加しない。

**受入試験:** 同じフォルダでPM・子が参照できること、片方の書込中にもう片方のEdit/Write/Bashとバックグラウンド書込が成功しないこと、PM↔子の委任時に同時ライターを作らないこと、別パスやシンボリックリンクでも正しい競合判定、未確認資源状態のfail-closed、別案件の安全な並列、資源待ち中の24時間TTL、再起動時の書込所有者復元。**実装／実測は未完了。****

## 23. Q16/A の作業単位自動解放（設定方針と受入条件）

- **選択:** Q16はA。書込権をClaude Codeセッション終了まで維持するのではなく、作業完了＋全書込停止＋旧所有者の書込不能化を検証したら、自動返却する。これを全案件共通の安全不変条件とし、運用者が手動／無検証解放モードを選ぶ設定キーは追加しない。
- **セッション維持:** Q2・Q3の案件PMと子セッションは会話UUID・履歴を保持したまま、書込権の `held → release_pending → released` を遷移する。次の編集依頼であらためて書込枠を取得する。`reply` や `ready` の文字列だけでは `released` にしない。
- **永続状態:** 所有者、正規化作業領域、現在作業ID、世代番号、解除進行状態と検証結果をデーモンの `worker/resource-leases.json` 等に保持する。これは `worker.json` の設定値ではなくランタイム記録であり、変更時に監査イベントを出す。
- **既存版の維持:** 新しい公開設定キーを設けないため **hub.json v8案／worker.json v2案／通信proto2案を維持**。新しい資源状態イベントはproto2の既存 `event` の `kind` 拡張として扱う。未対応コードでは接続時に機能対応を照合し、書込制御を黙って無効化しない。
- **安全な縮退:** Mac上で全書込経路の剥奪を強制できない場合、セッションを生かしたままロックを渡す動作は許可しない。フォルダの直列稼働、必要に応じたセッション停止・履歴再開などの案は別途検証する。ユーザー入力による危険なロック強制解放設定は追加しない。
- **既存要件:** Q11/Aの追加着手承認なし、Q13/Cの未投入指示に対する24時間期限、Q14/BのFIFO受理・CU排他、Q15/Bの共有フォルダ・単一ライターをすべて維持する。書込権の返却は純正CUの占有解放を意味しない。

**追加受入試験:** PM→子→PMの書込権が自動で移り、同じClaude会話を再開できること。未完了ツール／非同期処理中は解放されず、作業後は旧所有者が再取得せず書き込めないこと。デーモン再起動・権限剥奪失敗時の `resource_unknown`、未投入依頼の期限確認と、`resource_lease_state` の表示を確認する。実装・実測は未完了。

## 24. Q17/B の安全な自動復旧（設定方針と受入条件）

- **固定方針:** 書込権所有者のハング／異常終了では、Macデーモンが安全な状態再照合・既存ブリッジ再接続・実体パス／プロセス／権限の検証を自動試行する。**安全を立証できない限り `resource_unknown` に保持し、WebChatへ要確認通知を出す。自動強制終了はしない。**
- **利用者設定:** 本判断では自動kill、強制ロック解放、未検証のロック奪取を有効化する設定キーは設けない。再検証の状態・理由・最終確認時刻・異常IDは `worker/resource-leases.json` 等のランタイム記録へ保存する。**hub.json v8案／worker.json v2案／通信proto2案を維持**する。
- **通知:** ワーカーで確定した資源状態を既存 `resource_lease_state` イベントで伝え、VPSはWebChatの認可済み管理画面へ未解決アラートを耐久表示する。Discordへの自動詳細転送や新しいDiscord操作権限は追加しない。
- **既存条件の維持:** Q13/Cの未投入指示の24時間TTL、Q14/Bの並列化とCU排他、Q15/Bの単一ライター、Q16/Aの安全確認後自動解放、Q11/Aの着手承認を追加しない方針は不変。時間経過、ハブ切断、モデルの完了宣言を安全解放の代用にしない。
- **未決定:** 異常通知を受けた人間がWebChatからどこまで復旧操作できるか（Q18）、再検証のトリガー頻度・検証タイムアウトなどの実装上の既定値。これらを本問で選択したものとはみなさない。

**受入試験:** 異常セッション消失後の安全な証跡付き解放、ハング中の非解放、デーモン再起動・ブリッジ切断・子プロセス残存時のfail-closed、異常の永続通知と重複排除、権限喪失時の書込拒否、待機TTLとCU占有の独立性を検証する。macOS実機の強制力は未検証。

## 25. 設定画面と設定 API（Phase 3 最小）

Phase 5 の設定画面のうち、7 日間の日常運用（Phase 3 の出口条件 6）に要る部分だけを前倒しで作った。WebChat の「設定」ボタンで開く。1 章の方針どおり **設定ファイルが正** で、画面はハブ経由で `hub.json` と `worker.json` を読み書きする道具にとどまる。ファイルを直接編集しても同じように動く（その場合は従来どおり再起動で反映）。

**画面から変えられる項目と反映の時期**

| ファイル | 項目 | 反映 |
| --- | --- | --- |
| hub.json | `secretary.contexts.max_active` | すぐ。次に秘書を起動するときの上限になる。下げても動いている秘書は止めない |
| hub.json | `secretary.contexts.idle_minutes` | すぐ（次の放置確認から） |
| hub.json | `offline_queue.enabled` / `ttl_minutes` / `max_pending_per_worker` | すぐ。新しく受け付ける依頼から。保留中の依頼の `expires_at` は変えない（Q13/C） |
| hub.json | `workers[].display_name` / `workers[].role` | 画面の表示はすぐ。秘書の指示文には次に秘書が起動したときに入る |
| hub.json | `secretary.persona.*`、`secretary.routing_notes`、`secretary.extra_instructions`（3.1 節。2026-10-17 追加） | 名前は画面の表示にすぐ。指示文には次に秘書が起動したとき（再開を含む）に入る。`GET /api/settings` は次に起動する秘書に渡る指示文の全文を `instructions_preview` で返し、画面でプレビューできる |
| worker.json | `projects[]`（`id`、`path`、`description`、`pm.enabled`、`pm.execution_policy`、`pm.extra_instructions`） | すぐ。新しい依頼から使える。動いている PM の指示文（説明・進め方・追加指示）は、その PM を止めて次に起動したときに入る |

`pm.autostart` は画面に出さない（未実装のため）。秘書の `session`（起動条件、モデル）は引き続き画面から変えない。画面が送らない項目は今の値を引き継ぐ。

**画面から変えられない項目**: `listen`、`public_url`、秘密情報（`secrets/` の WebChat トークン、ワーカー鍵など）、ワーカーの追加と削除（鍵の発行を伴うため）、`discord.*`、セッションの起動条件（`session` / `pm_session` / `secretary.session`）、`max_sessions` などその他の項目。ハブはこれらを含む要求を項目名つきで断る。変えるときはファイルを編集して再起動する。

**API**（すべて WebChat トークンの認証つき）

| 経路 | 内容 |
| --- | --- |
| `GET /api/settings` | `hub`（上の hub.json の項目と各ワーカーの接続状態）、`worker_projects`（ワーカーごとの案件と PM 設定。接続中のワーカーには `list` を送って案件フォルダも取る）、`paths_known`（フォルダを取れたワーカー）、`fixed`（`listen`・`public_url`・秘密情報。`editable: false`。2026-10-18 からハブの Mac の `hostname` も返し、画面の「2 台目の Mac をつなぐ（手順）」の SSH トンネルの例に使う。記録には残さない） |
| `POST /api/settings/hub` | 上の hub.json の項目だけを受け付ける。今の `hub.json` の JSON に差分を書き込み、起動時と同じ検証（`HubConfigSchema` と `checkHubConfig`）を通してから原子的に書き込み、動いているハブに反映する。返り値 `{ ok, changed, applies: { now, next_secretary_start, restart }, settings }` |
| `POST /api/settings/worker` | `{ worker, projects }`。ハブはワーカーへ命令 `config_set`（03 §2.3）を送り、結果をそのまま返す。ワーカーが未接続なら `worker_offline` で断る。オフライン保留はしない |

変更が成功すると、ハブは出来事 `settings_changed`（`scope: hub | worker`、変わった項目名や案件 ID だけ。値や秘密は入れない）を記録し、画面の在庫表示を更新する。

**fail closed の規則**

- 書き込む前に全体を検証する。どこかが不正なら何も書かず、どの項目・どの案件・どのフォルダが、なぜ駄目かを日本語で返す
- 案件のフォルダは `/` か `~` で始まる場所に限る。ワーカーがリンクを解決した実体の場所（`loadWorkerConfig` と同じ）に直して保存する。存在しないフォルダ、ファイル、ID の重複、同じフォルダや入れ子のフォルダ（22 章の単一ライターの前提）は断る
- **動いているセッション（PM または子。`stopped` / `exited` / `failed` 以外）がある案件の削除とフォルダ変更は `project_in_use` で断る**。どのセッションが動いているかを返すので、スレッド一覧で停止してからやり直す。PM 設定や説明の変更は動いていても受け付ける
- 削除した案件や、フォルダを変えた案件の古い停止済みセッションは再開しない（古いフォルダはもう書込権で守られていないため）。PM への次の依頼では新しいフォルダで新しい PM を作る
- 案件は書込権の対象一覧（ワーカーの `worker/workspaces.json`）にもすぐ反映する
- ワーカーへの命令が期限切れになったときは、保存されたかどうか分からない旨を返す。画面を開き直すと最新の在庫が表示される

**案件フォルダの扱い**: Mac のローカルの場所はハブの記録に残さない（従来からの約束）。ワーカーは案件フォルダ（`path`）を命令 `list` と `config_set` の返り値にだけ載せ、出来事 `inventory` には載せない。ハブはフォルダを設定画面への応答にだけ使い、在庫の保持、出来事の記録、秘書のツールには渡さない。ホームフォルダの下は `~/…` の形で送るので、利用者名は Mac の外に出ない。ワーカーがオフラインの間はフォルダを表示できないが、その間は案件の編集もできないので困らない。Phase 4 で VPS 上のハブに移すときは、ホーム外のフォルダの場所が VPS を通ることを 9 章の確認項目に加えて見直す。

**初回起動**: `scripts/start.sh` は `hub.json` か `worker.json` がないとき `scripts/dev-setup.ts --worker local --name "この Mac"` を実行する。案件は空のまま作るので、利用者は WebChat の設定画面で案件を足す。既にあるファイルは残す。 `scripts/start.sh worker` だけを使う 2 台目の Mac（8.1 節）は `worker.json` と `secrets/worker-key` があれば初期設定を作らず、`hub.json` を要らない。
