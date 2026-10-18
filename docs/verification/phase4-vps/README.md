# Phase 4: VPS 配置の実機確認

実施日: 2026-10-18〜19（JST）
実施者: Claude Code（このリポジトリの開発セッション）が SSH で VPS を操作。Claude Code のログイン承認、公開鍵の登録、ブラウザでの確認は利用者。
環境: XServer VPS（Ubuntu 24.04 LTS x86_64、仮想 4 コア、6GB、`hannigan.found-d.com`）。VPS 側 Claude Code v2.1.302、Bun 1.4.3、tmux 3.4、Caddy 2.6.2（同居する別プロジェクト ccr-ingress のもの）。ワーカーは自宅の M4 Mac mini（Claude Code v2.1.302、Bun 1.3.9）。設計は [04](../../design/04-vps-deployment.md)。

## 結論

スパイク S3 の 6 項目のうち 5 つが成立し、残り 1 つ（24 時間の安定性）は経過待ち。WP1〜WP3 の中核（ペアリング、WSS、VPS 配置、systemd、Mac からの接続）が本物の Claude で一巡した。

| S3 | 確認すること | 結果 |
| --- | --- | --- |
| 1 | Linux 版 Claude Code の導入とログイン | 成立。公式の導入スクリプトで `hannigan` ユーザーに入れ、`claude auth login` を tmux の中で実行し、利用者がブラウザで承認。`claude auth status` が `loggedIn: true`、`subscriptionType: max` |
| 2 | tmux の中で起動し、画面読み取りで状態が取れる | 成立（下の「見つかった問題」1 を直した後）。`starting → awaiting_terminal → ready → working` が Mac と同じ判定で取れた |
| 3 | 開発用チャネルの起動時確認 | 成立。Linux でも同じ文言・同じ選択肢で、WebChat の承認カードから答えられた |
| 4 | 会話別セッションの `--resume` | 成立。秘書を停止 API で止めて同じ会話に送ると `--resume` で再開し、前の要約を覚えていた |
| 5 | プロセス監視下での復元 | 成立。`systemctl restart hannigan-hub` のあと、tmux の秘書は生きたまま（`KillMode=process`）、ブリッジが再接続し、ワーカーも戻り、同じ会話が続いた |
| 6 | 常駐の安定性（24 時間） | 未。翌日に `/status` と 1 往復で確かめる |

## 1. 配置した構成

| 項目 | 値 |
| --- | --- |
| 公開 URL | `https://hannigan.found-d.com`（WebChat）、`wss://hannigan.found-d.com/ws/worker`（ワーカー） |
| DNS | XServer の DNS 設定で A レコード `hannigan` → 162.43.38.222 を追加（2026-10-18） |
| TLS | 既存の Caddy に `/etc/caddy/hannigan.caddy` を足し、ccr-ingress の `Caddyfile.template` と稼働中の `Caddyfile` に `import` を 1 行追加。証明書は Caddy が Let's Encrypt から TLS-ALPN-01 で自動取得（reload から約 10 秒） |
| ハブ | `/home/hannigan/pj-Hannigan`、`HANNIGAN_HOME=/home/hannigan/.hannigan`、`listen 127.0.0.1:8800`、`public_url` を設定。systemd `hannigan-hub.service`（User=hannigan、Restart=always、KillMode=process） |
| 秘書 | VPS 上の tmux（`hn-secretary-<id>`）。`hannigan` ユーザーの Claude Code（claude.ai の Max アカウント） |
| ワーカー | 自宅 Mac。設定画面で発行したコードで `scripts/pair.ts https://hannigan.found-d.com <code> --worker m4-mini --force` を実行し、`worker.json` の `hub_url` が `wss://…` に。`scripts/start.sh worker` で起動 |
| 同居 | 同じ VPS で ccr（OpenClaw、Authelia）が動いている。Caddy と 443 を共有し、Hannigan のハブは別ユーザー・別ポートで、ccr のサイトは触っていない（追加前後とも `https://162.43.38.222/` は 200） |

手順は `scripts/vps-setup.sh` にまとめた（この実機では手で同じことをした）。設定ファイルは `deploy/systemd/hannigan-hub.service` と `deploy/caddy/hannigan.caddy`。

## 2. 本物の Claude での一巡（2026-10-19 01:52 JST）

会話 `vps-s3-1` に「自宅 Mac の notes で、README.md を読んで 1 行で要約して。小さい作業なので PM 自身でやって」と送った（WebChat と同じ HTTP API を HTTPS 越しに使い、承認カードには人と同じ選択で答える小さな台本を使った）。

