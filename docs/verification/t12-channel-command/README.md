# T12: チャネル経由のコマンド実行と `--mcp-config` のチャネル登録

実施日: 2026-10-13 03:32〜03:35（JST）
実施者: Claude Code（自律実行）。人の操作はなし
環境: Mac mini（macOS 26.5.1、arm64）、Claude Code v2.1.296、Bun 1.3.9、tmux 3.8、claude.ai 認証（Max）
証拠: [`evidence/`](evidence/)（利用者名と作業フォルダの場所は伏せた）

## 結論

- チャネルで送った `/clear` はコマンドとして実行されない。Claude には文章として届き、会話は消えなかった
- 端末から `/clear` を入力すると会話は消える。チャネルの登録はそのまま残り、承認の中継も続けて動いた
- 端末の `/clear` の後、Claude Code は新しい会話 ID のファイルを作った。チャネルに渡された `CLAUDE_CODE_SESSION_ID` は起動時の値のままになる
- `--mcp-config` で定義したサーバーを `--dangerously-load-development-channels server:<name>` で指定すると、起動画面には「no MCP server configured with that name」と出る。それでも通知の流し込みと承認の中継は動いた

## 手順と結果

試験用チャネル（[`evidence/spike-channel.ts`](evidence/spike-channel.ts)）を `--mcp-config` で渡し、`--session-id` で会話 ID を指定して tmux の中で起動した。

```bash
claude --session-id <UUID> --permission-mode manual \
  --mcp-config <mcp.json> --dangerously-load-development-channels server:spike
```

| 時刻（UTC） | 操作 | 結果 |
| --- | --- | --- |
| 18:32:43 | 起動。信頼確認と開発用チャネル警告に端末で回答 | チャネルが起動。環境変数に `CLAUDE_CODE_SESSION_ID` などが渡された |
| 18:32:55 | 通知「reply tool で pong とだけ返して」 | 承認要求 `ghtmw` がチャネルに届き、チャネルから allow を返すと `pong` が返った |
| 18:33:23 | 通知「合言葉は『みかん-T12』…」 | `ok` が返った |
| 18:33:44 | 通知の本文を `/clear` にした | 画面には `← spike: /clear` と表示され、Claude は「本体のコマンドなのでこちらからは実行できない」と返信した |
| 18:34:1x | 合言葉を尋ねる通知 | `みかん-T12` が返った。会話は消えていない |
| 18:34:2x | 端末から `/clear` を入力 | 会話が消えた |
| 18:34:41 | 合言葉を尋ねる通知 | `unknown` が返った。承認要求 `axvps` もチャネルに届いた |

`~/.claude/projects/<フォルダ>/` には起動時の会話 ID（`6ae7f0bf-…`）に加えて、`/clear` 後の新しい会話 ID（`69e63b31-…`）のファイルが作られた。

## 設計への反映

- [02 ワーカー常駐プログラム](../../design/02-worker-daemon.md) の 2.1 と 8 章に記載した
- 会話の消去やコマンドの実行は Channels では行えない。必要になったら端末操作の代行（tmux へのキー送信）で実装する
- ブリッジは `.mcp.json` ではなく `--mcp-config` で渡す。表示と実動作の食い違いは版を上げるたびに確かめる
