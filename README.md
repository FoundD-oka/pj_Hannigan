# pj_Hannigan

WebChat で統括秘書 Claude Code に依頼するだけで、複数の Mac 上の案件 PM Claude Code と作業セッションに仕事が割り振られ、
進捗の監督と介入まで一元化できる、Claude Code Channels ベースの遠隔運用システム。
「AI を操作する環境」から「AI に仕事を任せ、その進行を監督する環境」への転換を目指し、最終的に OSS として公開します。

## 目指す形

```text
[あなた] WebChat（メイン窓口）            Discord（サブ窓口。最後に実装）
   │                                      │
   ▼                                      ▼
[VPS]  ハブ（WebChat 配信 + 中継 + 案件台帳 + オフライン保留） ⇄ 統括秘書 Claude Code（会話ごとに 1 セッション）
   │ 常時接続（作業 Mac 側から接続しに来る）
   ├── [作業 Mac A] ワーカー常駐プログラム ─ 案件 PM Claude Code ─ 作業セッション × N（純正 CU はここ）
   └── [作業 Mac B] ワーカー常駐プログラム ─ 案件 PM Claude Code ─ 作業セッション × N
```

- 統括秘書は会話内容から担当の Mac と案件を選び、ハブのツール（project_pm_send など）で案件 PM に指示する。Claude 同士は直接話さない
- 案件 PM は軽い作業を自分で行い、長時間・並列・GUI 操作の作業は同じ Mac の子セッションに委任して結果を集約する
- 作業 Mac では Claude ではない常駐プログラムが、tmux の中で Claude Code を起動・停止し、結果をハブへ返す
- Mac がオフラインでも依頼はハブが 24 時間保留し、復帰後に受付順で配送する
- 設定はファイルを正とし、設定画面はそれを編集する道具。秘密情報は分けて保存する

実装の順序は「ローカル実地テスト → VPS → Discord」。ハブも手元の Mac で動かして新設計を使い込み、成立してから VPS に移す。

詳細は [docs/design/00-architecture.md](docs/design/00-architecture.md)、進め方は [docs/ROADMAP.md](docs/ROADMAP.md)、画面の使い方は [docs/manual/README.md](docs/manual/README.md)（スクリーンショット付き）。

## 現状

Phase 3（ローカル実地テスト）の実装と、本物の Claude での一巡まで済んだ。設計は 2026-10-16 に Q1〜Q17 のヒアリングで改訂した（[決定記録](docs/design/CHANGELOG.md)）。次は 7 日間の日常運用。進み具合は [docs/ROADMAP.md](docs/ROADMAP.md) を参照。

| 項目 | 状態 |
| --- | --- |
| Channels × 純正 Computer Use の実機検証 | 完了（[docs/verification/claude-channels/](docs/verification/claude-channels/README.md)） |
| 設計書（全体、設定スキーマ、ワーカー常駐プログラム、通信） | 2026-10-16 改訂版（[docs/design/](docs/design/)）。VPS 秘書、案件 PM 階層、WebChat 直接介入、オフライン保留、書込直列化、Discord。Phase 3 の範囲は実装済み、VPS と Discord は未実装 |
| T12: チャネル経由のコマンド実行 | 完了。実行されない（[報告](docs/verification/t12-channel-command/README.md)） |
| T11: Remote Control × CU 承認 | 実施済み。CU 承認はスマホに届かず端末にだけ出る。承認はセッション単位（[結果](docs/verification/t11-remote-control-cu/README.md)） |
| ハブ、ワーカー常駐プログラム、WebChat（1 台構成） | 実装済み。偽 Claude での自動試験と本物の Claude での一巡を確認（[報告](docs/verification/phase2-e2e/README.md)） |
| Phase 3: ローカル実地テスト（案件 PM 階層、スレッド直接介入、会話分離、オフライン保留、書込直列化） | 実装済み。偽 Claude での自動試験 144 件と、本物の Claude での一巡 18 段階を通過（[報告](docs/verification/phase3-e2e/README.md)） |

