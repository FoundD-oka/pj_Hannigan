# S2 スパイク: トランスクリプト・アダプター（ネイティブ会話記録から WebChat 履歴を作る）

- 実施日: 2026-10-16
- 対象: Claude Code v2.1.301（`claude --version` で確認）。比較用に既存記録 v2.1.296（Phase 2 E2E）と v2.1.300 も構造だけ確認した
- 関連設計: `docs/design/00-architecture.md` §4.1.2「表示できる履歴の範囲」、`docs/design/02-worker-daemon.md` §3.7、`docs/design/01-config-schema.md` の `thread_observation.{mode, redact_sensitive}`
- 方法: `~/.claude/projects/` 配下の記録を、キー名・`type` の値・件数だけ数える形で調べた。利用者の私的な会話本文は表示も複製もしていない。v2.1.301 の挙動は、検証用の作業ディレクトリで `claude -p --model haiku` を 2 回（新規 1 回、`--resume` 1 回）実行して確認した

## 1. 結論

**v2.1.301 で成立する。ただし公式に「形式は内部仕様で版ごとに変わる」と明記されているので、版を固定した受入試験とフォールバックを前提にする。**

ワーカーデーモンは、PM／子セッションのネイティブ記録 `<session-id>.jsonl` を追記監視して、次の 4 種類を WebChat のスレッド項目に変換できる。

- Hannigan のチャネル経由で届いた指示（`origin.kind = "channel"` で判別できる）
- Claude の途中の発言（assistant の `text` ブロック）
- ツール呼出しの概要（ツール名と入力の短いプレビュー）
- ツール結果の先頭部分（切り詰めたもの）

思考ブロック（`thinking`）は記録に残るが、アダプターで捨てる。記録への追記は 1 ブロックずつ行われ、実測の遅れは 1 秒以内だった（1 秒間隔の観測による上限値）。`--resume` は同じファイルに追記を続けた。

WebChat が正直に表示できる範囲は次のとおり。

| 表示できる | 表示しない・できない |
| --- | --- |
| チャネル経由の指示本文、端末で直接打たれた指示 | 思考過程（`thinking`）。要件外で、記録上も署名付きの別ブロック |
| Claude の途中発言と最終発言 | サブエージェント内部の発言（別ファイル。今回は対象外） |
| ツール名、入力プレビュー（300 字）、結果の先頭（500 字）、エラーかどうか | 大きなツール出力の全文、画像。ファイル側の保存先に逃がされた出力 |
| 圧縮（compact）が起きたこと | 圧縮前の内容を再取得すること（記録には残るが表示対象外にする） |

PoC パーサー（付録 A）は、Phase 2 E2E の task セッション記録（v2.1.296、Hannigan チャネル使用）と v2.1.301 の試験記録の両方を、解析エラー 0 件で変換できた。

## 2. 記録の場所と形式

### 2.1 置き場所とフォルダ名の規則

公式資料の記述（Manage sessions「Where transcripts are stored」、2026-10-16 取得）を引用する。

```text
By default, Claude Code stores transcripts as JSONL at ~/.claude/projects/<project>/<session-id>.jsonl,
where <project> is your working directory path with non-alphanumeric characters replaced by -.
For a working directory whose converted name exceeds 200 characters, Claude Code truncates the name
to 200 characters and appends a hash of the full path
```

この Mac で実測した。38 個の project フォルダについて、記録内の `cwd` に `cwd.replace(/[^A-Za-z0-9]/g, "-")` を当てた結果がフォルダ名と全件一致した（不一致 0 件）。`/`、`_`、`.`、空白、日本語 1 文字はいずれも `-` 1 文字になる。

```text
/Volumes/<vol>/<path>/pj-Hannigan
  -> -Volumes-<vol>-<path>-pj-Hannigan
/private/tmp/claude-501/-Volumes-.../scratchpad/s2/work_dir.v1
  -> -private-tmp-claude-501--Volumes-...-scratchpad-s2-work-dir-v1
/Users/<user>/Desktop/<日本語9文字>
  -> -Users-<user>-Desktop---------
match 38 mismatch 0 max folder len 151
```

200 字を超える場合の切り詰めとハッシュは、手元に該当フォルダがなく未検証。フォルダ名の衝突（`a_b` と `a-b` が同じ名前になる）も起こり得る。そこで、パスの組み立てに頼らない探し方を推奨する（6 章）。

フォルダ内の構成は次のとおり。

