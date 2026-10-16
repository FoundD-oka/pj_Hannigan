# 01 設定スキーマ

作成日: 2026-10-13
状態: Phase 1 確定版（Phase 2 の実装はこの版に従う）
関連: [00 全体アーキテクチャ](00-architecture.md)、[02 ワーカー常駐プログラム](02-worker-daemon.md)、[03 ハブとワーカー間の通信](03-hub-worker-protocol.md)

## 1. 方針

- 設定ファイルを唯一の正とする。設定画面（Phase 4）はこのファイルを読み書きする道具で、ファイルを直接編集しても同じように動く
- 利用者ごとに変わる値（ポート、フォルダ、ワーカー名、役割の説明、承認方針）はすべて設定ファイルに置く。コードには「設定が省略されたときの既定値」だけを置き、既定値はこの文書の表に載せる
- 秘密情報は設定ファイルに書かない。`secrets/` フォルダ（権限 700）の中に 1 値 1 ファイル（権限 600）で置く
- 読み込み時に zod で検証し、不正な値があれば起動を止めて項目名を表示する。未知の項目は警告だけ出して無視する（新しい版の設定を古い版で読んでも止まらないため）
- 各ファイルに `version` を持たせ、形を変えるときは版を上げて移行処理を書く

## 2. 保存場所

設定の根フォルダは環境変数 `HANNIGAN_HOME` で決める。省略時は `~/.hannigan`。

```text
$HANNIGAN_HOME/
├── hub.json                ハブの設定（ハブ Mac のみ）
├── worker.json             ワーカーの設定（作業 Mac のみ。ハブ Mac がワーカーを兼ねてもよい）
├── secrets/                権限 700
│   ├── webchat-token       WebChat のアクセス用トークン（ハブ）
│   ├── local-bridge-token  同じ Mac の中でチャネル中継とデーモンをつなぐトークン（ハブ、ワーカーで別の値）
│   ├── worker-keys.json    ハブが受け入れるワーカーの鍵 { "<worker_id>": "<key>" }（ハブ）
│   └── worker-key          自分の鍵（ワーカー）
├── hub/                    ハブの実行時状態（events.jsonl、秘書セッションの記録）
├── worker/                 ワーカーの実行時状態（sessions.json、outbox.jsonl、bridge-*.json）
└── secretary/              秘書 Claude の作業フォルダ（hub.json で変更可）
```

ハブとワーカーを同じ Mac で動かすときは、1 つの `HANNIGAN_HOME` に両方のファイルが並ぶ。
`local-bridge-token` はハブ用を `secrets/local-bridge-token.hub`、ワーカー用を `secrets/local-bridge-token.worker` として分ける。

## 3. hub.json

| 項目 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `version` | `1` | 必須 | 設定の版 |
| `listen.host` | string | `127.0.0.1` | WebChat とワーカー接続を受ける住所。別端末から使うときだけ変える |
| `listen.port` | int | `8800` | 同上のポート |
| `public_url` | string \| null | `null` | WebChat の URL 表示に使う。省略時は `http://<host>:<port>` |
| `secretary.project_dir` | string | `$HANNIGAN_HOME/secretary` | 秘書 Claude を起動するフォルダ。会話履歴はこのフォルダに紐づく |
| `secretary.autostart` | bool | `true` | ハブ起動時に秘書セッションも起動する |
| `secretary.session` | object | 下表 | 秘書セッションの起動条件（4 章の共通形式） |
| `secretary.extra_instructions` | string | `""` | 秘書への追加指示。チャネルの `instructions` の末尾に足す |
| `workers` | array | `[]` | 秘書に教えるワーカーの一覧（下表） |
| `workers[].id` | string | 必須 | ワーカー ID。`worker.json` の `worker_id` と一致させる。英数字、`-`、`_` で 1〜32 文字 |
| `workers[].display_name` | string | id と同じ | WebChat と秘書への表示名 |
| `workers[].role` | string | `""` | 役割の説明文。秘書が振り分けに使う（例: 「仕事用。会社のリポジトリはこちら」） |
| `log.max_events_replay` | int | `2000` | WebChat 再接続時に再生する最大件数 |

`secretary.session` の既定値は次のとおり。秘書は振り分けだけを行うので、組み込みツールを持たせない。

| 項目 | 既定値 |
| --- | --- |
| `permission_mode` | `manual` |
| `builtin_tools` | `""`（組み込みツールなし。`--tools ""` を渡す） |
| `allowed_tools` | `["mcp__hannigan"]`（ハブのツールは承認なしで呼べる） |

## 4. worker.json

