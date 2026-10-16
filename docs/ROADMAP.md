# ロードマップ

作成日: 2026-10-13
改訂: 2026-10-16。設計改訂 Q1〜Q17（[CHANGELOG](design/CHANGELOG.md)）を反映し、順序を「ローカル実地テスト → VPS → Discord」に固定した。
前提: Claude Code Channels と純正 Computer Use は研究プレビュー。版ごとの再確認を各フェーズの出口条件に含める。

## 全体像

```text
Phase 0  検証               ── 完了（Channels × CU、同一 Mac 内）
Phase 1  設計               ── 完了。2026-10-16 に Q1〜Q17 で改訂（VPS 秘書、案件 PM 階層、Discord、オフライン保留、書込直列化）
Phase 2  1 台で動く MVP      ── 実施済み。出口条件 3 つを本物の Claude で確認、利用者の確認待ち
Phase 3  ローカル実地テスト   ── ハブと WebChat をローカル起動し、新設計の中核を本物の Claude で日常運用する
Phase 4  VPS                ── 秘書とハブを VPS へ。WSS、ペアリング、複数 Mac、承認の集約
Phase 5  設定画面と導入 CLI   ── 設定画面、init / pair / doctor、launchd
Phase 6  無人運用の硬化      ── 監視、ログ、自動試験、運用手順
Phase 7  Discord            ── 秘書のサブ窓口（Q5〜Q11）。最後に実装する
Phase 8  OSS 公開           ── 文書、セキュリティ方針、CI、許可リスト申請
```

各フェーズは「出口条件」を満たしたら次へ進む。出口条件は実機で確認できる事実で書く。
配置を変える（ローカル → VPS）前に、同じ機能をローカルで本物の Claude で成立させる。Discord は秘書の入口が増えるだけなので、VPS と WebChat の運用が安定してから足す。

## Phase 0: 検証（完了）

- [x] Channels × 純正 CU の実機検証 T01〜T10（[レポート](verification/claude-channels/README.md)）
- [x] 検証用 WebChat チャネル（[prototype/webchat-test](../prototype/webchat-test/)）
- [x] リポジトリ移植、MIT ライセンス、全体アーキテクチャ草案

## Phase 1: 設計（完了。2026-10-16 改訂）

目的: 実装前に、設定の形と命令の形を固め、CU 承認を遠隔で扱う手段を確定する。

| 項目 | 成果物 | 状態 |
| --- | --- | --- |
| 全体アーキテクチャ | [`00-architecture.md`](design/00-architecture.md) | Q1〜Q17 反映済み |
| 設定スキーマ | [`01-config-schema.md`](design/01-config-schema.md)（hub v8 案、worker v2 案、移行、ローカル用の例） | Q1〜Q17 反映済み |
| ワーカー常駐プログラム | [`02-worker-daemon.md`](design/02-worker-daemon.md)（PM 専用ツール、直接投稿、資源待機、書込リース） | Q1〜Q17 反映済み |
| ハブとワーカー間の通信 | [`03-hub-worker-protocol.md`](design/03-hub-worker-protocol.md)（proto v2 案、`request_id`、期限付き保留、`resource_lease_state`） | Q1〜Q17 反映済み |
| 決定記録 | [`CHANGELOG.md`](design/CHANGELOG.md)（Q1〜Q17 の回答、影響範囲、未検証点） | 作成済み |
| T11: Remote Control × CU 承認 | [結果](verification/t11-remote-control-cu/README.md) | 届かない。CU 承認は補助経路で扱う |
| T12: チャネル経由のコマンド | [レポート](verification/t12-channel-command/README.md)。`/clear` は実行されない | 完了 |

改訂前の設計書は [`design/archive/20261013-phase1/`](design/archive/20261013-phase1/) に残した。

主な決定（詳細は CHANGELOG）
- 統括秘書とハブは VPS に置く。純正 CU は Mac だけが使う（Q1）
- Mac ごとに案件 PM Claude Code を置き、軽い作業は PM が直接、重い作業と CU は子セッションへ委任する（Q2、Q3）
- WebChat から PM と子のスレッドを見て直接指示できる。子への指示は PM にも通知する（Q4）
- 秘書は会話ごとに別セッション。共有するのは案件・進捗・タスクの台帳だけ（Q6）
- Discord は秘書のサブ窓口。許可チャンネルでのメンションか Bot への返信だけに反応し、DM は使わず、追加の着手承認は設けない（Q5、Q7〜Q11）
- Mac がオフラインなら VPS が依頼を 24 時間保留し、復帰後に受付順で配送する（Q12〜Q14）
- PM と子は同じ作業フォルダを共有し、書き込めるセッションは同時に 1 つ。完了確認後に自動解放し、異常時は安全な再検証だけを行う（Q15〜Q17）