```text
~/.claude/projects/<project>/
  <session-id>.jsonl                  会話記録本体（権限 600）
  <session-id>/tool-results/          大きなツール出力の退避先
  <session-id>/subagents/agent-*.jsonl, agent-*.meta.json   サブエージェントの記録（別ファイル）
  memory/                             auto memory
```

### 2.2 行の種類（v2.1.301 試験記録、57 行）

1 行が 1 つの JSON。`type` で種類が決まる。

```text
types {'queue-operation': 4, 'user': 4, 'attachment': 20, 'atis-latch': 4, 'api-request-shape': 1,
       'api-request-blob': 5, 'api-request': 4, 'last-prompt': 4, 'assistant': 8, 'cost-state': 2, 'mode': 1}
```

この Mac の全記録（v2.1.219〜2.1.300）で見つかった `type` は 24 種類あった。

```text
attachment, assistant, user, last-prompt, atis-latch, mode, bridge-session, ai-title, queue-operation,
system, permission-mode, api-request-blob, pr-link, api-request, file-history-snapshot, file-history-delta,
custom-title, agent-name, artifact-autoreact-ledger, cost-state, frame-link, artifact-comment-monitor,
api-request-shape, fork-context-ref
system の subtype: stop_hook_summary, turn_duration, away_summary, local_command, informational,
                   compact_boundary, bridge_status
```

`api-request` / `api-request-blob` / `api-request-shape` は v2.1.300 以降に現れた新しい行で、API に送ったリクエスト本文の断片を含む。中に `text`・`tool_use`・`thinking` と同じ形のブロックがあるので、`type` で除外しないと発言が二重に出る。`turnOrigin` も v2.1.280 から現れた。版ごとに形が変わる実例として扱う。

### 2.3 会話行のフィールド

`user` / `assistant` 行の共通キー（v2.1.301）を示す。

```text
user:      cwd, entrypoint, gitBranch, isSidechain, message, parentUuid, permissionDecision, permissionMode,
           promptId, promptSource, sessionId, sourceToolAssistantUUID, timestamp, toolUseResult, turnOrigin,
           turnPosition, type, userType, uuid, version
           （v2.1.296 のチャネル行には origin, isMeta, session_id も付く）
assistant: advisorModel, apiBlockIndex, cwd, effort, entrypoint, gitBranch, isSidechain, message, parentUuid,
           perTurnEffort, requestId, requestRef, requestedModel, sessionId, thinkingDisplay,
           thinkingDurationMs, timestamp, type, userType, uuid, version, wireToolInputs
assistant.message: container, content, context_management, diagnostics, id, input_transformations, model,
           role, stop_details, stop_reason, stop_sequence, type, usage
```

- `uuid` は行ごとに一意で、`parentUuid` が直前の行を指す。`--resume` 後の最初の user 行も `parentUuid` を持ち、鎖がつながる
- `timestamp` は ISO 8601（UTC、ミリ秒付き）
- assistant の応答は **1 コンテンツブロックにつき 1 行** で書かれる。同じ `message.id` を持つ行が `thinking`、`text`、`tool_use` と並ぶ

v2.1.301 試験記録の該当部分を、本文を伏せて示す。

```text
行 type        timestamp(UTC)            content blocks   message.id
3  user        2026-10-15T23:44:55.450Z  str              -          promptSource=sdk
23 assistant   2026-10-15T23:44:57.086Z  [thinking]       msg_011C…
24 assistant   2026-10-15T23:44:57.187Z  [text]           msg_011C…
25 assistant   2026-10-15T23:44:57.542Z  [tool_use]       msg_011C…
26 user        2026-10-15T23:45:06.189Z  [tool_result]    -
33 assistant   2026-10-15T23:45:07.360Z  [text]           msg_011C…
--- ここから --resume（同じファイル、同じ sessionId）---
38 user        2026-10-15T23:45:15.197Z  str              -          parentUuid あり
44 assistant   2026-10-15T23:45:16.656Z  [text]
45 assistant   2026-10-15T23:45:16.899Z  [tool_use]
46 user        2026-10-15T23:45:25.271Z  [tool_result]
52 assistant   2026-10-15T23:45:27.009Z  [thinking]
53 assistant   2026-10-15T23:45:27.022Z  [text]
```

### 2.4 ブロックの形

