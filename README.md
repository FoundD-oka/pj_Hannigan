# pj_Hannigan

WebChat だけで会話し、手元の秘書 Claude Code が複数の Mac 上の Claude Code に仕事を振り分ける、
Claude Code Channels ベースの遠隔運用システム。最終的に OSS として公開することを目標にしています。

## 目指す形

```text
[あなた] WebChat
   │
   ▼
[ハブ Mac]  ハブ（WebChat UI + 中継 + 秘書用チャネル） ⇄ 秘書 Claude Code
   │ 常時接続（作業 Mac 側から接続しに来る）
   ├── [作業 Mac A] ワーカー常駐プログラム ─ Claude Code セッション（プロジェクトごとに 1 つ）
   └── [作業 Mac B] ワーカー常駐プログラム ─ Claude Code セッション（プロジェクトごとに 1 つ）
```

- 秘書 Claude はハブのツール（session_create / session_send など）を呼ぶだけ。Claude 同士は直接話さない
- 作業 Mac では Claude ではない常駐プログラムが、tmux の中で Claude Code を起動・停止し、結果をハブへ返す
- 設定はファイルを正とし、設定画面はそれを編集する道具。秘密情報は分けて保存する

詳細は [docs/design/00-architecture.md](docs/design/00-architecture.md)、進め方は [docs/ROADMAP.md](docs/ROADMAP.md)。

## 現状

Phase 2（1 台で動く MVP）まで実装済み。進み具合は [docs/ROADMAP.md](docs/ROADMAP.md) を参照。

| 項目 | 状態 |
| --- | --- |
| Channels × 純正 Computer Use の実機検証 | 完了（[docs/verification/claude-channels/](docs/verification/claude-channels/README.md)） |
| 設計書（設定スキーマ、ワーカー常駐プログラム、通信） | 完了（[docs/design/](docs/design/)） |
| T12: チャネル経由のコマンド実行 | 完了。実行されない（[報告](docs/verification/t12-channel-command/README.md)） |
| T11: Remote Control × CU 承認 | 実施済み。CU 承認はスマホに届かず端末にだけ出る。承認はセッション単位（[結果](docs/verification/t11-remote-control-cu/README.md)） |
| ハブ、ワーカー常駐プログラム、WebChat（1 台構成） | 実装済み。偽 Claude での自動試験と本物の Claude での一巡を確認（[報告](docs/verification/phase2-e2e/README.md)） |

## 使い方（Phase 2：同じ Mac でハブとワーカーを動かす）

必要なもの: macOS、[Bun](https://bun.sh) 1.3 以降、tmux、Claude Code v2.1.296 以降（claude.ai にログイン済み）。

```bash
bun install
# 設定と鍵を ~/.hannigan に作る（既にあれば残す）
bun scripts/dev-setup.ts --worker home --name "自宅 Mac" --role "私用。個人の開発" \
  --project notes=~/work/notes
# ハブとワーカー常駐プログラムを tmux で起動する
scripts/start.sh
```

`start.sh` が表示する URL（`#token=` つき）をブラウザで開く。最初に秘書セッションの「フォルダの信頼確認」と「開発用チャネルの起動確認」が承認カードとして出るので、画面のボタンで答える。
あとは WebChat に「notes で〜して」と書けば、秘書がワーカーのセッションを作って作業させ、結果を返す。

- 設定項目は [01 設定スキーマ](docs/design/01-config-schema.md)。`~/.hannigan/hub.json` と `worker.json` を直接編集してよい
- 停止は `scripts/stop.sh`。Claude Code のセッションは tmux に残り、次の起動で引き継ぐ。セッションも終えるときは `scripts/stop.sh --sessions`
- 試験: `bun test`（偽 Claude を使うので利用枠を使わない）。本物の Claude での一巡は `bun test/e2e-real.ts <証拠の出力先>`

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