出口条件
- [x] 設計書 4 本が Q1〜Q17 を反映している
- [x] 追加仕様が「未実装・未検証」と明記され、実装順序が ROADMAP に固定されている

## Phase 2: 1 台で動く MVP（実施済み・利用者の確認待ち）

目的: 同じ Mac の中で、WebChat → 秘書 → ワーカー → 結果 → WebChat の一巡を通す。

| 項目 | 内容 | 状態 |
| --- | --- | --- |
| ハブ v0 | `hub/`。秘書向けツール `workers_status` `session_create` `session_resume` `session_send` `session_stop` `session_interrupt` `reply` | 実装済み |
| ワーカー常駐プログラム v0 | `worker/`。localhost でハブへ接続。tmux での起動・再開・停止、結果の中継、outbox | 実装済み |
| ワーカーチャネル v0 | `shared/bridge.ts`。セッションごとに起動するチャネルサーバー。permission relay を宣言。秘書と共通 | 実装済み |
| WebChat UI v0 | `web/index.html`。会話、承認の許可・拒否、端末ダイアログの選択、停止と Esc、ワーカーとセッションの一覧 | 実装済み |
| 試験 | 偽 Claude による一巡の自動試験 15 件、単体試験 17 件、本物の Claude での一巡 | 実施済み（[報告](verification/phase2-e2e/README.md)） |

出口条件（[Phase 2 報告](verification/phase2-e2e/README.md)）
- [x] WebChat の 1 往復で、秘書がセッションを作って指示し、結果が同じ会話に戻る
- [x] 通常ツールの承認が WebChat から許可・拒否できる
- [x] セッションの再開で履歴とチャネル登録が維持される

Phase 2 の部品（ワーカー常駐プログラム、ブリッジ、tmux 操作、画面読み取り、outbox）は Phase 3 でもそのまま土台にする。

## Phase 3: ローカル実地テスト

目的: VPS に移す前に、新設計の中核を手元の Mac だけで動かし、本物の Claude で日常的に使える状態にする。
ハブ・秘書・WebChat をローカル起動し、ワーカーは同じ Mac（任意で LAN 内の 2 台目を SSH トンネルで追加）。設定は [01 の 8.1](design/01-config-schema.md) の形。

| 段階 | 内容 | 根拠 | 状態 |
| --- | --- | --- | --- |
| 3a 案件 PM 階層 | `role=pm` / `role=task` の起動と再開。PM 専用のローカルツール `task_create` `task_send` 等。子の `reply` を PM へ通知し、PM が `request_id` 付きで秘書へ報告。他案件の操作をデーモンで拒否。同じ実体フォルダで書込可能セッションを 1 つに直列化する安全側の実装を最初から入れる | Q2、Q3、Q15 | 実装済み。偽 Claude で試験済み（`pm.test.ts`、`phase3.test.ts`）。本物の Claude で一巡を確認（2026-10-16） |
| 3b WebChat スレッド閲覧と直接介入 | ワーカー → 案件 → PM／子の階層表示。`POST /api/thread/send` → `thread_direct_send`。子への投稿と PM への通知を別々に追跡。取得できる履歴の範囲を画面で明示 | Q4 | 実装済み。偽 Claude で試験済み。本物の Claude で PM スレッドへの直接投稿と会話記録からの履歴表示（`coverage=transcript`）を確認。子スレッドへの直接投稿は偽 Claude のみ |
| 3c 会話分離と案件台帳 | WebChat の `conv_id` ごとに秘書セッションを起動・再開。`project_pm_send` で `request_id` を発行し、PM 報告を依頼元の会話にだけ返す。`project_status` と `work-items.jsonl` | Q6 | 実装済み。偽 Claude で試験済み |
| 3d オフライン保留と FIFO 配送 | ワーカー停止中の依頼を `pending_offline` で保留。24 時間 TTL、受付順の配送、失効通知、二重配送の抑止。ワーカー常駐プログラムを止めて再現する | Q12〜Q14 | 実装済み。偽 Claude で試験済み（TTL 1 分の設定と保留ファイルの書き換えで失効を再現。24 時間の実経過は未実施） |
| 3e 書込権の自動解放と異常時復旧 | スパイク S1 の結果で方式を確定。成立すれば `held → release_pending → released` と `resource_unknown` を実装。不成立なら 3a の直列化に固定し、設計書の Q16/Q17 を縮退案に書き換える | Q16、Q17 | 実装済み（S1 成立。`held → release_pending → released` と `resource_unknown`）。単体試験と偽 Claude で試験済み。本物の PM と子の書込権の受け渡しを一巡で確認 |
| 設定移行 | hub v1 → v8 案、worker v1 → v2 案の移行と検証。Phase 2 のセッション台帳を `role=task` として引き継ぐ | 01 の 10 章 | 実装済み。単体試験済み |
| 試験 | 偽 Claude の自動試験を新経路（PM 委任、直接介入、会話分離、保留と再配送、直列化）まで広げる。本物の Claude での一巡 | | 偽 Claude の自動試験は実装済み・全件通過。本物の Claude での一巡（`test/e2e-real.ts`、18 段階）は 2026-10-16 に全段階通過 |