```text
assistant text      {type:"text", text:str}
assistant tool_use  {type:"tool_use", id:"toolu_…", name:str, input:dict, caller:{type:"direct"}}
assistant thinking  {type:"thinking", thinking:str, signature:str}
user tool_result    {type:"tool_result", tool_use_id:"toolu_…", content:str|list, is_error?:bool}
                    content が list のときの要素: text / tool_reference / image など
user 行の toolUseResult   ツール固有の構造化結果（Bash なら stdout, stderr, interrupted, isImage, noOutputExpected）
```

### 2.5 チャネル経由の指示は記録に残る

Phase 2 E2E の task セッション（v2.1.296、`3c9a5daf`、Hannigan チャネル `server: "hannigan"`）では、チャネル通知が user 行として記録されていた。本文は文字列で、`<channel …>…</channel>` に包まれている。

```text
5 queue-operation enqueue  content_head='<channel '
6 queue-operation dequeue
7 user  content=str '<channel source="…" kind="…" chat_id="…">…</channel>'
        isMeta=true  origin={"kind":"channel","server":"hannigan"}  promptSource="system"
        turnOrigin="peer"  userType="external"
```

この Mac の全記録で `origin` の値を集計すると、チャネル由来の行はすべて同じ形だった。

```text
21 ('2.1.296', '{"kind": "channel", "server": "hannigan"}',                isMeta=True, 'system', '"peer"')
 3 ('2.1.296', '{"kind": "channel", "server": "plugin:fakechat:fakechat"}', isMeta=True, 'system', '"peer"')
 5 ('2.1.296', '{"kind": "channel", "server": "spike"}',                   isMeta=True, 'system', '"peer"')
24 ('2.1.296', '{"kind": "channel", "server": "webchat-test"}',            isMeta=True, 'system', '"peer"')
端末入力: origin={"kind":"human"}、promptSource="typed"|"queued"|"sdk"
バックグラウンド完了通知: origin={"kind":"task-notification", …}、promptSource="system"
```

注意点が 2 つある。1 つ目として、チャネル行は `isMeta=true` なので「isMeta は全部捨てる」と書くとチャネル指示が消える。判別には `origin.kind` を先に使う。2 つ目として、E2E のチャネル属性は `source`、`kind`、`chat_id` だけで、Hannigan の `msg_id` は入っていなかった。重複排除のために `msg_id` を属性に足すことを推奨する（6.4）。

チャネル付きセッションの記録は v2.1.296 のものしかない。v2.1.301 でチャネルを使った記録は取っていない（7 章）。

`docs/verification/claude-channels/evidence/transcript-tools-*.txt` は `prototype/webchat-test/tools/extract.py` で作った抜粋である。このスクリプトは `message.content` の文字列とブロックを USER_TEXT / ASSISTANT_TEXT / TOOL_USE / TOOL_RESULT に振り分けるだけで、`type`・`isMeta`・`origin` を見ない。そのため、スキル本文やローカルコマンドの出力も USER_TEXT として混ざる。v2.1.300 以降の記録では `api-request-blob` の中身も拾って二重に出る。アダプターは extract.py を流用せず、3 章の対応表で作り直す。

## 3. 対応表

| 記録の行・ブロック | 判定条件 | WebChat の項目 |
| --- | --- | --- |
| `user`、content が文字列、`origin.kind="channel"` | `<channel>` を外した本文、属性は別保持 | `user`（source=channel、server と属性つき） |
| `user`、content が文字列、`origin.kind="human"`、`isMeta` なし | 先頭が `<local-command-` `<command-name>` などでない | `user`（source=terminal。PM／子では通常まれ） |
| `user` の `text` ブロック（isMeta なし） | `[Request interrupted by user]` など | `user`（terminal）か状態表示。中断表示に回すとよい |
| `assistant` の `text` | すべて | `assistant` |
| `assistant` の `tool_use` | `name` と `input` | `tool_use`（ツール名、入力 JSON を秘匿処理して 300 字まで） |
| `user` の `tool_result` | `tool_use_id` で tool_use と対応、`is_error` | `tool_result`（500 字まで、画像などは `[image]` と表示） |
| `mcp__hannigan__reply` の tool_use / tool_result | Hannigan 側に正本の記録がある | 表示しないか、Hannigan の reply 記録に寄せる（6.4） |
| `system` の `compact_boundary`、user の `isCompactSummary` | 圧縮 | 本文は出さず「ここで圧縮」の区切りだけ出す（任意） |

捨てるもの:

- `assistant` の `thinking` / `redacted_thinking`（要件外。非公開の推論）
- `isSidechain=true` の行（サブエージェント。現行版は別ファイルに分かれる）
- `isApiErrorMessage=true` の assistant 行（状態表示に回すなら別扱い）
- `attachment`（環境情報、日付、指示文、ツール一覧、リマインダーなど 20 種以上）
- `queue-operation`、`last-prompt`（プロンプト本文の写しを含む。二重表示と漏えいの元）
- `api-request` / `api-request-blob` / `api-request-shape`（送信リクエストの断片。二重表示の元）
- `mode`、`permission-mode`、`atis-latch`、`bridge-session`、`cost-state`、`ai-title`、`custom-title`、`agent-name`、`file-history-*`、`pr-link`、`frame-link`、`artifact-*`、`fork-context-ref`
- `system` の残り（`stop_hook_summary`、`turn_duration`、`away_summary`、`local_command`、`informational`、`bridge_status`）
- `isMeta=true` かつ `origin.kind` が channel 以外の user 行（スキル本文、コマンド caveat など）
- 行内の `toolUseResult`、`wireToolInputs`（tool_use / tool_result と同じ内容の重複で、秘密値もここに写る）

方針は「既知の `type` とブロックだけを拾い、未知のものは捨てて件数を数える」とする。版が上がって新しい行が増えても誤表示にならず、件数の変化で形式の変化に気づける。

## 4. 遅延と再開の挙動

### 4.1 追記の遅延

v2.1.301 の `--resume` 実行中に、1 秒間隔でファイルの行数を観測した。

```text
08:45:14.658 35L   (resume 開始直後)
08:45:15.682 43L   user 行 38 (23:45:15.197Z) まで書かれている
08:45:17.760 45L   tool_use 行 45 (23:45:16.899Z) が書かれている。Bash の sleep 8 はまだ実行中
08:45:18〜25 45L   ツール実行中は増えない
08:45:26.085 51L   tool_result 行 46 (23:45:25.271Z) が書かれている
08:45:27.110 57L   最終 text 行 53 (23:45:27.022Z) まで書かれ、終了
```

tool_use はツール実行の完了を待たずに書かれ、各ブロックの `timestamp` から 1 秒以内にファイルへ出ていた。観測間隔が 1 秒なので、これより細かい値は測っていない。

公式の hooks 資料（2026-10-16 取得）は、遅れがあり得ると明記している。

```text
The transcript file is written asynchronously and may lag the in-memory conversation, so it may not yet
include the current turn's most recent messages when a hook fires.
```

アダプターは「数秒の遅れ」と「最後の行が書きかけ」の両方を前提にする。改行で終わる行だけを読み、残りは次回に回す。

### 4.2 再開・分岐・切り替え

| 操作 | 記録の扱い | 根拠 |
| --- | --- | --- |
| `--resume <id>`（fork なし） | 同じ `<id>.jsonl` に追記。`sessionId` 同じ、`parentUuid` の鎖も続く | 実測（v2.1.301） |
| `--session-id <uuid>` で起動 | ファイル名がその UUID になる | 実測（v2.1.301）。デーモン設計（02 §）と一致 |
| `--fork-session`、`/branch` | 新しいセッション ID、新しいファイル | 公式 sessions 資料 |
| `/clear` | 新しいセッションとして保存し直す（新しい ID とファイル） | 公式 sessions 資料。未実測 |
| `/cd` | 記録が新しいディレクトリ側の project フォルダへ移る | 公式 sessions 資料。未実測 |
| 圧縮（auto / `/compact`） | 同じファイルに `system/compact_boundary` と `isCompactSummary` の user 行が追記される | この Mac の記録で 12 件確認 |
| 同じセッションを 2 つの端末で再開 | 1 つのファイルに混ざって書かれる | 公式 sessions 資料 |
| 保存期間 | 既定 30 日で削除（`cleanupPeriodDays`） | 公式 data-usage / sessions 資料 |

ファイルの権限は `-rw-------`（所有者のみ）。デーモンが同じ OS ユーザーで動けば読める。

## 5. 秘匿処理

### 5.1 秘密値が入りうる場所

試験で、偽のトークン `ghp_FAKE…` を Bash コマンドに含めて実行した。その文字列が記録のどこに写ったかを数えた。