| 項目 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `version` | `1` | 必須 | 設定の版 |
| `worker_id` | string | 必須 | ハブの `workers[].id` と一致させる |
| `hub_url` | string | `ws://127.0.0.1:8800/ws/worker` | ハブの接続先。Phase 3 で別 Mac の住所に変える |
| `local.host` | string | `127.0.0.1` | チャネル中継の接続を受ける住所。外へは開けない |
| `local.port` | int | `8801` | 同上のポート |
| `projects` | array | `[]` | このワーカーで使えるプロジェクト |
| `projects[].id` | string | 必須 | 秘書が指定する名前。英数字、`-`、`_` で 1〜32 文字 |
| `projects[].path` | string | 必須 | 絶対パス。`~` は展開する |
| `projects[].description` | string | `""` | 秘書への説明 |
| `session` | object | 下表 | 作業セッションの起動条件（共通形式） |
| `max_sessions` | int | `4` | 同時に動かせるセッション数 |
| `tmux.prefix` | string | `hn` | tmux セッション名の先頭。`<prefix>-<project>-<短い ID>` になる |
| `tmux.width` / `tmux.height` | int | `160` / `48` | tmux 画面の大きさ。画面読み取りの安定のため固定する |
| `claude_bin` | string | `claude` | Claude Code の実行ファイル。試験では偽物に差し替える |
| `bun_bin` | string | `bun` | チャネル中継を動かす Bun の実行ファイル |
| `outbox.max_events` | int | `5000` | ハブへ未送信の出来事を保持する上限 |

### 4.1 セッションの起動条件（共通形式）

秘書（hub.json の `secretary.session`）と作業セッション（worker.json の `session`）は同じ形を使う。

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

## 5. 秘密情報

| ファイル | 置く場所 | 中身 | 作り方 |
| --- | --- | --- | --- |
| `webchat-token` | ハブ | 32 バイトの乱数（16 進） | 導入 CLI（Phase 4）か `scripts/dev-setup.ts` が生成 |
| `local-bridge-token.hub` / `.worker` | 各 Mac | 同上 | 起動時に無ければ生成 |
| `worker-keys.json` | ハブ | ワーカー ID と鍵の対応 | Phase 2 は `dev-setup` が生成。Phase 3 からペアリングで追加 |
| `worker-key` | ワーカー | 自分の鍵 | 同上 |

- フォルダは 700、ファイルは 600 で作る。読み込み時に権限が緩ければ警告する
- 秘密情報はログ、出来事の記録、エラーメッセージ、`ps` に出る引数に載せない。チャネル中継へはファイルの場所だけを環境変数で渡す
- 将来 OS のキーチェーンに移せるよう、読み書きは `shared/secrets.ts` の 1 か所に閉じ込める

## 6. ペアリング（Phase 3 で実装、形だけ確定）

1. 利用者が WebChat の設定画面で「ワーカーを追加」を押す。ハブが 8 桁の一時コード（10 分有効、1 回限り）を発行する
2. 作業 Mac で `hannigan pair <hub_url> <code>` を実行する。ワーカーが一時コードと自分の `worker_id` をハブへ送る
3. ハブがコードを確かめ、新しい鍵を生成して `worker-keys.json` に追記し、ワーカーへ返す。ワーカーは `worker-key` に保存する
4. 以後の接続は鍵で認証する。鍵の取り消しはハブの `worker-keys.json` から消すだけで済む

Phase 2 ではペアリングを作らず、`scripts/dev-setup.ts` が同じ Mac の上で両方の鍵ファイルを書く。

## 7. 設定に入れないもの

次の値は Claude Code 側の準備で、ハブやワーカーの設定からは変えられない。導入 CLI（Phase 4）が書き込み、設定画面は状態の表示だけを行う。

- Claude Code へのログイン、組織の `channelsEnabled` 方針
- 純正 Computer Use の有効化（`/mcp`）と macOS の権限（アクセシビリティ、画面収録）
- ユーザー設定のフック、出力スタイル、CLAUDE.md（作業セッションにもそのまま効く）

## 8. 例（同じ Mac でハブとワーカーを動かす）

```json
// $HANNIGAN_HOME/hub.json
{
  "version": 1,
  "listen": { "host": "127.0.0.1", "port": 8800 },
  "workers": [
    { "id": "home", "display_name": "自宅 Mac", "role": "私用。個人の開発と調べもの" }
  ]
}
```

```json
// $HANNIGAN_HOME/worker.json
{
  "version": 1,
  "worker_id": "home",
  "projects": [
    { "id": "notes", "path": "~/work/notes", "description": "メモと下書き" }
  ],
  "session": { "terminal_prompts": { "dev_channel_warning": "relay" } }
}
```