検証スパイク（実装の前に短期間で白黒をつける）
- S1 書込経路の封じ込め: Claude Code のセッションを生かしたまま、Edit／Write／Bash と外部プロセスの書込を OS かツール権限の境界で止められるか。止められなければ Q16/Q17 は縮退案にする
- S2 Claude Code 本体の中間発言とツール実行の取得: Mac 上のセッション記録から履歴を抽出できるか、遅延と秘密情報の除外を含めて確認する（Q4 の履歴表示の範囲を決める）

出口条件（チェックは偽 Claude の自動試験で確認したもの。本物の Claude で確認した範囲は [phase3-e2e](verification/phase3-e2e/README.md) の 3〜4 章）
- [x] WebChat の 1 往復で、秘書が案件 PM に委任し、PM が直接実行か子への委任を選び、結果が元の会話に戻る
- [x] WebChat から PM と子のスレッドに直接投稿でき、子への投稿が PM に通知される
- [x] 別の WebChat 会話から同じ PM に依頼しても、報告が混ざらず依頼元にだけ戻る
- [x] ワーカー停止中の依頼が保留され、再起動後に受付順で配送される。24 時間を過ぎた依頼は実行されず失効が通知される
- [x] 同じ作業フォルダで PM と子が同時に書き込まない
- [ ] 連続 7 日間、WebChat だけで日常の依頼を回せる（端末での操作は開発用チャネルの承認とフォルダの信頼確認だけ）
- [x] 偽 Claude の自動試験が上の経路を網羅して通る

## Phase 4: VPS

目的: 秘書とハブを VPS に移し、別ネットワークの Mac をルーター設定なしでつなぐ。

| 項目 | 内容 |
| --- | --- |
| スパイク S3 | Linux VPS 上で Claude Code を常駐させる。ログイン、tmux、開発用チャネルの起動時承認、会話別セッションの `--resume`、プロセス監視下での復元を実測する |
| 配置 | ハブと秘書を VPS へ。`listen.host` はループバックのまま、HTTPS／WSS のリバースプロキシで公開。`worker.json` の `hub_url` を `wss://` に |
| ペアリング | ハブが一時コードを発行、ワーカーで `pair <code>`。以後は鍵で認証 |
| 承認の集約 | 複数ワーカーの承認要求を WebChat に 1 画面で表示。request_id の衝突を防ぐ |
| 補助経路 | tmux 画面の読み取りと選択キー送信（CU 承認、起動時警告、停止）を複数 Mac で |
| 復元 | VPS 再起動時に秘書セッション群、案件台帳、オフライン保留キューを復元する。systemd 等のサービス管理 |
| 別ネットワーク試験 | 別端末・別ネットワークからの実測（Phase 0 で保留した項目） |

出口条件
- [ ] 2 台以上のワーカーを別ネットワークから同時につなぎ、WebChat から使い分けて結果が戻る
- [ ] ワーカーの Mac を再起動しても、常駐プログラムが自動でハブへ戻る
- [ ] VPS を再起動しても、秘書セッションと保留キューが復元され、期限内の依頼が配送される
- [ ] CU のアプリ承認を遠隔から完了できる（補助経路）

## Phase 5: 設定画面と導入 CLI

目的: 利用者が設定画面と CLI だけで導入と運用ができる状態にする。

| 項目 | 内容 |
| --- | --- |
| 秘書の使い分け | ワーカーごとの役割説明文を `instructions` に組み込む。振り分けの判断基準を設定で持つ |
| 設定画面 | ハブの設定、ワーカーの追加と編集、案件フォルダと PM の登録、承認方針、オフライン保留の有効化。設定ファイルを読み書きする |
| 導入 CLI | `init`（`.mcp.json` と起動スクリプトの生成）、`pair`、`doctor`（権限と準備状態の診断） |
| launchd | Mac 側のワーカー常駐プログラムの自動起動 |
| 準備状態の表示 | macOS の権限、CU の有効化、Claude Code の版を設定画面に表示 |