```text
1 queue-operation.content
1 user.message.content                       （指示本文）
1 api-request-blob.message.content[].text
3 last-prompt.lastPrompt
1 assistant.message.content[].input.command  （tool_use の入力）
1 assistant.wireToolInputs.<toolu_id>.command
1 user.message.content[].content             （tool_result）
1 user.toolUseResult.stdout
計 10 か所（grep の該当行は 8 行）
```

1 つの秘密値が最大 8 種類のフィールドに写る。3 章の方針で拾うのは「指示本文」「tool_use の入力」「tool_result」の 3 か所だけなので、秘匿処理はこの 3 か所に掛ければ足りる。残りは行ごと捨てる。

秘密値が入る典型例を挙げる。

- tool_use の入力: `curl -H "Authorization: Bearer …"`、`export X_TOKEN=…`、`gh auth token` の利用、`.env` を書く Write / Edit の本文
- tool_result: `env`・`printenv`・`set` の出力、`cat .env`、`cat ~/.config/...`、設定ファイルの Read 結果、エラーメッセージ内の URL クエリ
- 指示本文: 人がチャットに貼ったトークン
- assistant text: Claude が出力を引用した場合

### 5.2 推奨する処理

PoC（付録 A の `makeRedactor`）は次の順で置換する。

1. Hannigan 自身の秘密値の完全一致置換。`$HANNIGAN_HOME/secrets/` の各ファイルの値（8 文字以上）を起動時に読み、長い順に `[REDACTED:hannigan-secret]` へ置き換える
2. 既知のトークン形の正規表現。`sk-ant-…`、`gh[pousr]_…`、`github_pat_…`、`xox[abprs]-…`、`AKIA…`、`AIza…`、Discord Bot トークン、JWT（`eyJ…`）、PEM 秘密鍵ブロック
3. 文脈の正規表現。`Authorization: Bearer|Basic <値>` と、`*TOKEN*|*SECRET*|*PASSWORD*|*API_KEY*|*CREDENTIAL*` という名前の変数への代入（`=` か `:`）の値

試験結果を示す。偽トークンは変換後の項目に 0 件残り、`FAKE_TOKEN=[REDACTED]` に置き換わった（6 か所ヒット）。

```text
ghp_FAKE remaining in items: 0
   3 FAKE_TOKEN=[REDACTED]
```

追加の推奨事項は 4 つある。

- 秘匿処理は切り詰めの**前**に掛ける。先に切ると、途中で切れたトークンが正規表現に合わなくなる
- `Read` / `Write` / `Edit` の対象パスが `.env`、`secrets/`、`*.pem`、`id_*`、`~/.ssh/`、`~/.aws/` などに当たる場合は、入力と結果の本文を出さずに「秘匿対象ファイル」とだけ表示する
- 画像や base64 は本文に入れず `[image]` とする
- Hub 側でも同じ規則で再検査する（02 §3.7 の二重検査）。どちらも完全ではないので、`redact_sensitive` は「既知の形を除去する」機能として説明し、「秘密は漏れない」とは約束しない

## 6. 推奨する実装

### 6.1 置き場所

アダプターはワーカーデーモン内で動かす。対象は `role = pm | task` のセッション（秘書セッションは VPS 側で同じ部品を使える）。デーモンは記録を読むだけで、Claude Code へのキー入力や記録への書き込みはしない。

### 6.2 ファイルの見つけ方

デーモンは起動時に `--session-id <UUID>` を渡しているので、セッション ID は最初から分かっている。次の順で探す。

1. 第一候補: `~/.claude/projects/<encode(cwd)>/<session-id>.jsonl`（`encode = s.replace(/[^A-Za-z0-9]/g, "-")`。200 字を超えるときは公式のハッシュ規則があり未検証なので 2 へ）
2. 見つからなければ `~/.claude/projects/*/<session-id>.jsonl` を検索する。UUID は衝突しないので一意に決まる。`/cd` で移った場合もここで拾える
3. `CLAUDE_CONFIG_DIR` を使う構成ではその配下の `projects/` を探す。`CLAUDE_CODE_PROJECT_DIR_NAME` を使えばフォルダ名を固定できる（v2.1.234 以降、公式 sessions 資料）
4. 推奨の補強: Hannigan が起動するセッションに `--settings` で `SessionStart` フックを入れ、フック入力の `session_id` と `transcript_path` をデーモンへ知らせる。`/clear` やフォークで ID が変わっても追跡できる。公式に案内されている取得口なので、パス規則の変更にも強い（未実装・未実測）

### 6.3 追記の読み取り

