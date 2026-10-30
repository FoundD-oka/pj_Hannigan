# 05 OpenMausBot と Mac をつなぐ中継

作成日: 2026-10-31。実機の確認は [omb-mac-relay](../verification/omb-mac-relay/README.md)。

VPS の OpenMausBot から、Mac の純正 Computer Use（以下 CU）を使えるようにする仕組み。HANDOFF 5.2 の統合の形 D（OpenMausBot を改造せず、ACP エンジンとして外付けする）を採用した。

## 1. D を選んだ理由

- OpenMausBot には、エンジンを別の PC で動かす機能がない。「Share this computer」はターミナルと画面を貸す機能で、エンジンはサーバーで動く。画面操作は cua-driver で、純正 CU ではない
- フォーク（A）は追従の負担が大きい。2026-10-24〜30 の 6 日で 0.1.127 から 0.1.134 まで上がり、ACP まわりの変更も多かった
- D の弱点だった「お任せ」の自動許可は、質問カードで避けられた（4 章）

## 2. 構成

```text
Chrome・iPhone
   │ HTTPS
Caddy（hannigan.found-d.com）
   ├─ /hannigan-relay/*  → 中継サーバー 127.0.0.1:8820  ←── wss（Mac が外向きに接続）── Mac の常駐プログラム
   └─ それ以外            → OpenMausBot 127.0.0.1:8799                                      │
                              │ customAcp（会話ごとに起動）                                  ├─ SessionManager（Hannigan）
                              └─ acp-client ── unix ソケット ── 中継サーバー                  ├─ bridge.ts（チャネル）
                                                                                            └─ tmux の中の対話型 Claude Code
```

| 部品 | ファイル | 動く場所 | 役割 |
| --- | --- | --- | --- |
| 中継サーバー | `relay/server.ts` | VPS（Node 24、systemd `hannigan-relay`） | Mac の wss と acp-client の unix ソケットをつなぐ。ACP の中身は読まない。Mac の鍵とペアリング |
| ACP クライアント | `relay/acp-client.ts` | VPS（OpenMausBot が起動） | `initialize`、`session/new`、`session/load` に自分で答え、ほかを中継へ流す。状態を持たない |
| Mac の常駐プログラム | `relay/mac-agent.ts` | Mac（Bun） | Claude Code のセッションを持つ。依頼を届け、会話記録から発言とツール実行を返し、端末ダイアログをカードにする |
| 通信路 | `relay/link.ts` | 両方 | 切れても順序どおり 1 回だけ届ける |
| tmux サーバーの起動 | `relay/start-tmux-server.command` | Mac（Terminal.app が実行） | CU の macOS 権限を Terminal.app から引き継ぐ（4 章） |

VPS 側は `bun build --target=node` で 1 ファイルにまとめて配る（`scripts/deploy-relay.sh`）。Mac 側は Hannigan の `shared/` をそのまま使うので Bun で動く。

## 3. セッションの持ち主は Mac

OpenMausBot は acp-client を自由に作り直す（停止のあと、アイドル、再起動）。第 1 段階の試作はこれに引きずられて Claude が再起動し、CU のアプリ承認が消えた。そこで次のように分けた。

- `session/new` は acp-client が UUID を決めるだけ。Claude は Mac が最初の依頼で起動する。この UUID が Claude の会話 ID になる
- `session/load` は acp-client が受け流す。Mac は次の依頼で、生きているセッションへ届けるか、`--resume` で起こす
- acp-client が消えても（中継の `close`）、Claude は止めない。実行中のターンだけ Esc で止める
- 30 分アイドルのセッションは止める（`idle_stop_minutes`）。CU のロックはセッションの終了まで外れないので、持ったままにしない。次の依頼で `--resume` するので、そのときは CU のアプリ承認を取り直す
- 常駐プログラムが再起動しても、tmux の Claude は残る。チャネルが同じ `local_port` へつなぎ直す

## 4. 端末ダイアログと承認

| 端末に出るもの | 扱い |
| --- | --- |
| 開発用チャネルの確認 | 自動で承認（自分のチャネル） |
| フォルダの信頼 | ペアリングで指定した `cwd` だけ自動で承認 |
| CU のアプリ承認 | 質問カード。`toolCallId` を `interaction_` で始めると、OpenMausBot は質問として扱い、承認レベルが「お任せ」でも自動で答えない |
| macOS の権限が未付与 | カードにしない。チャットに案内を出して、ターンを止める |
| その他の端末ダイアログ | 質問カード（選択肢をそのまま出す） |
| Bash や Edit などのツール承認 | チャネルの permission relay から、普通の承認カードにする。こちらは OpenMausBot の承認レベルに従う |