出口条件
- [ ] 新しい Mac を、導入 CLI と設定画面だけでワーカーとして追加できる
- [ ] 秘書が仕事用と私用のワーカーを会話内容から正しく選ぶ試験が通る

## Phase 6: 無人運用の硬化

目的: 週 1 の点検以外は人が触らずに回る。

| 項目 | 内容 |
| --- | --- |
| 監視 | セッションの生存確認、応答なしの検出、`resource_unknown` の要確認通知、WebChat への通知 |
| ログ | 秘密情報を含まない構造化ログ。証拠として残せる形式 |
| 自動試験 | 一巡試験、再接続試験、承認試験、保留と再配送の試験を CI で回す（Channels は対話セッション前提のため、tmux を使う試験基盤） |
| 運用手順 | 週 1 点検の手順書（起動、承認、更新）。障害時の復旧手順。異常時に人がどこまで遠隔で復旧操作できるか（CHANGELOG の Q18 候補）をここで決める |
| 版追従 | Claude Code の新版で Channels と CU の挙動を再確認する手順 |

出口条件
- [ ] 7 日間の連続運用で、点検以外の人手が 0 回

## Phase 7: Discord

目的: 許可した Discord サーバーチャンネルから統括秘書に依頼できるようにする。WebChat と VPS の運用が安定してから着手する。

| 項目 | 内容 | 根拠 |
| --- | --- | --- |
| Bot アダプター | VPS 上でハブと同居。Discord のメッセージを秘書宛ての通常会話に正規化し、返信を元のチャンネルへ返す | Q5 |
| 認可 | `allowed_user_ids` と `allowed_channel_ids`。Bot への直接メンションか Bot 投稿への返信だけに反応。Bot・Webhook の投稿は除外 | Q8 |
| 会話分離 | 許可チャンネルごとに秘書セッションを分ける。共有台帳は `shared_ledger_visibility=all_allowed_channels` のときだけ全案件を返す | Q6、Q7 |
| 実作業依頼 | `work_request_policy=allowed_users_via_secretary` で許可ユーザー全員が秘書経由で PM に依頼できる。`session_*`・承認・設定の代理呼び出しはハブで拒否。追加の着手承認は設けない | Q9、Q11 |
| DM | 個人 DM・グループ DM は入口・出口の両方で拒否 | Q10 |
| 耐久性 | 受信済み・配送済み・返信済み・送信済みを区別。送信失敗の表示、重複排除、誤チャンネル返信の防止、fail-closed | Q5 |

出口条件
- [ ] 許可チャンネルで Bot にメンションして依頼すると、PM の結果が同じチャンネルに返る
- [ ] 未許可ユーザー、未許可チャンネル、DM、Bot 名を含むだけの投稿には反応しない
- [ ] Discord 由来の入力で秘書が `session_*` や承認を代理実行しようとしてもハブが拒否する
- [ ] WebChat の会話と Discord の会話が混ざらず、台帳の情報だけが共有される

## Phase 8: OSS 公開

| 項目 | 内容 |
| --- | --- |
| 文書 | README（日本語・英語）、導入手順、設計書、制約と注意 |
| セキュリティ方針 | SECURITY.md、送信者の許可リスト、トークンの扱い、公開範囲の既定値（localhost、`offline_queue.enabled=false`、`discord.enabled=false`） |
| CI | lint、型検査、自動試験 |
| 許可リスト | 研究プレビューの許可リスト掲載を Anthropic のパートナー窓口へ相談。掲載までは開発用フラグの手順を文書化 |
| 公開前点検 | 証拠と履歴の秘密情報の再走査 |

出口条件
- [ ] 第三者が README だけで 1 台構成（Phase 3 のローカル構成）を動かせる

## 公開後の候補

- Telegram 等の公式プラグインを WebChat と併用する入口
- ワーカーの OS 拡張（Linux、Windows。CU は macOS のみ）
- 設定画面からのログ閲覧と証拠の書き出し
- 同じ案件を複数 Mac で分担する所有規約（CHANGELOG「変更していないこと」）

## 技術方針

- 言語と実行環境は Bun + TypeScript（prototype と公式プラグインに合わせる）
- 設定はファイルが正。設定画面はそれを編集する道具
- Claude 同士は直接通信しない。命令は固定の種類で、起動や停止に Claude の判断を挟まない
- 配置を変える前に、同じ機能をローカルで本物の Claude で成立させる。未検証の前提（書込の封じ込め、Linux での常駐）は実装前にスパイクで白黒をつける
- 変わりやすい外部事実（Claude Code の版、フラグ、仕様）は文書に確認日を残す