- セッションごとに `(path, byteOffset, inode, size)` を状態ファイルに保存する
- `fs.watch` と数秒ごとのポーリングを併用し、`offset` から末尾まで読む。最後の `\n` までだけ処理し、残りは次回に回す（書きかけ行の対策）
- `size < offset` か inode が変わったら、ファイルが置き換わったとみなして先頭から読み直す。既に送った項目は重複キーで弾く
- JSON として読めない行は件数だけ数えて飛ばす
- 未知の `type` やブロックは捨てて件数を数え、版ごとの件数をデーモンのログに残す

### 6.4 重複排除

- 項目のキーは `entry_id = "${sessionId}:${uuid}:${blockIndex}"`。v2.1.301 では 1 行 1 ブロックだが、複数ブロックの行が来ても一意になる
- Hannigan の `reply` は Hannigan 側の記録を正本にする。記録上の `mcp__hannigan__reply` の入力は `{text}` だけで `msg_id` や `chat_id` を持たない（E2E で確認）。tool_use から確実に対応づける鍵はないので、アダプターはこの tool_use / tool_result を出さない設定を既定にする
- チャネル経由の指示も Hannigan の `thread_entry` が正本になる。Hannigan のチャネル通知の `meta` に `msg_id` を足すと、記録の `<channel … msg_id="…">` から `(session, source_message_id)` で照合できる。照合できた指示は「Claude の会話に取り込まれた」という確認として使い、本文は二重に出さない
- WebChat への送信は outbox に `entry_id` 付きで積み、Hub は `entry_id` で冪等に受ける

### 6.5 `thread_observation.mode` の意味

設定スキーマ（01 §）の現行定義は `transcript` / `reports_only` である。依頼文にあった `hannigan_only` はこの `reports_only` と同じ役割と読める。どちらの名前に揃えるかは設計側で決める。

| 値 | 意味 |
| --- | --- |
| `transcript` | 上記アダプターを動かし、3 章の対応表で変換した項目を Hannigan 自身の記録（指示、reply、状態、承認）と合わせて表示する。ファイルが見つからない、形式が想定外、Claude Code の版が試験済みでない、のいずれかでは `partial` / `unavailable` を WebChat に示す |
| `reports_only`（＝`hannigan_only`） | 記録ファイルを読まない。Hannigan が自分で観測した記録だけを表示し、「途中経過は取得していない」と画面に明示する |

追加で、試験済み版の一覧（例: `transcript_tested_versions: ["2.1.301"]`）を持つことを推奨する。各行の `version` が一覧外なら、変換は続けたうえで `partial` を表示し、ログに警告を出す。

## 7. 未検証事項

- v2.1.301 で、Hannigan チャネル経由の指示が同じ形（`origin.kind="channel"`、`isMeta=true`、`<channel>` 包み）で記録されるか。確認できたのは v2.1.296 まで
- 対話モード（tmux 内の常駐セッション）での追記遅延。今回の実測は `claude -p` だけ。E2E の記録は静的なので、書き込み時刻は測れていない
- 1 秒より細かい遅延、長い出力やストリーミング中の書き込み単位
- `/clear`、`/cd`、`--fork-session`、`/branch` での ID とファイルの変化（公式資料の記述のみ）
- 200 字超の cwd のハッシュ規則
- `SessionStart` フックで `transcript_path` を受け取る方式の実装と、チャネル付きセッションとの併用
- サブエージェントの記録（`subagents/agent-*.jsonl`）を子スレッドに含めるか。今回は対象外
- `tool-results/` に退避された大きな出力の扱い（記録側は先頭だけを含む）
- 秘匿処理の再現率。今回の試験は偽トークン 1 種類だけで、受入試験では代表的なトークン形と `env` 出力のコーパスで測る必要がある
- 公式は形式の安定性を保証していない。版を上げるたびに 2.2 と 3 章の集計を流し、未知の `type` が増えていないかを確かめる必要がある

## 8. 出典（2026-10-16 取得）

- Claude Code Docs「Manage sessions」 https://code.claude.com/docs/en/sessions
  - 保存先とフォルダ名の規則、200 字超のハッシュ、`CLAUDE_CODE_PROJECT_DIR_NAME`、`/clear`・`/branch`・`--fork-session`・`/cd`、`transcript_path` を使う案内
  - 形式について: 「The entry format is internal to Claude Code and changes between versions, so scripts that parse these files directly can break on any release. To build on session data, use `/export` or the script interfaces instead.」
