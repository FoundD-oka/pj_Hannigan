# 引き継ぎ書: OpenMausBot をベースにした作り直しへ

作成日: 2026-10-26。2026-10-27 に、現状（会社の Mac、Phase 4 の達成数）、CU 承認の補助経路、Bun への依存の記述を実物で確かめて直した。同日、第 1 段階（OpenMausBot の画面から純正 CU）の結果を 5 章に反映し、VPS の Hannigan と同居の ccr を消して OpenMausBot に置き換えた（1・2・7 章）。2026-10-31 に統合の形を D に決め、VPS の OpenMausBot からこの Mac の純正 CU が一巡した（2・5 章）。書いた人: Hannigan を Phase 0〜4 まで作った Claude Code のセッション。
読む人: 新しいスレッド（新しい Claude Code のセッション）と利用者。このファイル 1 枚と、ここから参照する文書だけで設計のやり直しを始められるようにする。

## 1. なぜ作り直すか

利用者が OpenMausBot（OSS のチャット型エージェントアプリ）を見つけ、UI の面では Hannigan より全面的に上と判断した。一方、OpenMausBot には「複数の Mac を 1 つのハブにつないで、案件ごとの PM が各 Mac で Claude Code を動かす」という Hannigan の中核（以下「複数 Mac 接続」）が無いように見える。そこで **OpenMausBot をベースにし、Hannigan の複数 Mac 接続の技術を組み合わせる** 方針で、設計からやり直す。

決定済みのこと
- 新しい設計は新しいスレッドで、設計から始める（コードを先に書かない）
- 2026-10-27 に方針を変えた。今の Hannigan の WebChat は使わず、OpenMausBot をベースに新規に作る。VPS の Hannigan（と同居していた ccr）は消して OpenMausBot に置き換え、7 日間の運用テストは打ち切った（2.1）
- 新しいものの置き場所（このリポジトリの中か、別リポジトリか、OpenMausBot のフォークか）は新しいスレッドで決める

## 2. 現状（2026-10-31）

### 2.1 動いているもの

2026-10-27 に VPS の中身を入れ替えた。Hannigan（ハブ、秘書、WebChat）と、同居していた別プロジェクト ccr は消し、OpenMausBot だけが動いている。

| 部品 | 場所 | 状態 |
| --- | --- | --- |
| OpenMausBot サーバー | XServer VPS 162.43.38.222（Ubuntu 24.04、Node 24.21.0）。ユーザー `hannigan` に `openmausbot@0.1.127` を npm で `~/.local` へ導入。データは `~/.openmausbot`。systemd `openmausbot.service` が `openmausbot serve --public-url https://hannigan.found-d.com --no-pair` を動かす（`127.0.0.1:8799`、webhook は `127.0.0.1:8800`） | 稼働中。`https://hannigan.found-d.com`。ログインは端末のペアリング。エンジンは標準の Claude ドライバー（Claude Code 2.1.310、claude.ai の Max でログイン済み）。2026-10-27 に画面からの 1 往復を確認 |
| TLS | VPS の Caddy 2.6.2（apt）。`/etc/caddy/Caddyfile` は OpenMausBot の 1 サイトだけ（`/hooks/*` → 8800、ほか → 8799、`flush_interval -1`。SSE がたまるので `encode` は付けない） | 証明書は前の Hannigan と同じものを引き継いだ |
| 消したもの | Hannigan のハブ・秘書・コード・データ。ccr 一式（OpenClaw、Authelia、ccr-bots、ws-bridge、証明書更新、関連ユーザー 9 人、SSH の設定）。この Mac の Hannigan ワーカー（launchd から外した） | バックアップはこの Mac の `~/Backups/vps-162.43.38.222-20261027/`（2.26GB と追加分、SHA-256 付き）。秘密情報を含むのでリポジトリには入れない |
| 中継サーバー | VPS。ユーザー `hannigan`、`/home/hannigan/hannigan-relay`、データ `~/.hannigan-relay`、systemd `hannigan-relay.service`（`127.0.0.1:8820`）。Caddy が `/hannigan-relay/*` を渡す。設計は [05](design/05-omb-mac-relay.md) | 稼働中。OpenMausBot のエンジン「レモンm4」（ID `mac-m4-mini`、`customAcp`）がこれを使う |
| この Mac の常駐プログラム | ID `m4-mini`。`relay/mac-agent.ts`、設定 `~/.hannigan-mac`、作業フォルダ `~/hannigan-t11` | 接続中。launchd `com.hannigan.mac-agent` で自動起動。tmux サーバーは CU の権限を借りるため Terminal.app が起動する |
| 会社の Mac のワーカー | ID `office`（表示名カボス） | 接続先のハブが消えた。旧ワーカーを止めて、常駐プログラムへ入れ替える作業が残っている |
| リポジトリ | `https://github.com/FoundD-oka/pj_Hannigan`（main） | VPS にはチェックアウトを置いていない |

