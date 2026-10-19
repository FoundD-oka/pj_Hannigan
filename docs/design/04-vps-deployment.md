# Phase 4: VPS 配置の設計と作業計画

作成日: 2026-10-18。Phase 3 の実機確認で、会社の Mac が自宅の Mac と別のネットワークにいて SSH トンネルでは届かないことが分かり（CHANGELOG 3j）、ROADMAP の Phase 4 を前倒しで着手する。
前提の設計は [00](00-architecture.md)（Q1/A: 秘書とハブは VPS）、[01 §6](01-config-schema.md)（ペアリングの形）、[01 §9](01-config-schema.md)（VPS で確認する項目）、[03 §1](03-hub-worker-protocol.md)（WSS 必須、平文 ws は localhost だけ）。本書はそれを実装の単位に落とす。

## 1. 実機の前提（2026-10-18 に確認）

| 項目 | 値 | 確認方法 |
| --- | --- | --- |
| VPS | XServer VPS、IP 162.43.38.222、6GB メモリ、仮想 4 コア、NVMe 150GB、OS イメージ「OpenClaw」（中身の OS は S3 で確認） | XServer の契約管理ページ |
| ログイン | root、鍵認証のみ。この Mac の鍵 `~/.ssh/hannigan-vps`（ed25519、2026-10-18 作成）を VPS の `authorized_keys` に足して使う | `ssh -o BatchMode=yes` で `Permission denied (publickey)` |
| ドメイン | `found-d.com`（XServer で DNS 管理、ネームサーバー ns1〜3.xvps.ne.jp）。`hannigan.found-d.com` の A レコード → 162.43.38.222 を 2026-10-18 に追加（TTL 3600） | XServer の DNS 設定、`dig` |
| 公開 URL | `https://hannigan.found-d.com`（WebChat）、`wss://hannigan.found-d.com/ws/worker`（ワーカー） | 本書で決定 |
| ワーカー Mac | 自宅の M4 Mac mini（ハブも動いていた Mac）と、会社の Mac。別ネットワーク | Phase 3 の実機確認 |

## 2. 配置

```text
                      HTTPS / WSS                 localhost
ブラウザ（PC・スマホ） ──────────┐             ┌── Caddy :443 ──► ハブ 127.0.0.1:8800
                                 ├─► VPS ──────┤                     │ /bridge（localhost だけ）
自宅 Mac ワーカー ── wss ────────┤             │                     └─► 秘書 Claude Code（会話ごと、tmux）
会社 Mac ワーカー ── wss ────────┘             └── systemd: caddy、hannigan-hub
```

- ハブは `listen.host=127.0.0.1` のまま。Caddy（証明書を Let's Encrypt から自動で取るリバースプロキシ）が 443 で受けて `127.0.0.1:8800` へ渡す。WebSocket は Caddy が素通しする。80 は証明書の取得と 443 への転送だけ
- ワーカーは `worker.json` の `hub_url` を `wss://hannigan.found-d.com/ws/worker` にする。Mac 側のポート開放は無し（接続型）
- 平文 `ws://` は従来どおり localhost からだけ受け付ける。`/bridge` は localhost 以外を 403 で断る（実装済み）。`/ws/worker` は Caddy 経由の接続だけが外から届く
- VPS 上では専用ユーザー `hannigan` で動かす（root では動かさない）。`HANNIGAN_HOME=/home/hannigan/.hannigan`、リポジトリは `/home/hannigan/pj-Hannigan`
- 秘書 Claude Code は VPS 上で `hannigan` ユーザーとして tmux の中で動く。ログインは claude.ai のアカウントで、初回だけブラウザでの承認が要る（S3）

## 3. スパイク S3: VPS で Claude Code を常駐させる

ROADMAP の S3。白黒をつける項目と、確認のしかた。

| # | 確認すること | 方法 | 成立の基準 |
| --- | --- | --- | --- |
| 1 | Linux 版 Claude Code の導入とログイン | 公式の導入手順で入れ、`claude --version`。`claude` を起動してログイン URL をブラウザで開き承認する（利用者の操作） | 対話セッションが起動し、`/status` でログイン済みと出る |
| 2 | tmux の中で起動し、画面読み取りで状態が取れる | `shared/session-manager.ts` と同じ引数で tmux に起動し、`pane.ts` の判定（入力待ち、作業中、確認ダイアログ）が Linux の画面でも合う | Phase 2 の試験 `pane.test.ts` の判定が実機の画面で一致 |
| 3 | 開発用チャネルの起動時確認 | `--dangerously-load-development-channels` の確認ダイアログが Linux でも同じ文言・同じ選択肢で出る | WebChat の承認カードから答えられる |
| 4 | 会話別セッションの `--resume` | 秘書を 1 つ作って止め、同じ UUID で再開する。履歴とチャネル登録が残る | Phase 3 の 3 章 5 と同じ結果 |
| 5 | プロセス監視下での復元 | systemd でハブを起動し、`systemctl restart` 後に秘書セッション群（tmux）と `hub/` の台帳が復元される | 再起動後に同じ会話から依頼でき、保留キューが残る |
| 6 | 常駐の安定性 | 24 時間置いてセッションが落ちない、ログイン切れが起きない | 翌日の `/status` と秘書への 1 往復 |