## 使い方（Phase 3 の構成：同じ Mac でハブとワーカーを動かす）

必要なもの: macOS、[Bun](https://bun.sh) 1.3 以降、tmux、Claude Code v2.1.296 以降（claude.ai にログイン済み）。

```bash
bun install
# ハブとワーカー常駐プログラムを tmux で起動する。初回は設定と鍵を ~/.hannigan に作る（既にあれば残す）
scripts/start.sh
```

`start.sh` が表示する URL（`#token=` つき）をブラウザで開く。右上の「設定」を開き、「案件を追加」で案件 ID と Mac 上のフォルダ（例 `~/work/notes`）を入れて保存する。再起動はいらない。ワーカーの表示名と役割（秘書が振り分けに使う説明）も同じ画面で変えられる。
秘書は会話ごとに 1 つずつ、その会話の最初のメッセージで起動する。
秘書や案件 PM が起動するたびに「開発用チャネルの起動確認」が、新しいフォルダでは「フォルダの信頼確認」も承認カードとして出るので、画面のボタンで答える。
あとは WebChat に「notes で〜して」と書けば、秘書が notes の案件 PM に依頼する。PM は軽い作業を自分で行い、大きい作業は子セッションに任せて、結果を元の会話に返す。
画面のスレッド一覧から PM や子のスレッドを開くと、履歴を見たり直接書き込んだりできる。子への書き込みは PM にも通知される。

- 設定項目は [01 設定スキーマ](docs/design/01-config-schema.md)。設定画面で変えられる項目と変えられない項目は 01 の 25 章。`~/.hannigan/hub.json` と `worker.json` を直接編集してもよい（そのときは再起動で反映）
- 待ち受けポートや秘密情報、ワーカーの追加は画面から変えられない。LAN 内の 2 台目の Mac をワーカーとして足すときは、ハブ側で `bun scripts/add-worker.ts --worker <id>`、2 台目で `bun scripts/worker-setup.ts --worker <id> --key <鍵>`（[手順](docs/manual/README.md#11-2-台目の-mac-をつなぐ)）。初回の設定を手で作るときは `bun scripts/dev-setup.ts --worker home --name "自宅 Mac" --role "私用。個人の開発" --project notes=~/work/notes`（他に `--port`、`--local-port`、`--pm-off`、`--force`）
- 停止は `scripts/stop.sh`。Claude Code のセッションは tmux に残り、次の起動で引き継ぐ。セッションも終えるときは `scripts/stop.sh --sessions`
- `dev-setup.ts` の設定ではオフライン保留が有効になる。ワーカーを止めている間の依頼はハブが 24 時間保留し、再起動後に受付順で届ける
- 試験: `bun test`（偽 Claude を使うので利用枠を使わない。全件で約 6 分）。本物の Claude での一巡は `bun test/e2e-real.ts <証拠の出力先>`（利用枠を使う）

## 前提と制約（2026-10-13 時点の公式資料と実測）

- Channels は研究プレビュー。自作チャネルは `--dangerously-load-development-channels` で起動し、起動ごとに端末で警告を承認する
- Channels は「起動済みの 1 セッションに出来事を流し込む」一方向の仕組み。新しいスレッドの作成やフォルダの切り替えはできないため、ワーカー常駐プログラムがプロセスの起動で代替する
- 純正 Computer Use のアプリ承認、実行中の停止、起動時警告は端末にしか出ない。通常ツールの承認は Channels で中継できる
- 1 台の Mac で Computer Use を使えるセッションは同時に 1 つ
- チャネルから `/clear` などのコマンドは実行できない（T12）

## ライセンス

MIT License。[LICENSE](LICENSE) を参照。

## 由来

`FoundD-oka/CC-projects-concierge_test` の `test/claude-channels-cu` ブランチ（コミット `a97e913`）から履歴ごと移植。
