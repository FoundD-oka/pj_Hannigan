# 引き継ぎ書: OpenMausBot をベースにした作り直しへ

作成日: 2026-10-26。書いた人: Hannigan を Phase 0〜4 まで作った Claude Code のセッション。
読む人: 新しいスレッド（新しい Claude Code のセッション）と利用者。このファイル 1 枚と、ここから参照する文書だけで設計のやり直しを始められるようにする。

## 1. なぜ作り直すか

利用者が OpenMausBot（OSS のチャット型エージェントアプリ）を見つけ、UI の面では Hannigan より全面的に上と判断した。一方、OpenMausBot には「複数の Mac を 1 つのハブにつないで、案件ごとの PM が各 Mac で Claude Code を動かす」という Hannigan の中核（以下「複数 Mac 接続」）が無いように見える。そこで **OpenMausBot をベースにし、Hannigan の複数 Mac 接続の技術を組み合わせる** 方針で、設計からやり直す。

決定済みのこと
- 新しい設計は新しいスレッドで、設計から始める（コードを先に書かない）
- 今の Hannigan は止めない。VPS 構成で動いていて、利用者の 7 日間の運用テストに使っている。作り直しの間も壊さない
- 新しいものの置き場所（このリポジトリの中か、別リポジトリか、OpenMausBot のフォークか）は新しいスレッドで決める

## 2. Hannigan の現状（2026-10-26）

### 2.1 動いているもの

| 部品 | 場所 | 状態 |
| --- | --- | --- |
| ハブ + 秘書 Claude Code | XServer VPS 162.43.38.222（Ubuntu 24.04）。ユーザー `hannigan`、`/home/hannigan/pj-Hannigan`、`HANNIGAN_HOME=/home/hannigan/.hannigan`、systemd `hannigan-hub.service` | 稼働中。公開 URL `https://hannigan.found-d.com`（WebChat）、`wss://hannigan.found-d.com/ws/worker`（ワーカー） |
| TLS | 同じ VPS で別プロジェクト ccr-ingress（Control_VPS_byClaw）が動かす Caddy に `import /etc/caddy/hannigan.caddy` を足して共有 | 証明書は自動取得。**ccr-ingress の元リポジトリにも同じ 1 行を入れる作業が利用者側に残っている** |
| 自宅 Mac のワーカー | この Mac（M4 Mac mini）。ID `m4-mini`。launchd `com.hannigan.worker` で自動起動 | 接続中。案件 `notes`（`~/hannigan-manual-demo/notes`）を登録済み |
| 会社の Mac のワーカー | ID `office`（表示名カボス）。ペアリング済み | 2026-10-25 時点でワーカー未起動。`scripts/install-launchd.sh` を実行すればつながる見込み |
| リポジトリ | `https://github.com/FoundD-oka/pj_Hannigan`（main）。VPS のチェックアウトも同じコミット | 最新は `c6d5950` |

入り方: この Mac から `ssh -i ~/.ssh/hannigan-vps root@162.43.38.222`。WebChat のトークンは VPS の `/home/hannigan/.hannigan/secrets/webchat-token`。ハブのコードを変えたら VPS で `git pull` と `systemctl restart hannigan-hub`（tmux の秘書は残る）。

### 2.2 どこまで確認できているか

- Phase 0〜3 は完了。Phase 3 の出口条件は 7 つ中 6 つを偽 Claude の自動試験で、主要経路を本物の Claude で確認（[phase3-e2e](verification/phase3-e2e/README.md)）
- Phase 4 は出口条件 4 つ中 3 つを実機で確認（別ネットワークからの接続は自宅 Mac 1 台のみ、VPS 再起動と Mac 再起動からの復元、launchd）。残りは CU 承認の補助経路（[phase4-vps](verification/phase4-vps/README.md)）
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
| Claude Code の起動と画面読み取り | `shared/session-manager.ts`（640 行）、`shared/pane.ts`、`shared/tmux.ts`、`shared/bridge.ts` | tmux の中で Claude Code を対話モードで起動し、画面を読んで状態（入力待ち・作業中・端末ダイアログ）を判定、端末ダイアログ（開発用チャネルの確認、フォルダの信頼）を選択キーで答える。チャネル（MCP サーバー）経由で指示を入れ、`reply` ツールで結果を受ける。会話記録が無ければ `--resume` せず `--session-id` | **低〜中。OpenMausBot は Claude を stream-JSON（`claude -p` 系の非対話出力）で動かしているように読める。どちらの方式にするかが新設計の最初の分かれ目** |
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