入り方: この Mac から `ssh -i ~/.ssh/hannigan-vps root@162.43.38.222`。端末を足すときは `sudo -iu hannigan openmausbot pair --public-url https://hannigan.found-d.com`（コードは 1 回限り、5 分で失効）、一覧と取り消しは `openmausbot sessions`。版を上げるときは `systemctl stop openmausbot`、`sudo -iu hannigan npm install --global --prefix /home/hannigan/.local openmausbot@X.Y.Z`、`systemctl start openmausbot`。

### 2.2 どこまで確認できているか

- Phase 0〜3 は完了。Phase 3 の出口条件は 7 つ中 6 つを偽 Claude の自動試験で、主要経路を本物の Claude で確認（[phase3-e2e](verification/phase3-e2e/README.md)）
- Phase 4 は出口条件 4 つ中 2 つを実機で確認した（Mac 再起動からの自動復帰と launchd、VPS 再起動からの復元）。「2 台以上を別ネットワークから同時につなぎ、WebChat から使い分けて結果が戻る」は、wss での一巡を自宅 Mac 1 台で確かめただけ。会社の Mac も 2026-10-25 からつながっているので、2 台の使い分けを 1 回通せば判定できる。もう 1 つの残りは CU 承認の補助経路（[phase4-vps](verification/phase4-vps/README.md)、4.3）
- 自動試験: 単体 118 件、偽 Claude の通し 64 件（`bun test test/unit`、`bun test test/e2e-fake`）

### 2.3 文書

| 文書 | 内容 |
| --- | --- |
| [ROADMAP](ROADMAP.md) | フェーズと出口条件。Phase 4 まで |
| [00 アーキテクチャ](design/00-architecture.md) | 全体像。Q1〜Q17 のヒアリング結果を反映 |
| [01 設定スキーマ](design/01-config-schema.md) | hub.json v8、worker.json v2、ペアリング（§6）、設定画面 API（§25） |
| [02 ワーカー常駐プログラム](design/02-worker-daemon.md) | PM 階層、PM 専用ツール、書込リース |
| [03 ハブ⇄ワーカー通信](design/03-hub-worker-protocol.md) | WebSocket の形式、命令・出来事・配送状態 |
| [04 VPS 配置](design/04-vps-deployment.md) | Phase 4 の配置と作業単位 |
| [CHANGELOG](design/CHANGELOG.md) | 決定の記録（Q1〜Q17、3f〜3j、Phase 4） |
| [マニュアル](manual/README.md) | 利用者向けの操作手順（12 章） |

## 3. 流用候補の部品（Hannigan 側の資産）

OpenMausBot に無い「複数 Mac 接続」を支えている部品。いずれも Bun + TypeScript、依存は zod と MCP SDK だけ。行数は目安。