S3 で分かったこと（2026-10-19）: Linux の新規ユーザーでは Claude Code が初回の「テーマを選ぶ」画面を出すので `~/.claude.json` に設定済みの印を先に書く。会話記録が無いセッションを `--resume` すると Claude Code が即終了するので、記録の有無で `--resume` と `--session-id` を切り替える（コミット 9d1b483）。Caddy の `encode gzip` は SSE をためるので使わない。

不成立のときの逃げ道: 1 か 3 が成立しなければ、秘書だけ自宅 Mac に残す構成（ハブは VPS、秘書は Mac をワーカーの一種として扱う）を 00 に対する変更として検討する。

## 4. 作業単位

| WP | 内容 | 主な変更 | 試験 |
| --- | --- | --- | --- |
| S3（2026-10-19 実施。6 項目中 5 つ成立、24 時間の安定性は経過待ち。[報告](../verification/phase4-vps/README.md)） | 上の表。VPS に `hannigan` ユーザー、bun、tmux、Claude Code を入れ、ログインまで | `scripts/vps-setup.sh`、`deploy/systemd/hannigan-hub.service`、`deploy/caddy/hannigan.caddy` | 実機 |
| WP1 ペアリングと WSS（実装済み 2026-10-18。偽ワーカーで通し試験済み、wss の実機確認は WP2 後） | 01 §6 の形。設定画面「ワーカーを追加」→ ハブが 8 桁の一時コード（10 分、1 回限り）を発行 → 作業 Mac で `bun scripts/pair.ts <hub_url> <code> --worker <id>` → ハブが鍵を発行して `worker-keys.json` に追記、`hub.json` の `workers[]` に項目を足して**再起動なしで**反映 → Mac が `worker.json` と `worker-key` を書く。`hub_url` の `wss://` 対応（Bun の WebSocket はそのまま使える想定。TLS 検証を切る設定は作らない）。`cfg.workers` の実行時更新（秘書の指示文は次の起動から） | `hub/pairing.ts`、`scripts/pair.ts`、`POST /api/pairing/start`、`POST /pair`（トークン不要、コードで認証、失敗回数の上限）、設定画面のボタン | 単体: コードの有効期限・1 回限り・総当たり防止。通し: 偽ワーカーがコードで鍵を得て接続する |
| WP2 VPS 配置（配置済み 2026-10-19。VPS 自体の再起動も同日に試験済み、[報告 4.2](../verification/phase4-vps/README.md)） | Caddyfile、systemd ユニット（`hannigan-hub.service`、`hannigan-worker.service` は Mac には不要）、`scripts/vps-setup.sh`（ユーザー作成、導入、サービス登録）、`public_url` の設定、ログの場所、復元の確認（S3 の 5） | `deploy/caddy/Caddyfile`、`deploy/systemd/*.service`、`scripts/vps-setup.sh`、文書 | 実機: VPS 再起動 → 秘書と保留キューの復元 |
| WP3 ワーカーの再接続と自動起動（2026-10-19 実施。wss の再接続、launchd の導入、daemon の再起動、Mac の再起動からの自動復帰を確認、[報告 4.1](../verification/phase4-vps/README.md)） | Mac 再起動後に常駐プログラムが自分で VPS へ戻る。launchd（Phase 5 の項目を前倒し）。既存の再接続（`Backoff`）が WSS でも動くことの確認 | `deploy/launchd/com.hannigan.worker.plist`、`scripts/install-launchd.sh`、`scripts/uninstall-launchd.sh` | 実機: Mac 再起動 → 一覧に戻る |
| WP4 承認の集約と補助経路 | 2 台のワーカーの承認カードを 1 画面で区別して表示（表示名つき、実装済みの範囲を確認）。`request_id` と `approval_id` の衝突が無いこと。tmux 画面の読み取りと選択キー送信を 2 台で | 必要なら `web/index.html` の表示 | 通し: 偽ワーカー 2 台で承認が混ざらない |
| WP5 出口条件の確認 | ROADMAP Phase 4 の 4 項目を実機で。報告を `docs/verification/phase4-vps/README.md` に | 文書 | 実機 |

順序は S3 → WP1 → WP2 → WP3 → WP4 → WP5。WP1 は VPS が無くてもローカルで実装と試験ができるので、S3 のログイン待ちの間に進める。

## 5. 安全側の決め事

- `POST /pair` は WebChat トークン無しで届く唯一の経路なので、コードは 8 桁の数字と英字（推測しにくい長さ）、10 分で失効、1 回使ったら消す、失敗 5 回で無効にする。コードは `hub/pairing.json` に保存し、ハブ再起動で失効する
- 鍵の取り消しは従来どおり `worker-keys.json` から消すだけ。設定画面に「このワーカーを外す」を付けるのは Phase 5
- Caddy の設定は 443 と 80 だけ開ける。VPS のファイアウォール（XServer のパケットフィルタか ufw）で 22・80・443 以外を閉じる
- 秘密情報（WebChat トークン、鍵、Claude のログイン）は VPS の `hannigan` ユーザーのホームにだけ置く。root で動かすものは Caddy と systemd だけ
- `public_url` を `https://hannigan.found-d.com` にして、起動時の案内 URL とスマホ用 URL をこれにする

## 6. 文書の更新先

- ROADMAP Phase 4: 着手日と実機の前提、作業単位への参照
- 01 §3: `public_url` の例、§6 ペアリングの確定版（実装後）、§9 の確認結果
- 03 §2: `pair` の往復（実装後）
- マニュアル: 「VPS 構成で使う」章（2 台目の章は VPS 版に差し替え）
