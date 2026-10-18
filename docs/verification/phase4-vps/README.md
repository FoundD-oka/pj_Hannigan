# Phase 4: VPS 配置の実機確認

実施日: 2026-10-18〜19（JST）。launchd と VPS 再起動は 2026-10-19 02:24〜06:52 JST に追加
実施者: Claude Code（このリポジトリの開発セッション）が SSH で VPS を操作。Claude Code のログイン承認、公開鍵の登録、ブラウザでの確認は利用者。
環境: XServer VPS（Ubuntu 24.04 LTS x86_64、仮想 4 コア、6GB、`hannigan.found-d.com`）。VPS 側 Claude Code v2.1.302、Bun 1.4.3、tmux 3.4、Caddy 2.6.2（同居する別プロジェクト ccr-ingress のもの）。ワーカーは自宅の M4 Mac mini（Claude Code v2.1.302、Bun 1.3.9）。設計は [04](../../design/04-vps-deployment.md)。

## 結論

スパイク S3 の 6 項目のうち 5 つが成立し、残り 1 つ（24 時間の安定性）は経過待ち。WP1〜WP3 の中核（ペアリング、WSS、VPS 配置、systemd、Mac からの接続）が本物の Claude で一巡した。続けて WP3 の launchd（Mac のワーカーの自動起動）と WP2 の残り（VPS 自体の再起動）を実機で確認した（4 章）。

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
| ワーカーの Mac を再起動しても、常駐プログラムが自動でハブへ戻る | launchd のユーザー LaunchAgent として導入（4.1）。daemon を `kickstart -k` と `kill -9` で殺しても 10 秒以内に戻り、tmux の PM は生き残った。Mac 自体の再起動は利用者の操作待ち（4.1 の最終行） |
| VPS を再起動しても、秘書セッションと保留キューが復元され、期限内の依頼が配送される | VPS を `reboot` し、hub が自動起動、秘書が `--resume` で同じ会話を再開して再起動前に覚えた合言葉を答え、保留キューの 1 件が残った（4.2）。保留の配送は Mac のワーカーが戻った時点で確認する |
| CU のアプリ承認を遠隔から完了できる（補助経路） | 未 |

### 4.1 ワーカーの Mac の自動起動（WP3、launchd）

入れたもの: `deploy/launchd/com.hannigan.worker.plist`（テンプレート）、`scripts/install-launchd.sh`、`scripts/uninstall-launchd.sh`。`start.sh worker` は launchd 導入済みなら tmux で起動せず再起動コマンドを案内し、`stop.sh` も launchd の止め方を案内する。

| 決めたこと | 中身 |
| --- | --- |
| 起動の形 | launchd が `bun worker/daemon.ts` を直接起動する（tmux の中ではない）。`RunAtLoad` でログイン時に起動、`KeepAlive` で終了のたびに再起動（`ThrottleInterval` 10 秒）。ログは `StandardOutPath`/`StandardErrorPath` で `~/.hannigan/logs/worker.log` に追記 |
| 環境変数 | `HANNIGAN_HOME` と `PATH`（bun・claude・tmux の場所を install が探して埋める）、`LANG`。`HOME` は launchd が入れる |
| セッションの生存 | Claude Code のセッションは従来どおり daemon が tmux に作る。tmux サーバーは自分のプロセスグループで動くので launchd の停止に巻き込まれない。念のため `AbandonProcessGroup` を true にして、launchd が止めるのは daemon だけにする（systemd の `KillMode=process` 相当） |
| 二重起動の防止 | install が tmux 方式の `hn-worker` を止めてから bootstrap する（同じ `127.0.0.1:8801` と同じ `worker_id` で 2 つ動かさない） |
| daemon の場所 | plist は install を実行したリポジトリを指す。この Mac では `--repo` で main の checkout を指定した（worktree は消えるため） |

実機（自宅 Mac、macOS 26.5.1、2026-10-19 02:24〜02:25 JST）:

| # | 操作 | 結果 |
| --- | --- | --- |
| 1 | `scripts/install-launchd.sh --repo <main の checkout>` | `hn-worker` の tmux を止め、2 秒後に `running pid 82828`。worker.log に `worker started` → 40 ms 後に `connected to hub`（wss）。VPS の `/api/state` で `m4-mini` が `connected: true`。tmux に残っていた PM（`hn-notes-18c2fc37`）の bridge が 1.3 秒後に新しい daemon へ再接続 |
| 2 | `launchctl kickstart -k gui/501/com.hannigan.worker` | daemon が SIGTERM で `worker stopping (sessions keep running)`、0.2 秒後に新しい pid で `worker started`、`connected to hub`、bridge 再接続。tmux の PM は生存 |
| 3 | `kill -9 <pid>` | launchd が `spawn scheduled` にし、10 秒後（ThrottleInterval）に再起動、同じく再接続。tmux の PM は生存 |
| 4 | Mac を再起動（利用者の操作） | 未実施。結果はこの行を更新する |

注意: この Mac のリポジトリは外付けディスク（`/Volumes/SanD`）にある。ログイン直後にまだマウントされていなければ bun が daemon.ts を開けずに終了するが、`KeepAlive` が 10 秒ごとに起動し直すので、マウント後に自然に立ち上がる想定（Mac 再起動の試験で確かめる）。

### 4.2 VPS 自体の再起動（WP2 の残り）

手順（2026-10-19 JST）: 02:26 に WebChat の会話 `vps-s3-1` で秘書に合言葉「青いリンゴ 1019」を覚えさせた → 02:27 に Mac のワーカーを `launchctl bootout` で止め、秘書経由で notes PM 宛ての依頼（README.md の 1 行目）を出して保留にした（`hub/offline-requests.jsonl` に `pending_offline` 1 件、期限 24 時間）→ 利用者の了解を得て 06:51 に `reboot`。

| # | 確認すること | 結果 |
| --- | --- | --- |
| 1 | `hannigan-hub.service` が自動起動する | 成立。06:51:23 に systemd が起動し、06:51:24 に `hub started`（起動から約 1 分で ssh が戻り、その時点で `active`） |
| 2 | 秘書が同じ会話で `--resume` 再開し、履歴が残る | 成立。tmux サーバーは消えていたので hub は秘書を `stopped` にしていた。会話に「合言葉は？」と送ると `session launch … resume: true` で `hn-secretary-86919f84` を作り直し、開発用チャネルの確認カードに答えて 10 秒後に「青いリンゴ 1019」と返した |
| 3 | 保留キュー（`hub/offline-requests.jsonl`）が残る | 成立。再起動後も同じ 1 件が `pending_offline` のまま（`/api/offline-requests` と `/api/state` で確認） |
| 4 | 期限内の依頼が、ワーカーが戻ったときに配送される | Mac のワーカー復帰（4.1 の 4）と同時に確認する |
| 5 | 同居する ccr のサービスが戻る | caddy、ccr-authelia、ccr-bots、ccr-bots-openclaw、ccr-ws-bridge の 5 つが `active`（Hannigan 側は触っていない） |

WebChat の操作は VPS 上の小さな台本（`/root/hn-chat.py`。トークンを VPS の外に出さず、起動時の確認カードに人と同じ選択で答える）で行った。リポジトリには入れていない。

## 5. 残っていること

- S3 の 6（24 時間の安定性）を翌日に確認する
- 会社の Mac を足す（別ネットワークからの 2 台目。利用者がプロンプトを貼る）
- Mac 自体の再起動で launchd のワーカーが戻ることと、保留の依頼が配送されること（4.1 の 4、4.2 の 4）。外付けディスクのマウント待ちの挙動も同時に見る
- 画面判定に Claude Code の初回設定ダイアログを足すか、起動時に設定済みの印を確かめる
- `hannigan.found-d.com` の `/` は WebChat の HTML を誰にでも返す（操作にはトークンが要る）。公開から数分でスキャナーの `/api/graphql` 等へのアクセスが来ており（401 で拒否）、Phase 6 の監視項目にする
- ccr-ingress の元リポジトリ（Control_VPS_byClaw）にも `import /etc/caddy/hannigan.caddy` の 1 行を入れる（利用者の作業）。入れないと、そちらの再配置で Hannigan の入口が消える