| # | 起きたこと | 時刻 |
| --- | --- | --- |
| 1 | VPS で秘書が起動。開発用チャネルの確認カード → 答えると `ready`、`working` | 01:52:00〜04 |
| 2 | 秘書が `project_pm_send` を呼び、依頼が wss 越しに自宅 Mac へ（`accepted → worker_queued`） | 01:52:07 |
| 3 | Mac で PM が起動。フォルダの信頼確認と開発用チャネルの確認カードに答える | 01:52:09〜10 |
| 4 | 秘書の 1 回目の返事「PM に依頼しました。報告が届いたら一言で」 | 01:52:10 |
| 5 | PM の報告「README.md の要約（1行）: このリポジトリ「notes」は個人のメモ置き場である…」が wss 越しに VPS へ | 01:52:25 |
| 6 | 秘書の 2 回目の返事「終わりました。要約：「notes は個人のメモ置き場」…（PM 自身が読み、ファイルは変更していません）」 | 01:52:28 |

続けて、秘書を停止 API で止めてから「さっき要約してもらった README の内容を、もう一度一言で」と送ると、`--resume` で再開した秘書が「「notes は個人のメモ置き場」です。」と答えた（01:53:02）。その後 `systemctl restart hannigan-hub` を行い、再起動直後の「まだ会話は続いてる？」に「はい、続いています（README 要約の件も覚えています）。」と答えた（01:53:40）。

## 3. 見つかった問題と直したこと

| # | 問題 | 原因 | 対処 |
| --- | --- | --- | --- |
| 1 | 秘書が起動しても `ready` にならず、90 秒ごとに再起動を繰り返す | Linux の新しいユーザーでは Claude Code が初回の「テーマを選ぶ」画面を出し、ハブの画面判定が知らない | `~/.claude.json` に `hasCompletedOnboarding: true` と `theme` を書く。`scripts/vps-setup.sh` に入れた。画面判定にこのダイアログを足すのは今後の課題 |
| 2 | 1 を直したあと、開発用チャネルの確認に答えると 1 秒で終了し、再起動を繰り返す | 初回起動がダイアログで止まったまま再起動するとハブが `--resume <id>` で起動し、会話記録が無いので Claude Code が「No conversation found with session ID」で終了する | `shared/session-manager.ts`: `~/.claude/projects` に `<id>.jsonl` が無ければ `--resume` せず `--session-id` で起動する（コミット 9d1b483）。試験は `HANNIGAN_CLAUDE_PROJECTS_ROOT` で記録の場所を差し替え、偽 Claude が記録ファイルを作る |
| 3 | HTTPS 越しの出来事ストリーム（SSE）に新しい出来事が流れてこない | Caddy の `encode gzip` が `text/event-stream` を圧縮のためにためていた | `hannigan.caddy` から `encode gzip` を外した（`flush_interval -1` は残す） |
| 4 | Claude Code に渡す `SHELL` が `/bin/zsh` 固定で、Ubuntu には無い | ハブが systemd 配下で動くと `SHELL` 環境変数が無く、既定値を Mac 向けにしていた | 存在するシェルを選ぶ（Linux は `/bin/bash` から） |
| 5 | 公開リポジトリが古く、2 台目の Claude が `scripts/` を見つけられなかった | Phase 1 以降の 13 コミットが未 push だった | push。2 台目向けプロンプトに「スクリプトが無ければ push 漏れとして止まる」判定を足した |

## 4. Phase 4 の出口条件に対する現状

| 出口条件 | 状態 |
| --- | --- |
| 2 台以上のワーカーを別ネットワークから同時につなぎ、WebChat から使い分けて結果が戻る | 1 台（自宅 Mac、インターネット経由の wss）で結果が戻ることを確認。会社の Mac は、設定画面の「ワーカーを追加」で出るプロンプトをその Mac の Claude Code に貼れば足せる状態。未実施 |
| ワーカーの Mac を再起動しても、常駐プログラムが自動でハブへ戻る | 未。launchd（WP3）が未実装。手動の `scripts/start.sh worker` では wss 再接続（`Backoff`）が働くことを確認 |
| VPS を再起動しても、秘書セッションと保留キューが復元され、期限内の依頼が配送される | ハブの再起動（systemd restart）では秘書と会話が残った。VPS 自体の再起動（tmux サーバーも消える）は未。この場合は秘書が `--resume` で再開される設計で、会話記録は残る |
| CU のアプリ承認を遠隔から完了できる（補助経路） | 未 |

## 5. 残っていること

- S3 の 6（24 時間の安定性）を翌日に確認する
- 会社の Mac を足す（別ネットワークからの 2 台目。利用者がプロンプトを貼る）
- launchd で Mac のワーカーを自動起動（WP3）。VPS 再起動の試験（WP2 の復元）
- 画面判定に Claude Code の初回設定ダイアログを足すか、起動時に設定済みの印を確かめる
- `hannigan.found-d.com` の `/` は WebChat の HTML を誰にでも返す（操作にはトークンが要る）。公開から数分でスキャナーの `/api/graphql` 等へのアクセスが来ており（401 で拒否）、Phase 6 の監視項目にする
- ccr-ingress の元リポジトリ（Control_VPS_byClaw）にも `import /etc/caddy/hannigan.caddy` の 1 行を入れる（利用者の作業）。入れないと、そちらの再配置で Hannigan の入口が消える