| 部品 | ファイル | 何をするか | 流用のしやすさ |
| --- | --- | --- | --- |
| ハブ⇄ワーカーの通信プロトコル | `shared/protocol.ts`（480 行）、設計 03 | WebSocket 1 本で命令（`session_create` `pm_send` `config_set` …）と出来事（`inventory` `session_state` `session_report` …）をやり取り。通し番号付き outbox と ack で再送・重複排除。`request_id` で依頼と報告を結ぶ | 高。UI に依存しない。型定義と文書が揃っている |
| ワーカー常駐プログラム | `worker/daemon.ts`（330 行）、`worker/dispatch.ts`、`worker/outbox.ts`、`worker/received.ts`、`worker/journal.ts` | Mac 側で動く Claude ではないプログラム。ハブに自分から接続（wss）、命令を受けて Claude Code を tmux で起動・停止・再開、結果を中継。再接続（Backoff）、受理台帳、二重実行の抑止 | 高。ハブ側の API さえあれば単体で動く |
| ペアリング | `hub/pairing.ts`（150 行）、`scripts/pair.ts`、`POST /pair`、設計 01 §6 | 8 文字の一時コード（10 分・1 回限り・総当たり防止）で鍵を発行し、再起動なしでワーカーを足す。鍵は `worker-keys.json` | 高。OpenMausBot の「短いコードでペアリング」と考え方が同じなので統合しやすい |
| 案件 PM 階層 | `worker/pm.ts`（730 行）、`worker/instructions.ts`、設計 02 | Mac ごと・案件ごとに PM の Claude Code を 1 つ置き、PM が自分で作業するか子セッションに委任する。PM 専用の MCP ツール（`task_create` `task_send` `work_item_*`）。他案件の操作は常駐プログラムが拒否 | 中。Claude Code の Channels（開発用チャネル）に依存 |
| 書込リース（単一ライター） | `worker/lease.ts`（560 行）、`worker/lease-guard.ts`、設計 02 §18、CHANGELOG Q15〜Q17 | 同じフォルダを書けるセッションを 1 つに絞る。`held → release_pending → released`、確認できないときは `resource_unknown` にして自動解放しない。Claude Code の `--settings` のフックで Edit/Write/Bash の書込を止める | 中。Claude Code のフック機構に依存するが、設計の価値は高い |
| オフライン保留と FIFO 配送 | `hub/offline-queue.ts`（150 行）、`hub/requests.ts`、設計 00 Q12〜Q14 | Mac が落ちている間の依頼を 24 時間保留し、復帰後に受付順で配送、期限切れは失効通知 | 高。ハブ側だけで閉じる |
| 会話分離と共有台帳 | `hub/contexts.ts`、`hub/ledger.ts`、`hub/secretary.ts` | WebChat の会話ごとに秘書セッションを分け、`request_id` で依頼元の会話にだけ報告を返す。案件・進捗の構造化台帳だけを共有 | 中。OpenMausBot では「ボット＝チャット」の単位があるので対応付けが要る |
| Claude Code の起動と画面読み取り | `shared/session-manager.ts`（640 行）、`shared/pane.ts`、`shared/tmux.ts`、`shared/bridge.ts` | tmux の中で Claude Code を対話モードで起動し、画面を読んで状態（入力待ち・作業中・端末ダイアログ）を判定、端末ダイアログ（開発用チャネルの確認、フォルダの信頼）を選択キーで答える。チャネル（MCP サーバー）経由で指示を入れ、`reply` ツールで結果を受ける。会話記録が無ければ `--resume` せず `--session-id` | **中核として残す。OpenMausBot は Claude を `claude -p` の stream-JSON で動かしていると確定した（4.2）。純正 CU と開発用チャネルは `-p` で使えないので、Mac 側ではこの方式を残す（5.1）** |
| 会話記録の抽出 | `worker/transcript.ts`（400 行） | `~/.claude/projects` の記録から、公開してよい発言・ツール要約を抜き出して履歴表示に使う。秘密情報の除外 | 中 |
| 設定画面と設定 API | `hub/settings.ts`、`worker/config-set.ts`、設計 01 §25 | 設定ファイルが正。画面はそれを読み書きする道具。fail closed の検証 | 低。UI は OpenMausBot 側になる。考え方だけ流用 |
| 2 台目向けプロンプト | `shared/second-mac-prompt.ts` | 相手の Mac の Claude Code に貼ると、clone → ペアリング → 起動まで Claude がやる | 高。文面の再利用 |
| 配置 | `scripts/vps-setup.sh`、`deploy/systemd/hannigan-hub.service`、`deploy/caddy/hannigan.caddy`、`deploy/launchd/com.hannigan.worker.plist`、`scripts/install-launchd.sh` | VPS 側の構築、systemd（`KillMode=process` で tmux を残す）、Caddy、Mac の launchd | 高 |
| 試験基盤 | `test/harness.ts`、`test/fake-claude.ts`、`test/e2e-fake/*` | 偽の Claude Code（端末ダイアログ・MCP クライアント・承認中継を模倣）でハブとワーカーを本物のまま通しで試験 | 高。Claude Code の対話モードを使う限り価値がある |

Hannigan で学んだ、新設計でも効く知見
- Claude Code の Channels と純正 Computer Use は研究プレビュー。版ごとに挙動を再確認する（[T01〜T12](verification/claude-channels/README.md)）
- Linux の新規ユーザーでは Claude Code が初回設定の画面を出す。会話記録の無いセッションを `--resume` すると即終了する。Caddy の gzip は SSE をためる（phase4-vps 3 章）
- 秘密情報（鍵、トークン）は出来事・ログ・画面に出さない。案件フォルダの場所もハブの記録に残さない
- 「届けました」と「完了」を混同しない配送状態の表示（`accepted → worker_queued → resource_wait → delivered`、`pending_offline`、`expired`）

## 4. OpenMausBot について分かっていること