- Claude Code Docs「Hooks reference」 https://code.claude.com/docs/en/hooks
  - 共通入力 `transcript_path` と、非同期書き込みによる遅れの注意
- Claude Code Docs「Data usage」 https://code.claude.com/docs/en/data-usage
  - 「Claude Code clients store session transcripts locally in plaintext under `~/.claude/projects/` for 30 days by default to enable session resumption. Adjust the period with `cleanupPeriodDays`.」
- ローカル実測: Claude Code v2.1.301、v2.1.300、v2.1.296 の記録（本文は伏せた）
- 既存資料: `prototype/webchat-test/tools/extract.py`、`docs/verification/claude-channels/README.md`、`docs/verification/claude-channels/evidence/transcript-tools-*.txt`

## 付録 A. PoC パーサー（bun / TypeScript）

試験時の場所は `/private/tmp/claude-501/-Volumes-<vol>-<path>-pj-Hannigan/b05bd651-95df-47b1-8246-c94500c1a57e/scratchpad/s2/transcript-adapter.ts`（一時領域）。実行は `bun run transcript-adapter.ts <transcript.jsonl> [既知の秘密値...]` で、件数だけを出力する。

実行結果（件数のみ）を示す。

```text
== 3c9a5daf (v2.1.296, Phase 2 E2E task セッション, Hannigan チャネル)
items 30  byKind {user:channel 5, assistant 8, tool_use 8, tool_result 8, user:terminal 1}
tools {Bash 3, ToolSearch 1, mcp__hannigan__reply 4}  truncated 2  badLines 0  tsMonotonic true
channelAttrKeys [source, kind, chat_id]
skip: thinking 1, attachment 48, queue-operation 10, system 4, user meta/command 3, ほか状態行
（user:terminal 1 件は "[Request interrupted by user]"）

== 14159d0f (v2.1.301, 試験セッション, -p + --resume)
items 10  byKind {user:terminal 2, assistant 4, tool_use 2, tool_result 2}
tools {Bash 2}  truncated 0  badLines 0  redactionHits 6  tsMonotonic true
skip: thinking 2, api-request-blob 5, api-request 4, api-request-shape 1, attachment 20, ほか状態行
```