- CU の macOS 権限は、tmux サーバーを起動したアプリから引き継がれる。launchd から起動した tmux には権限がなかったので、常駐プログラムは `open -a Terminal` で `start-tmux-server.command` を開き、`keepalive` セッションで起動を確かめてから Claude を起動する。Terminal.app に権限を付けておけば、システム設定の追加の操作は要らない。tmux サーバーを起動するたびに Terminal のウィンドウが開くのが弱点。配布版の正式な形（署名した小さなアプリに権限を付けるなど）は未定
- 描画途中の画面を別のダイアログとして拾うので、700ms 落ち着いてからカードを出す。カードが開いたあとに描き直されたら、回答は最新のダイアログへ送る
- CU の拒否は `{"granted":[],"denied":[]}` しか返らないので、選択キーを送る前にチャネルで「拒否された、頼み直さない」と伝える

## 5. 接続が切れたとき

`ReliableLink` は未確認の出来事を両端のメモリに持ち、つながり直すと届いていない分から送り直す。常駐プログラムと中継サーバーは、起動ごとに変わる `epoch` を握手で交換する。相手が再起動していたらキューを捨て、開いているチャネルを閉じる。OpenMausBot は次の依頼で `session/load` から始める。

| 状況 | 動き |
| --- | --- |
| ターンの途中で切れた | Mac は作業を続ける。30 秒でチャットに「切れた」と出す。つながり直すと続きが流れる。15 分戻らなければターンを失敗にして、Mac へ停止を送る |
| 依頼の時点で Mac がオフライン | 15 秒待って、戻らなければ「オフライン」と返す。保留はしない |
| 中継サーバーや常駐プログラムの再起動 | 開いていたチャネルが閉じ、acp-client は終了する。OpenMausBot が次の依頼で作り直す |

## 6. 裏の仕事

OpenMausBot の記憶の整理（`generateMemoryText`）は、空のフォルダ `omb-acp-memory-*` で 1 回限りの ACP セッションを開く。Mac に対話型の Claude を起動しないよう、acp-client はこのフォルダを見分け、VPS の `claude -p --tools ""` で答える。フォルダ名は OpenMausBot の内部の決まりなので、版を上げたら確かめる。

## 7. Mac を足す手順

```bash
# VPS で 1 回限りのコードを出す（10 分）
sudo -iu hannigan node /home/hannigan/hannigan-relay/server.js pair --mac ID
```

```bash
# Mac で（リポジトリ、Bun、tmux、Claude Code が必要）
bun relay/mac-agent.ts pair https://hannigan.found-d.com CODE --mac ID --cwd 作業フォルダ
scripts/install-mac-agent.sh
```

CU を使う Mac では、次の 2 つを先に済ませる。付けたあとに起動した tmux サーバーだけが権限を持つので、順番が大事。

- Terminal.app に Accessibility と Screen Recording を付ける
- 作業フォルダで `claude` を開き、`/mcp` で computer-use を有効にする。新しいフォルダでは無効になっている（2026-10-31、2.1.311 で確認）

VPS の `~/.openmausbot/config.json` の `instances` に `customAcp` を足し、OpenMausBot を再起動する。`config.cli` は `/usr/bin/node /home/hannigan/hannigan-relay/acp-client.js --mac ID`。

- `instances` を書くと標準のエンジン一覧は使われなくなる。`claude` などの標準の項目を必ず一緒に残す（2026-10-31 に Mac の項目だけ書いて、VPS の Claude を止めてしまった）
- ボットのエンジンは、0.1.134 からチャット上部のモデル欄で切り替えられる。Mac のエンジンがエンジン名の見出しで並び、選ぶとボットの `modelSelection` に保存される。0.1.127 の npm 版には無く、API（`PATCH /api/bots/ID`）で設定していた

## 8. まだ移していないもの

- 案件の切り替え。今は Mac ごとに作業フォルダ 1 つ。ACP のモデル一覧で案件を選べるようにする案がある
- Hannigan の案件 PM 階層、書込リース、Mac がオフラインの間の保留配送（24 時間）
- 1 台の Mac で CU を使うセッションを 1 本に絞る決まり。今は 2 本目の CU がロックのエラーになる