出典: [milind-soni/OpenMausBot](https://github.com/milind-soni/OpenMausBot)（公式サイト [openmausbot.com](https://www.openmausbot.com/) が指すリポジトリ。約 5.6k スター）。フォークが複数あるので、本家はこれで確かめる。

### 4.1 README の記述（2026-10-26 に確認）

| 項目 | README の記述 |
| --- | --- |
| 何か | ボットを連絡先のように並べて会話するチャットアプリ。各ボットがローカルの Claude / Codex / Grok などのエージェントで、性格・モデル・コンピュータ・連携アプリを個別に持つ。旧名 OpenGrokBot |
| 技術 | TypeScript、React 19 + Vite + Tailwind、Electron（macOS / Windows / Ubuntu）と Web UI。Node 24 以上、pnpm。データは `~/.openmausbot` |
| 構成 | UI（5199）とハーネスサーバー（`127.0.0.1:8799`）の 2 プロセス。UI は HTTP で命令、SSE で出来事を受ける。ハーネスが全エージェントプロセスを持ち、プロバイダーごとのプロトコルを共通の出来事に正規化。`server/drivers/`（Claude、Codex、Grok、クラウドコンピュータ）、`server/harness/`、`server/index.ts`、`server/contracts.ts`（ドライバーの SPI） |
| Claude の動かし方 | 利用者の Mac にある `claude` CLI を使い、Claude は stream-JSON、Codex は JSON-RPC、Grok は ACP。起動の具体（引数、セッション再開）は README に記載なし。コードで確認した結果は 4.2 |
| 承認 | シェル・ファイル編集・質問をチャット内カードで Allow / Deny。Permission broker。自分のマシン操作はオプトイン |
| 「virtual machine」 | ボットの実行環境として、Boat のクラウド Linux デスクトップ（有料・スポンサー）、隔離された Local VM、Cua Driver による自分のマシン（macOS、Ubuntu Xorg）から選ぶ |
| 複数マシン | デスクトップ版の「コンパニオン」で別ホストに Tailscale 経由で接続。`openmausbot serve` で VPS に常駐でき、`--tunnel` / `--tailscale` / Docker、端末は短いコードでペアリング。スマホは HTTPS。**「1 つのハブに複数の作業 Mac をワーカーとしてぶら下げ、案件ごとに PM を置く」構成は記載なし**（利用者の見立てと一致。複数ホストの管理は Issue #508 で未実装、4.2） |
| ライセンス | Apache-2.0。`enterprise/` だけ別の source-available ライセンス（フォルダを消せば OSS 版） |
| 注意 | Webhook の受信が既定で `127.0.0.1:8800`。Hannigan のハブも 8800 なので同居させるならどちらかを変える |

### 4.2 コードと公式資料で確かめたこと（2026-10-26）

利用者が ChatGPT と相談した内容（2026-10-25〜26、リポジトリ外）の主張を、実物で裏取りした。

確かめた版: OpenMausBot 本家 main `0d8eacc`（2026-10-25、`package.json` の version 0.1.127）。Claude Code 2.1.310（この Mac と VPS）。公式資料は [Computer use（CLI）](https://code.claude.com/docs/en/computer-use) と [Channels reference](https://code.claude.com/docs/en/channels-reference)。

| 項目 | 確かめた結果 | 出典 |
| --- | --- | --- |
| Claude の起動方式 | `claude -p --output-format stream-json --input-format stream-json --verbose`。スレッドごとに CLI のプロセスを 1 つ持ち続け、標準入力から次の発言を入れる。会話は `--resume` / `--session-id` で続ける。承認は `--permission-prompt-tool mcp__ogb__approve` | `server/drivers/claude.ts` 1044〜1051 行、1171 行、1348〜1349 行 |
| 1 ターンの終わりの判定 | CLI が出す `result` でターンを閉じる（標準入力は開いたまま） | `server/drivers/claude.ts` 878 行 |
| 自分の Mac の画面操作 | cua-driver（Rust 製の操作エンジン。純正 CU とは別物）を MCP サーバー `computer` として付ける。自分の Mac を操作するときは承認の仕組み（approval broker）を必ず通す | `server/drivers/claude.ts` 1029〜1031 行、1102〜1110 行、`docs/computer-use-integration.md` |
| 純正 CU と `-p` | 純正 CU は対話セッションが必要で、`-p` では使えない。Pro / Max プランだけで、Team / Enterprise プランでは使えない。CLI で使えるのは macOS だけ。claude.ai の認証が必要 | 公式 Computer use |
| 純正 CU のロックと承認 | 同時に CU を使えるのは 1 セッションだけ。ロックは最初の CU 操作で取り、作業の完了ではなくセッションの終了で外れる。アプリ承認はセッションごとに端末に出る | 公式 Computer use |
| 開発用チャネルと `-p` | `--dangerously-load-development-channels` は `-p` と Agent SDK では無視され、チャネルが登録されない。承認の中継（permission relay）の対象は Bash / Write / Edit などのツール承認で、フォルダの信頼と MCP サーバーの同意は中継されない | 公式 Channels reference |
| ドライバー SPI | `ProviderAdapter` に `sendTurn`、`interruptTurn`、`respondToRequest`（allow / deny / answer）、`steer`（実行中の追加指示。届いたか不明なら `indeterminate` を返し、呼び出し側は再送しない）、`hasSession`、`onEvent` がある。外部プログラムをエンジンとして登録する `customAcp` もある | `server/contracts.ts` 212 行〜、`docs/custom-engines.md` |
| Web 画面の埋め込み | 画面の応答に `frame-ancestors 'none'` と `X-Frame-Options: DENY` を付けており、iframe に表示できない | `server/static-files.ts` 20 行 |
| `enterprise/` | 開発・試験・評価は無料。本番利用はライセンスキー、第三者向けのホスティングとホワイトラベルはパートナー契約が必要。フォルダを消すと `{"edition":"oss"}` の OSS 版として動く | `LICENSING.md` |
| 名称と商標 | OpenMausBot / MausBot の名前とマスコットは商標。Apache-2.0 は商標の権利を与えないので、派生製品には独自の名前が要る。同梱物の表示は `NOTICE` と `third_party/` | `LICENSING.md` |
| 複数ホスト | 複数ホストのデスクトップをまとめて管理する機能は Issue #508（2026-08-26 起票）で未解決 | GitHub Issue |
| 安定性 | 2026-10-24 に「子エージェントの完了を検知できない」（#3450）と「直近 30 分の会話が履歴から消える」（#3449）が起票され、未解決 | GitHub Issue |

### 4.3 統合に効く Hannigan 側の事実（2026-10-26〜27 にコードと実測記録で確認）

- 案件 PM への依頼は、秘書専用ツールの中の `projectPmSend()`（`hub/hub.ts` 967 行）が行う。外から呼べる依頼 API にはなっていない。`POST /api/send`（同 1659 行）は Hannigan の秘書に話しかける API なので、OpenMausBot の統括秘書から呼ぶと秘書が 2 段になる
- `projectPmSend()` は呼ぶたびに新しい `request_id` を作る。Hannigan の中の重複排除は、システムをまたいだ再試行までは防がない
- 依頼の状態 `RequestState`（`hub/requests.ts` 7 行）は配送の状態だけを持ち、作業の完了を表す値は無い。`delivered` はチャネルに書き込めたという意味
- 実測（[claude-channels](verification/claude-channels/README.md)）では、CU のアプリ承認は Channels に届かず端末にだけ出た（T05）。実行中の停止は Channels のメッセージでは効かず、tmux へ Esc を送ると止まり、同じ会話を続けられた（T09）
- CU のアプリ承認の補助経路は作り済み。ワーカーは tmux の画面から承認ダイアログを `cu_app_approval` として見分け（`shared/pane.ts` 28 行）、自動では答えずに WebChat の承認カードへ出す。カードでの回答は、選択キーとして端末へ送る（`shared/session-manager.ts` の `selectOption`）。画面判定には単体試験がある（`test/unit/pane.test.ts`）。本物の CU で WebChat から承認して作業が続くかは未確認（ROADMAP の Phase 4 出口条件 4）
- Bun 固有の書き方は 4 種類ある
  - サーバー 2 つ。ハブの HTTP と WebSocket の入口（`hub/hub.ts` 1586 行の `Bun.serve`）と、ワーカーがチャネルからの接続を受けるサーバー（`worker/daemon.ts` 289 行の `Bun.serve`）
  - Bun の WebSocket 型（`hub/hub.ts` と `shared/session-manager.ts` の `ServerWebSocket`）
  - `import.meta.dir` と `import.meta.main`（`hub/hub.ts`、`shared/session-manager.ts`、`worker/lease.ts`、`worker/lease-guard.ts`）
  - Claude Code に起動させるチャネル（`shared/bridge.ts`）と書込リースのフック（`worker/lease-guard.ts`）を、`hub.json` と `worker.json` の `bun_bin` で動かす（VPS の秘書もチャネルを使う）
- `shared/bridge.ts`、`shared/tmux.ts`、`shared/pane.ts`、`worker/pm.ts`、`hub/offline-queue.ts` のコードは Bun 固有の書き方を使わない。試験は `bun test` が前提（`bun:test` を読む試験が 25 ファイル）
- Hannigan のライセンスは MIT（`LICENSE`）

未確認（新スレッドで実物を読んで決める）
- 「コンパニオン」が何を共有するのか（別ホストの CLI を使うだけか、ボット単位の割り当てができるか）
- `ProviderAdapter` に Hannigan の対話型セッションを載せたとき、`result` の代わりにターンの終わりをどう伝えるか。`respondToRequest` と `interruptTurn` を端末へのキー送信にどうつなぐか（作って試すまで分からない）
- 承認の仕組み（approval broker）に、Hannigan の端末ダイアログ（CU のアプリ承認、開発用チャネルの確認、フォルダの信頼）や書込リースの `resource_unknown` を載せられるか

## 5. 新しい設計で決めること

### 5.1 見立て（2026-10-26。第 1 段階の結果を 2026-10-27 に反映）

利用者と ChatGPT の相談を 4.2・4.3 で裏取りしたうえでの見立て。第 1 段階は 2026-10-27 に合格した（[omb-native-cu](verification/omb-native-cu/README.md)）。

- 利用者の目標: 将来は 1 つの OSS として、VPS 用と Mac 用の配布物で簡単に導入できるようにする。製品名は Hannigan（OpenMausBot の名前は商標なので使えない、4.2）
- 統合の形は 2026-10-31 に D に決めた。OpenMausBot を改造せず、Hannigan を ACP エンジン（`customAcp`）として外付けする。理由は [05](design/05-omb-mac-relay.md) の 1 章
- Claude の動かし方は場所で分ける。Mac で純正 CU を使う案件 PM と作業セッションは、今の Hannigan と同じ tmux 内の対話モード + Channels で動かす（純正 CU と開発用チャネルが `-p` で使えないため、4.2）。VPS の統括秘書は CU を使わないので、OpenMausBot 標準の `-p` ドライバーのままでよい
- 第 1 段階の前に予定していた「今の Hannigan の WebChat で本物の CU のアプリ承認を通す確認」（Phase 4 の残り）は、先に第 1 段階を行ったので未実施。画面判定と選択キーの送信は、第 1 段階で OpenMausBot 経由で実機で動いた。残るのは、launchd で動くワーカーの tmux に CU の macOS 権限があるかの確認と合わせた実機確認（5.3 の最後の項目）
- 進める順番
  1. Mac 1 台で、純正 CU が OpenMausBot の画面から一巡するか確かめる。合格は「画面から依頼 → 対話型の Claude が純正 CU で作業 → 承認・拒否・停止を画面から操作 → 結果が画面に戻る → 同じセッションへ追加指示」がすべて通ること。初回の OS 権限の付与を除き、端末へ戻らずに済むこと。cua-driver で代わりに動いた場合は合格にしない。**2026-10-27 に合格**（D の形の試作。OS 権限は Terminal.app の付与済みの権限を借りた）
  2. VPS への配置と複数 Mac の仕組みを作り、2 台で承認・停止・再接続を確かめ直す。**2026-10-31 に 1 台目が通った**（[omb-mac-relay](verification/omb-mac-relay/README.md)）。通信とペアリングは作った。launchd での常駐も通った。残りは 2 台目の Mac、保留配送、書込リース
  3. 第 1 段階で見つかった要対応（5.3 の最後の項目）は 7 つのうち 6 つを解決した。macOS 権限の持ち主は Terminal.app の権限を借りる回避策で動かしている
- 利用者の構想として、自作の Web アプリにボタンを置き、押すとサイドパネルが開いて OpenMausBot の Web 画面が出る形がある。今は埋め込みが禁止されている（4.2）ので、フォーク側で許可する埋め込み元を限定して開ける。ログインとペアリングの画面は禁止のまま残す。D は OpenMausBot を改造しないので禁止が残り、サイドパネル化には A か、応答ヘッダーを書き換える前段が要る。サイドパネル化と Discord 連携は、第 1 段階が通るまで着手しない（第 1 段階は通った）

### 5.2 決めること

1. 統合の形。**D に決定（2026-10-31）**。比べた候補は次の 4 つ
   - A. OpenMausBot をフォークし、Hannigan のハブ⇄ワーカー通信とペアリングを「リモートワーカー」ドライバーとして足す。UI は OpenMausBot のまま
   - B. OpenMausBot の UI だけを使い、裏側は Hannigan のハブに差し替える（OpenMausBot の HTTP + SSE の形に Hannigan のハブを合わせる）
   - C. 両方を別プロセスのまま並べ、OpenMausBot のボットの 1 つを「Hannigan への窓口」にする（MCP サーバー経由）
   - D. OpenMausBot を改造せず、Hannigan を ACP エンジン（`customAcp`）として外付けする。OpenMausBot はエンジンのコマンドを起動し、ACP で依頼・承認（`session/request_permission`）・停止（`session/cancel`）・再開（`session/load`）をやり取りする。第 1 段階はこの形で通った。利点は、フォークの追従が要らず、Hannigan が Bun のまま動くこと。弱点は、OpenMausBot の承認の扱い（「お任せ」の自動許可）、埋め込みの禁止、裏の仕事の行き先を変えられないこと（設定で変えられるかは未確認）。Claude のセッションは ACP のプロセスではなく Mac の常駐プログラムが持つ。自動許可は質問カードで避けられた
2. Claude Code の動かし方。Mac 側は対話モード + Channels が前提（5.1）。決めるのは、そのドライバーの作り（5.3）と、PM 階層と書込リースの残し方
3. 会話の単位。OpenMausBot の「ボット」と Hannigan の「会話ごとの秘書」「案件ごとの PM」の対応
4. 配置。VPS に何を置くか（OpenMausBot の `serve` と Hannigan のハブの関係）、ペアリングの一本化
5. 移行。今の VPS 構成と 7 日間運用を止めずに進める手順、設定（hub.json / worker.json）と鍵の引き継ぎ
6. ライセンスと貢献。Apache-2.0 との両立（元の著作権表示・`NOTICE`・変更表示を残す。Hannigan の MIT のコードも表示を残す）、本家への還元（マルチワーカーの PR）を狙うか

### 5.3 設計で先に詰める論点（2026-10-26 のレビューと 2026-10-27 の第 1 段階で出たもの）

- ターンの終わりの判定。OpenMausBot 標準のドライバーは CLI の `result` でターンを閉じるが、対話モードの Claude はこれを出さない。Hannigan の `reply` ツールの呼び出しと画面の状態から終わりを決め、OpenMausBot の出来事に変える。「受け付けた」「届けた」「作業中」「承認待ち」「完了」を混同しない（`delivered` は完了ではない、4.3）。第 1 段階の試作は `reply` ツールを使わず、画面の状態が `ready` に戻り、会話記録に出力があり、2.5 秒静かなことで終わりとして、ACP の `end_turn` / `cancelled` を返した。発言とツール実行は会話記録から流した。文字だけの 1 往復は 7〜11 秒
- 承認と停止の補助経路。CU のアプリ承認と実行中の停止は Channels に乗らない（4.3）。`respondToRequest` を端末へのキー送信に、`interruptTurn` を tmux への Esc につなぐ。第 1 段階で、端末の CU のアプリ承認が OpenMausBot の承認カードになり、許可・拒否が選択キーとして端末に届いた。停止ボタンは tmux への Esc になり、1.9 秒でターンが閉じた（ACP では `session/request_permission` と `session/cancel`）。A で `respondToRequest` と `interruptTurn` につなぐ場合も、中身は同じ処理になる
- CU のロック。Mac 1 台で CU を使えるのは 1 セッションだけで、ロックはセッションの終了まで外れない（4.2）。PM と子セッションが同じ Mac に並ぶので、CU を使うセッションを Mac ごとに 1 本に絞る決まりと、案件をまたいでロックを渡す手順が要る。書込リースとは別に扱う
- 再試行の重複。`projectPmSend()` は呼ぶたびに新しい `request_id` を作る（4.3）。OpenMausBot 側の再試行で同じ依頼を二重に出さないよう、OpenMausBot の「ボット・会話・ターン」と Hannigan の「Mac・案件・セッション・`request_id`」の対応を永続化する。届いたか不明なときは、`steer` の `indeterminate` と Hannigan の `delivery_unknown` をそろえて扱い、無条件に再送しない
- 秘書を二重にしない。`/api/send` は Hannigan の秘書に話しかける API（4.3）。案件 PM への依頼を、外から呼べる API として切り出す。PM からの報告も OpenMausBot の該当する会話へ返せるようにする
- 実行環境。OpenMausBot は Node 24 + pnpm、Hannigan は Bun。Node へ寄せるときに書き換えるのは、サーバー 2 つ（ハブの入口とワーカーのチャネル用サーバー）、WebSocket の型、`import.meta.dir` などの書き方、チャネルとフックの起動コマンド、試験の実行方法（4.3）。案件 PM、書込リース、オフライン保留の判断の中身は書き換えずに済む。D なら OpenMausBot はエンジンのコマンドを起動するだけなので、第 1 段階の試作は Bun のまま動いた。配布版では利用者に両方を管理させない
- 配布の前提。純正 CU は Pro / Max プランだけで、CLI は macOS だけ（4.2）。正式な対応範囲は Linux の VPS + macOS の作業 Mac にし、導入前の案内に書く
- 第 1 段階で見つかった要対応（[omb-native-cu](verification/omb-native-cu/README.md) 3 章）。2026-10-31 の状況は [omb-mac-relay](verification/omb-mac-relay/README.md) 2 章
  - 承認の自動許可。OpenMausBot のボットの権限「お任せ」（新しいボットの初期値）は、CU のアプリ承認も macOS の権限ダイアログも自動で許可する。CU の承認を必ず人に回す方法を決める
  - 拒否の伝え方。CU のアプリ承認を拒否すると `request_access` は `{"granted":[],"denied":[]}` を返し、Claude は別の名前で頼み直した。ドライバーから拒否を Claude に伝える
  - 承認カードの重複。描画の途中の画面を拾い、1 つのダイアログから 2 枚出た。画面が落ち着いてから出す。`SessionManager` の処理なので、今の Hannigan の WebChat でも起きうる
  - OS 権限の画面。Accessibility と Screen Recording が未付与のときのダイアログは、承認ではなく案内として出す
  - セッションの寿命。OpenMausBot は停止のあとエンジンのプロセスを立て直し、試作は `--resume` で起動し直したので CU のアプリ承認が消えた。CU の承認とロックを保つため、Claude のセッションは常駐プログラムに持たせ、ACP 側は薄くする
  - 裏の仕事。OpenMausBot の記憶の整理（memory の CAPTURE）なども同じエンジンに来て、対話型の Claude をもう 1 本起動した（約 20 秒）。`-p` へ振り分ける
  - macOS 権限の持ち主。CU の権限は tmux サーバーを起動したアプリから引き継がれる。第 1 段階は Terminal.app から tmux サーバーを起動して通した。配布版で OpenMausBot.app と常駐プログラムのどちらに付けるかを決める。launchd で動く今のワーカーの tmux で CU が使えるかは未確認

## 6. 新しいスレッドの最初の依頼文（貼って使う）

```text
pj-Hannigan の docs/HANDOFF.md を読んでから始めて。目的は、OpenMausBot（https://github.com/milind-soni/OpenMausBot）をベースにして、Hannigan の「複数の Mac を 1 つのハブにつなぎ、案件ごとの PM が各 Mac で Claude Code を動かす」技術を組み合わせた新しい設計を作ること。

まず OpenMausBot の本家リポジトリを clone して、HANDOFF の 4 章「未確認」の項目を実物のコードで確かめて報告して（コンパニオンの仕組み、ドライバー SPI に対話型の Claude を載せる方法、承認の仕組みに端末ダイアログを載せられるか）。4.2 の確認結果も、版が変わっていれば確かめ直して。その結果をもとに、5.1 の見立て（統合の形 A か D）が妥当かをほかの候補と比べて確かめ、5.3 の論点への答えを理由つきで出して。あわせて、5.1 にある「第 1 段階の前に、今の Hannigan で CU のアプリ承認を WebChat から通す」確認の段取りを示して。実機の操作が要るので、実施は利用者と相談してから。設計書は docs/design/ の既存の形式（00〜04、CHANGELOG）に合わせて新しい番号で書く。

守ること: VPS で動いている OpenMausBot（HANDOFF 2.1）は止めない・設定を変えるときは先に相談する。コードを書くのは設計が固まってから。変わりやすい外部事実（OpenMausBot の版、Claude Code の版とフラグ）は確認日を文書に残す。返答は日本語で。
```

## 7. 場所と連絡先の一覧

| もの | 場所 |
| --- | --- |
| Hannigan のリポジトリ | `/Volumes/SanD/Mac_m1_mini_archive/Git_full_no_xattrs/pj-Hannigan`（この Mac）、`https://github.com/FoundD-oka/pj_Hannigan` |
| VPS | `ssh -i ~/.ssh/hannigan-vps root@162.43.38.222`。XServer の契約管理ページで DNS（found-d.com）と VPS を管理 |
| OpenMausBot | `https://hannigan.found-d.com`（端末ごとにペアリング）。VPS の `/home/hannigan/.openmausbot`、`/etc/systemd/system/openmausbot.service`、`/etc/caddy/Caddyfile` |
| 中継と Mac の常駐プログラム | 設計 [05](design/05-omb-mac-relay.md)、VPS `/home/hannigan/hannigan-relay` と `~/.hannigan-relay`（`server.js pair --mac ID`、`status`）、Mac `~/.hannigan-mac`（設定、鍵、ログ `logs/agent.log`） |
| VPS のバックアップ（2026-10-27 の入れ替え前） | この Mac の `~/Backups/vps-162.43.38.222-20261027/`（Hannigan のデータと ccr 一式） |
| この Mac の旧ワーカー | 停止済み。設定 `~/.hannigan/worker.json` は残っている。launchd の plist は `~/Backups/hannigan-worker-launchd-20261027/` に移した |
| Claude Code のメモリ（この Mac） | `~/.claude/projects/-Volumes-SanD-Mac-m1-mini-archive-Git-full-no-xattrs-pj-Hannigan/memory/`（Phase 3・4 の要点） |