## 4. OpenMausBot について分かっていること（2026-10-26 に README を読んで確認）

出典: [milind-soni/OpenMausBot](https://github.com/milind-soni/OpenMausBot)（公式サイト [openmausbot.com](https://www.openmausbot.com/) が指すリポジトリ。約 5.6k スター）。フォークが複数あるので、本家はこれで確かめる。

| 項目 | README の記述 |
| --- | --- |
| 何か | ボットを連絡先のように並べて会話するチャットアプリ。各ボットがローカルの Claude / Codex / Grok などのエージェントで、性格・モデル・コンピュータ・連携アプリを個別に持つ。旧名 OpenGrokBot |
| 技術 | TypeScript、React 19 + Vite + Tailwind、Electron（macOS / Windows / Ubuntu）と Web UI。Node 24 以上、pnpm。データは `~/.openmausbot` |
| 構成 | UI（5199）とハーネスサーバー（`127.0.0.1:8799`）の 2 プロセス。UI は HTTP で命令、SSE で出来事を受ける。ハーネスが全エージェントプロセスを持ち、プロバイダーごとのプロトコルを共通の出来事に正規化。`server/drivers/`（Claude、Codex、Grok、クラウドコンピュータ）、`server/harness/`、`server/index.ts`、`server/contracts.ts`（ドライバーの SPI） |
| Claude の動かし方 | 利用者の Mac にある `claude` CLI を使い、Claude は stream-JSON、Codex は JSON-RPC、Grok は ACP。起動の具体（引数、セッション再開）は README に記載なし |
| 承認 | シェル・ファイル編集・質問をチャット内カードで Allow / Deny。Permission broker。自分のマシン操作はオプトイン |
| 「virtual machine」 | ボットの実行環境として、Boat のクラウド Linux デスクトップ（有料・スポンサー）、隔離された Local VM、Cua Driver による自分のマシン（macOS、Ubuntu Xorg）から選ぶ |
| 複数マシン | デスクトップ版の「コンパニオン」で別ホストに Tailscale 経由で接続。`openmausbot serve` で VPS に常駐でき、`--tunnel` / `--tailscale` / Docker、端末は短いコードでペアリング。スマホは HTTPS。**「1 つのハブに複数の作業 Mac をワーカーとしてぶら下げ、案件ごとに PM を置く」構成は記載なし**（利用者の見立てと一致。新スレッドで実物のコードで確かめる） |
| ライセンス | Apache-2.0。`enterprise/` だけ別の source-available ライセンス（フォルダを消せば OSS 版） |
| 注意 | Webhook の受信が既定で `127.0.0.1:8800`。Hannigan のハブも 8800 なので同居させるならどちらかを変える |

未確認（新スレッドで実物を読んで決める）
- `server/drivers/` の Claude ドライバーが `claude` をどう起動しているか（`-p` の stream-JSON か、対話モードか）。Hannigan の PM 階層・書込リース・端末ダイアログの中継は対話モード前提なので、ここが合わないと設計が変わる
- 「コンパニオン」が何を共有するのか（別ホストの CLI を使うだけか、ボット単位の割り当てができるか）
- ドライバー SPI（`server/contracts.ts`）に「リモートのワーカー Mac」をドライバーとして足せるか。足せれば、Hannigan のハブ⇄ワーカー通信をそのまま 1 つのドライバーにできる可能性がある
- 承認（Permission broker）に、Hannigan の端末ダイアログ（開発用チャネルの確認、フォルダの信頼）や書込リースの `resource_unknown` を載せられるか
- 開発の活発さ、Issue の傾向、企業向け例外の範囲

## 5. 新しい設計で決めること

1. 統合の形。候補は 3 つ
   - A. OpenMausBot をフォークし、Hannigan のハブ⇄ワーカー通信とペアリングを「リモートワーカー」ドライバーとして足す。UI は OpenMausBot のまま
   - B. OpenMausBot の UI だけを使い、裏側は Hannigan のハブに差し替える（OpenMausBot の HTTP + SSE の形に Hannigan のハブを合わせる）
   - C. 両方を別プロセスのまま並べ、OpenMausBot のボットの 1 つを「Hannigan への窓口」にする（MCP サーバー経由）
2. Claude Code の動かし方（対話モード + Channels か、stream-JSON か）。PM 階層と書込リースをどう残すか
3. 会話の単位。OpenMausBot の「ボット」と Hannigan の「会話ごとの秘書」「案件ごとの PM」の対応
4. 配置。VPS に何を置くか（OpenMausBot の `serve` と Hannigan のハブの関係）、ペアリングの一本化
5. 移行。今の VPS 構成と 7 日間運用を止めずに進める手順、設定（hub.json / worker.json）と鍵の引き継ぎ
6. ライセンスと貢献。Apache-2.0 との両立、本家への還元（マルチワーカーの PR）を狙うか

## 6. 新しいスレッドの最初の依頼文（貼って使う）

```text
pj-Hannigan の docs/HANDOFF.md を読んでから始めて。目的は、OpenMausBot（https://github.com/milind-soni/OpenMausBot）をベースにして、Hannigan の「複数の Mac を 1 つのハブにつなぎ、案件ごとの PM が各 Mac で Claude Code を動かす」技術を組み合わせた新しい設計を作ること。

まず OpenMausBot の本家リポジトリを clone して、HANDOFF の 4 章「未確認」の項目を実物のコードで確かめて報告して（Claude ドライバーの起動方式、コンパニオンの仕組み、ドライバー SPI にリモートワーカーを足せるか、Permission broker の拡張点、ライセンスの範囲）。その結果をもとに、HANDOFF の 5 章の統合の形 A / B / C を比較して、推しを理由つきで出して。設計書は docs/design/ の既存の形式（00〜04、CHANGELOG）に合わせて新しい番号で書く。

守ること: 今動いている Hannigan（VPS のハブ、自宅 Mac と会社の Mac のワーカー）は止めない・設定を変えない。コードを書くのは設計が固まってから。変わりやすい外部事実（OpenMausBot の版、Claude Code の版とフラグ）は確認日を文書に残す。返答は日本語で。
```

## 7. 場所と連絡先の一覧

| もの | 場所 |
| --- | --- |
| Hannigan のリポジトリ | `/Volumes/SanD/Mac_m1_mini_archive/Git_full_no_xattrs/pj-Hannigan`（この Mac）、`https://github.com/FoundD-oka/pj_Hannigan` |
| VPS | `ssh -i ~/.ssh/hannigan-vps root@162.43.38.222`。XServer の契約管理ページで DNS（found-d.com）と VPS を管理 |
| WebChat | `https://hannigan.found-d.com/#token=<VPS の secrets/webchat-token>` |
| この Mac のワーカー設定 | `~/.hannigan/worker.json`、鍵 `~/.hannigan/secrets/worker-key`、ログ `~/.hannigan/logs/worker.log`、launchd `~/Library/LaunchAgents/com.hannigan.worker.plist` |
| ccr-ingress（同居する別プロジェクト） | VPS の `/root/ccr-ingress`、元は m1agent の Mac の `Control_VPS_byClaw` |
| Claude Code のメモリ（この Mac） | `~/.claude/projects/-Volumes-SanD-Mac-m1-mini-archive-Git-full-no-xattrs-pj-Hannigan/memory/`（Phase 3・4 の要点） |