```ts
// PoC: Claude Code transcript (.jsonl) -> WebChat thread items. Tested on CC 2.1.296-2.1.301.
import { openSync, readSync, fstatSync, closeSync } from "node:fs";

export type ThreadItem = {
  id: string;            // dedup key: `${sessionId}:${uuid}:${blockIndex}`
  ts: string;
  kind: "user" | "assistant" | "tool_use" | "tool_result";
  source?: "channel" | "terminal";
  channel?: { server?: string; attrs: Record<string, string> };
  tool?: string;
  toolUseId?: string;
  isError?: boolean;
  text: string;
  truncated?: boolean;
};

const MAX_TEXT = 4000, MAX_TOOL_INPUT = 300, MAX_TOOL_RESULT = 500;

const TOKEN_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\b[MN][A-Za-z\d_-]{23,25}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(Authorization:\s*(?:Bearer|Basic)\s+)[^\s"'\\]+/gi,
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]*\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"'\\]+)/gi,
];
export function makeRedactor(knownSecrets: string[]) {
  const vals = knownSecrets.map((s) => s.trim()).filter((s) => s.length >= 8).sort((a, b) => b.length - a.length);
  let hits = 0;
  const redact = (s: string): string => {
    for (const v of vals) if (s.includes(v)) { hits++; s = s.split(v).join("[REDACTED:hannigan-secret]"); }
    for (const re of TOKEN_PATTERNS) s = s.replace(re, (m, p1) => { hits++; return typeof p1 === "string" && m.startsWith(p1) ? p1 + "[REDACTED]" : "[REDACTED]"; });
    return s;
  };
  return { redact, hits: () => hits };
}

const cut = (s: string, n: number) => (s.length > n ? { text: s.slice(0, n) + "…", truncated: true } : { text: s, truncated: false });
const SKIP_USER_PREFIX = ["<local-command-", "<command-name>", "<command-message>", "<task-notification>", "<system-reminder>", "Base directory for this skill"];

function parseChannel(s: string) {
  const m = /^\s*<channel\s+([^>]*)>([\s\S]*?)<\/channel>\s*$/.exec(s);
  if (!m) return null;
  const attrs: Record<string, string> = {};
  for (const a of m[1].matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]] = a[2];
  return { attrs, body: m[2].trim() };
}

export type Stats = Record<string, number>;
export function convertLine(o: any, redact: (s: string) => string, stats: Stats): ThreadItem[] {
  const bump = (k: string) => (stats[k] = (stats[k] ?? 0) + 1);
  const t = o?.type;
  if (t !== "user" && t !== "assistant") { bump(`skip:type:${t}`); return []; }
  if (o.isSidechain) { bump("skip:sidechain"); return []; }
  if (o.isCompactSummary) { bump("skip:compact-summary"); return []; }
  if (t === "assistant" && o.isApiErrorMessage) { bump("skip:api-error"); return []; }
  const base = `${o.sessionId}:${o.uuid}`, ts = o.timestamp, c = o.message?.content, out: ThreadItem[] = [];
  if (t === "user" && typeof c === "string") {
    const origin = o.origin?.kind;
    if (origin === "channel") {
      const ch = parseChannel(c);
      const r = cut(redact(ch ? ch.body : c), MAX_TEXT);
      out.push({ id: `${base}:0`, ts, kind: "user", source: "channel", channel: { server: o.origin?.server, attrs: ch?.attrs ?? {} }, ...r });
      bump("emit:user:channel");
    } else if (o.isMeta || SKIP_USER_PREFIX.some((p) => c.trimStart().startsWith(p))) bump("skip:user:meta-or-command");
    else { out.push({ id: `${base}:0`, ts, kind: "user", source: "terminal", ...cut(redact(c), MAX_TEXT) }); bump("emit:user:terminal"); }
    return out;
  }
  if (!Array.isArray(c)) { bump("skip:no-content"); return []; }
  c.forEach((b: any, i: number) => {
    const id = `${base}:${i}`;
    switch (b?.type) {
      case "text":
        if (t === "assistant") { out.push({ id, ts, kind: "assistant", ...cut(redact(b.text ?? ""), MAX_TEXT) }); bump("emit:assistant"); }
        else if (!o.isMeta && !SKIP_USER_PREFIX.some((p) => (b.text ?? "").trimStart().startsWith(p))) { out.push({ id, ts, kind: "user", source: "terminal", ...cut(redact(b.text ?? ""), MAX_TEXT) }); bump("emit:user:text-block"); }
        else bump("skip:user:meta-text");
        break;
      case "tool_use": {
        const inp = redact(JSON.stringify(b.input ?? {}));
        out.push({ id, ts, kind: "tool_use", tool: b.name, toolUseId: b.id, ...cut(inp, MAX_TOOL_INPUT) }); bump("emit:tool_use"); break;
      }
      case "tool_result": {
        const rc = b.content;
        const s = typeof rc === "string" ? rc : Array.isArray(rc) ? rc.map((x: any) => x.type === "text" ? x.text : `[${x.type}]`).join("\n") : "";
        out.push({ id, ts, kind: "tool_result", toolUseId: b.tool_use_id, isError: !!b.is_error, ...cut(redact(s), MAX_TOOL_RESULT) }); bump("emit:tool_result"); break;
      }
      case "thinking": case "redacted_thinking": bump("skip:thinking"); break;
      default: bump(`skip:block:${b?.type}`);
    }
  });
  return out;
}

// Incremental tail: read from byte offset, consume only complete lines (ending in \n).
export function readFrom(path: string, offset: number) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size < offset) return { lines: [] as string[], next: 0, reset: true };
    const buf = Buffer.alloc(size - offset); readSync(fd, buf, 0, buf.length, offset);
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl < 0) return { lines: [], next: offset, reset: false };
    const lines = buf.subarray(0, lastNl).toString("utf8").split("\n").filter(Boolean);
    return { lines, next: offset + lastNl + 1, reset: false };
  } finally { closeSync(fd); }
}
```

本実装では、`mcp__hannigan__reply` の除外（6.4）と、秘匿対象パスに対する本文の非表示（5.2）を追加する。

## 付録 B. 検証の副産物

- 試験用セッションの記録が `~/.claude/projects/-private-tmp-claude-501--Volumes-<vol>-<path>-pj-Hannigan-b05bd651-95df-47b1-8246-c94500c1a57e-scratchpad-s2-work-dir-v1/` に残っている（セッション `14159d0f-4d36-49aa-921a-bfb54d802f1f`、偽トークンのみを含む）。不要なら削除してよい
- 試験の実行では `--model haiku`、`--setting-sources project` を使い、利用枠の消費を小さくした
