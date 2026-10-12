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

| 項目 | 状態 |
| --- | --- |
| Channels × 純正 Computer Use の実機検証 | 完了（[docs/verification/claude-channels/](docs/verification/claude-channels/README.md)） |
| 検証用 WebChat チャネル（ハブの原型） | [prototype/webchat-test/](prototype/webchat-test/) |
| Remote Control で CU のアプリ承認が遠隔に届くかの検証 | 未着手 |
| 設定スキーマ・ハブ・ワーカー常駐プログラムの設計 | 着手（設計書を作成中） |

## 前提と制約（2026-10-12 時点の公式資料と実測）

- Channels は研究プレビュー。自作チャネルは `--dangerously-load-development-channels` で起動し、起動ごとに端末で警告を承認する
- Channels は「起動済みの 1 セッションに出来事を流し込む」一方向の仕組み。新しいスレッドの作成やフォルダの切り替えはできないため、ワーカー常駐プログラムがプロセスの起動で代替する
- 純正 Computer Use のアプリ承認、実行中の停止、起動時警告は端末にしか出ない。通常ツールの承認は Channels で中継できる
- 1 台の Mac で Computer Use を使えるセッションは同時に 1 つ

## ライセンス

MIT License。[LICENSE](LICENSE) を参照。

## 由来

`FoundD-oka/CC-projects-concierge_test` の `test/claude-channels-cu` ブランチ（コミット `a97e913`）から履歴ごと移植。
