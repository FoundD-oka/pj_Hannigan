# Phase 3: ローカル実地テストの自動試験

実施日: 2026-10-16（JST）
実施者: Claude Code（自律実行）。人の操作はなし。WebChat の操作は試験コードが HTTP API で代行した
環境: Mac mini（macOS 26.5.1、arm64）、Bun 1.3.9、tmux 3.8。Claude Code は偽物（`test/fake-claude.ts`）を使い、利用枠は使っていない

## 結論

Phase 3 の出口条件 7 つのうち、日常運用の 1 つを除く 6 つを偽 Claude の自動試験で確認した。
ハブ、ワーカー常駐プログラム、tmux は本物で、秘書・案件 PM・子の 3 役すべてを偽 Claude が演じる。試験は WebChat と同じ HTTP API だけで操作する。
本物の Claude での一巡はまだ行っていない（3 章）。

| 出口条件 | 結果 | 根拠 |
| --- | --- | --- |
| WebChat の 1 往復で、秘書が案件 PM に委任し、PM が直接実行か子への委任を選び、結果が元の会話に戻る | 偽 Claude で達成 | `phase3.test.ts` の 1〜2 |
| WebChat から PM と子のスレッドに直接投稿でき、子への投稿が PM に通知される | 偽 Claude で達成 | `phase3.test.ts` の 4、9 |
| 別の WebChat 会話から同じ PM に依頼しても、報告が混ざらず依頼元にだけ戻る | 偽 Claude で達成 | `phase3.test.ts` の 3 |
| ワーカー停止中の依頼が保留され、再起動後に受付順で配送される。期限を過ぎた依頼は実行されず失効が通知される | 偽 Claude で達成 | `phase3.test.ts` の 6〜7、`hub-routing.test.ts` |
| 同じ作業フォルダで PM と子が同時に書き込まない | 偽 Claude で達成 | `phase3.test.ts` の 5、`pm.test.ts` |
| 連続 7 日間、WebChat だけで日常の依頼を回せる | 未実施 | 本物の Claude での運用が必要 |
| 偽 Claude の自動試験が上の経路を網羅して通る | 達成 | 2 章 |

## 1. ハブ＋ワーカー＋偽 Claude の通し試験（`test/e2e-fake/phase3.test.ts`）

1 つの試験環境でハブとワーカー常駐プログラムを起動し、案件 `p1`（PM 有効、`hybrid`）を 1 つ持たせた。
オフライン保留は有効で、期限は設定できる最短の 1 分にした。端末の確認画面（開発用チャネル、フォルダの信頼）は 3 役とも `auto_accept` にした。承認カードの中継は Phase 2 の試験（`flow.test.ts`）で確かめている。
秘書は会話の最初のメッセージで起動する設定（`secretary.autostart=false`）にした。

| # | 試験 | 確かめたこと |
| --- | --- | --- |
| 1 | 出口条件 1（PM の直接実行） | 会話 `conv-a` の依頼で、秘書が `project_pm_send` を呼び、`request_id` を受け取る。ワーカーに `role=pm` のセッションが 1 つでき、PM の報告は `request_id`、`origin=request`、`routed=true`、`context_id=conv-a` を持つ。秘書の返信が `conv-a` に届き、結果と `request_id` を含む。PM が作業の間だけ書込権を持つ |
| 2 | 出口条件 1（子への委任） | PM が子を作って指示し（`task_event` の `created`、`sent`）、子は `role=task`、`pm_session=PM` で動く。子の報告は秘書へ配送されず（`routed=false`）、PM へ届く。PM の報告は元の `request_id` を持ち、`conv-a` に戻る。2 件の依頼のあとも `p1` の PM は 1 つだけ（`/api/threads` と `session_state` で確認） |
| 3 | 出口条件 3（会話分離） | `conv-a` と `conv-b` からほぼ同時に同じ PM へ依頼した。それぞれの報告は自分の会話にだけ、自分の `request_id` で届く。秘書は会話ごとに 1 つずつ（`/api/state` で 2 つ、`context_id` が `conv-a` と `conv-b`）。相手の会話の文言や `request_id` を含む返信は 1 件もない |
| 4 | 出口条件 2（直接投稿） | `POST /api/thread/send` で PM へ投稿すると、PM の返事は `in_reply_to` が投稿の `msg_id`、`origin=user_direct` で、どの秘書にも配送されない。返事は PM スレッドの履歴に残る。子へ投稿すると、子が 1 回だけ受け取り、PM に `user_direct_notice` が届く。`direct_delivery_state` は子への配送と PM への通知の両方が `delivered`。PM は同じ指示を子へ送り直さず、新しい子も作らない。子の返事を受けた PM の続報は委任元の `request_id` を持たず（`routed=false`）、この間どの秘書にも返信が出ない |
| 5 | 出口条件 5（単一書込） | 子が 6 秒の作業で書込権を持つ間に PM へ直接投稿すると、`resource_wait`（`workspace_busy`）になる。子が終わると書込権が `released` になり、続けて PM が新しい世代番号で `held` を得て、そのあとに投稿が配送される。全期間の `resource_lease_state` を順に再生し、同じ作業フォルダを 2 つのセッションが同時に `held` にした瞬間が無いことを確かめた |
| 6 | 出口条件 4（保留と配送） | ワーカー常駐プログラムを止めて依頼すると、`request_state` が `pending_offline` になる。期限は受付時刻のちょうど 1 分後で、`/api/offline-requests` に載る。秘書は「保留中」と `conv-a` に返す。止めている間は何も実行されない。ワーカーを起動すると配送され（`delivered`）、PM の報告が `conv-a` に戻る |
| 7 | 出口条件 4（失効） | ワーカーを止めて 2 件依頼し、ハブも止めた。保留ファイル `hub/offline-requests.jsonl` の 1 件目だけ受付時刻を 2 時間前に書き換えて、ハブを起動した。1 件目は `request_expired` と `request_state=expired` になり、`conv-a` の秘書に「実行されていません」という通知が届く。ワーカーを起動すると 2 件目だけが配送されて実行される。1 件目の `delivery` や報告は一度も出ない |
| 8 | ハブの再起動 | `conv-a` の秘書を停止 API で止め、ハブを再起動した。同じ会話から依頼すると、同じ秘書セッションが再開され（`secretary_context` の `resumed`）、新しい秘書は作られない。PM の報告は再起動前と同じく `conv-a` に戻る |
| 9 | スレッド履歴 | 子の `GET /api/thread/history` に、直接投稿（`user_direct`）、子の報告、`task_event` が並ぶ。`coverage` は `hannigan_only` か `unavailable`（偽 Claude は会話記録を書かないため）。`limit` と `before` で古い方へページ送りできる |
| 10 | 案件台帳 | PM が `work_item_create` で「Title-1」を登録すると、ハブの `work_item` に依頼の `request_id` 付きで記録される。別の会話 `conv-b` の秘書が `project_status` で読むと Title-1 と PM が見える。返信と `work-items.jsonl` には会話の本文（依頼文）が入らない |

7 は 1 つの `test` の中でハブとワーカーを 2 回ずつ止めるので、時間枠を 2 倍にした。

## 2. 試験の実行

```bash
bun run typecheck
bun test test/unit         # 単体試験
bun test test/e2e-fake     # 偽 Claude の通し試験（ハブ、ワーカー、tmux を本物で起動する）
bun test test/e2e-fake/phase3.test.ts   # この報告の通し試験だけ
```

2026-10-16 の最終実行（WP5 のレビュー修正の後）の結果は次のとおり。`bun test test/e2e-fake` は 2 回続けて実行し、2 回とも全件成功した（317 秒、319 秒）。

```text
bun run typecheck                          エラーなし
bun test test/unit                         72 pass（11 ファイル、0.2 秒）
bun test test/e2e-fake                     52 pass（5 ファイル、約 320 秒）
  flow.test.ts         19 pass   Phase 2 の経路と、会話ごとの秘書
  hub-routing.test.ts   7 pass   ハブ単体（ワーカーは台本どおりに動く偽物）
  pm.test.ts           15 pass   ワーカー単体（ハブは偽物）
  phase3.test.ts       10 pass   この報告（ハブ＋ワーカー＋偽 Claude の 3 役）
  hub-held.test.ts      1 pass   秘書の空き待ちがハブ再起動を越えて届く
```

合計 124 件。`bun test`（`package.json` の `test`）は単体と通し試験をまとめて実行する。

本物の Claude での一巡は `bun test/e2e-real.ts <証拠の出力先> [--model <別名>] [--effort low]` で行う。利用枠を使うので、この作業では実行していない。
台本は Phase 3 の経路に合わせて書き直した。秘書が `project_pm_send` で PM に依頼し、PM の直接作業、子への委任、ツール承認の拒否、PM スレッドへの直接投稿、PM の停止と再開を順に試す。
証拠には Phase 2 と同じもの（`events.jsonl`、`answers.log`、画面、ログ、`results.json`）に加えて、`sessions.jsonl`（PM・子・秘書の状態）、`leases.jsonl`（書込権と待ち）、`threads.json` を書き出す。

## 3. 本物の Claude で残っている確認

- 本物の Claude での一巡（`test/e2e-real.ts`）。特に、本物の PM が秘書起点の依頼に `request_id` を付けて返信するか、子への委任を自分で選ぶか、直接投稿の通知を受けて子に指示を送り直さないか。偽 Claude はこれを台本どおりに行うだけなので、ここは本物でしか確かめられない
- 連続 7 日間、WebChat だけで日常の依頼を回せること（出口条件 6）
- tmux 上の本物の Claude Code での書込権フック。2026-10-16 に 1 回確認した（[S1 の「tmux 実機確認」](../phase3-spikes/S1-write-lease-enforcement.md)）。PM と子が同時に動く場面と、剥奪前から動くバックグラウンド処理の検出は本物では未確認
- 会話記録（トランスクリプト）からの履歴表示。単体試験と S1 の実機確認で 1 回動いたが、`coverage=transcript` の表示を本物で通しては見ていない
- 24 時間の期限の実経過。試験は期限 1 分の設定と保留ファイルの書き換えで再現した

## 4. この作業で直した不具合

| 不具合 | 原因 | 修正 | 確認 |
| --- | --- | --- | --- |
| 会話記録が見つからないスレッドでも、履歴の範囲が「会話記録あり（`transcript`）」と表示される | ワーカーは判定結果を `entry_kind=coverage`、本文 `unavailable` / `partial` / `transcript` の `thread_entry` で送る。出所は常に `source=transcript` なので、出所だけを見るハブは `unavailable` も `transcript` と判定していた | ハブ（`hub/threads.ts` の `coverageOf` と `nextCoverage`）が判定結果の本文を優先する。後から来た通常の記録で `partial` が上書きされないようにした。WebChat の表示に `partial` と `unavailable` の文言を加えた | 単体試験 `hub-threads.test.ts` に 2 例を追加。通し試験 9 |

ハブとワーカーの間で、他に項目名や意味の食い違いは見つからなかった。

### 4.1 レビュー指摘の修正（WP5、2026-10-16）

通し試験の後に行ったコードレビューの指摘 19 件を直した。1 行目が不具合、矢印の後が修正と確認した試験。

1. 保留依頼の取消が送信中の配送に負ける → ハブの `dispatchOffline` が 1 件ごとに保留ファイルの最新状態を読み直し、`pending_offline` 以外は送らない。`dispatching` へ移せなければ送らない。依頼の状態は取消・失効・配送済み・失敗・配送不明から戻さない（配送不明はワーカーが確かめた配送済みと失効だけが上書きできる）。`hub-routing.test.ts` の 7
2. 期限の掃除が送信中の依頼まで失効させる → `expireDue` は `pending_offline` だけを失効させる。送信中の依頼は結果で決まり、ハブ再起動時は従来どおり配送不明にする。単体 `hub-offline-queue.test.ts`
3. 書込フックが実パスを見ず、別案件のフォルダへの書込を止めない → フックは存在する最も深い親を `realpath` で解決して判定し、デーモンが書く `worker/workspaces.json` の全案件フォルダと照らす。どれかの中なら、そのフォルダの書込枠を持つセッションだけが書ける。単体 `worker-lease.test.ts`（シンボリックリンク、入れ子、名前が前方一致する隣の案件）
4. Claude Code が消えていると解放前の検査を飛ばす → 消えていても `lsof +D` を全プロセス対象で実行し、確かめられなければ `cannot_inspect` として猶予後に `resource_unknown` にする。単体 `worker-lease.test.ts`
5. 再付与のたびに実行中の子孫を「既存の MCP」として登録し直す → 除外一覧はセッションの起動ごとに最初の付与で 1 回だけ取り、シェル配下は含めない。同じ所有者の再付与は一覧を引き継ぐ（`worker/lease-baselines.json`）。単体 `worker-lease.test.ts`
6. `lsof` の失敗や時間切れを「書込中なし」として通す → `cannot_inspect` にする（時間枠は 15 秒）。単体 `worker-lease.test.ts`
7. PM の返信の振り分けが推測に頼る → `task_report` の配送は PM の「直前の依頼」を変えない。ID の無い返信は、未回答の依頼がちょうど 1 件ならそれに、2 件以上なら振り分けず PM スレッドに残す（`reason=ambiguous_request`）。未知の `in_reply_to` でも有効な `request_id` があれば依頼として扱う。子への直接投稿の後、子の返事は委任元の `request_id` を引き継がないので、PM の続報が委任元の会話へ届かない。`pm.test.ts` の 7、13、`phase3.test.ts` の 4
8. 低レベルの `session_send` が PM と PM の子へ書込枠を通らずに届く → PM と PM の子は `invalid_state`（`pm_send` と直接投稿を案内）。PM を持たない Phase 2 の子は配送キューと書込枠を通す。PM の `session_resume` は `pm_ensure` として扱う。書込フックは PM の無い子にも入れる。`pm.test.ts` の 14、`flow.test.ts`
9. 送信待ちの溢れで報告や配送結果が先に消える → 溢れたときは `thread_entry` を古い順に、次にその他を消し、報告・配送結果・直接投稿の状態・書込枠の状態は他に消せるものがある限り残す。書き直しは一時ファイルと rename で行う。単体 `outbox.test.ts`
10. 秘書の空きを待つ配送がハブの再起動で消え、秘書が起動中に終わると未送信分も消える → 待ち行列を `hub/held.json` に保存して起動時に戻す。秘書の接続が整うまでチャネルへ書かずに待ち行列に置く。セッション管理は終了時の未送信分を `onUndelivered` で返し、ハブが待ち行列の先頭へ戻す。PM 報告の件数は秘書へ渡した後に数える。`hub-held.test.ts`
11. 異常終了で終わりの記録が無いツールが解放を永久に止める → 実行中の判定は現在の世代（`lease_epoch`）の開始記録だけを見る。10 分を超え、関係する子プロセスも無い開始記録は古いものとしてログに残して無視する。単体 `worker-lease.test.ts`
12. 再開（`resume`）がセッション数の上限を数えない → 新規作成と同じく `busy` を返す。ハブの秘書は従来どおり空きの確保（追い出し）と待ち行列で扱う
13. 秘書が他の会話のセッションを送信・再開・停止・中断できる → 他の会話が持つセッションなら `forbidden_origin`。持ち主の記録は成功した後にだけ付ける。`flow.test.ts` の「resume keeps history」
14. 投稿の重複判定が毎回全イベントを走査する → `EventLog` が `msg_id` の索引（Set）を持ち、`/api/send` と `/api/thread/send` は索引で判定する
15. ハブへ送る文にローカルのパスや画面が混ざる → 会話記録の本文は作業フォルダと home の置換の後、残る絶対パスを `<path:6桁の hash>` にする。起動失敗の画面末尾はワーカーのログだけに残し、ハブへは 1 行の理由を送る。エラー文はパスでなく案件 ID を使う。単体 `worker-transcript.test.ts`
16. 所有者の記録が無い `release_pending` がそのまま検査され続ける → `resource_unknown(owner_unknown)` にする。単体 `worker-lease.test.ts`
17. 入れ子や同じフォルダの案件を設定できる → 実パスにした後で一方が他方の中なら設定エラーにする。単体 `config.test.ts`
18. 設定の移行で書き込めないと起動できない → 警告を出し、移行後の設定をメモリ上で使って起動を続ける。単体 `config.test.ts`
19. ブリッジの鍵の共有 → 既知の制約として 5 章に記載した

`flow.test.ts` は 2 か所を直した。中断の試験とハブ再起動の試験は、直前の作業で `working` のまま続いた場合に新しい状態変化を待って止まっていたので、最新の状態を見るようにした。PM の確認画面は自動で答える設定にした。Phase 2 の子も同じ作業フォルダの書込枠を使うので、確認画面で止まった PM の後ろで待ち続けるためだ。偽 PM は子の報告に `meta.request_id` だけを付けるようにした（直前の依頼を勝手に付けない）。

## 5. 既知の制約（WP2、WP3 からの申し送りと、この試験で見えたこと）

- `cu_busy`（同じ Mac で純正 CU を使えるセッションは 1 つ）の待ちは未実装。書込権の待ちは `workspace_busy` と `resource_unknown` だけ
- 書込権の解放前の検査で `lsof +D` が 15 秒で終わらない大きなフォルダは、毎回 `cannot_inspect` になり、1 分後に `resource_unknown` で止まる（安全側）。手動の復旧操作は Q18 で決める
- ブリッジの鍵（`local-bridge-token.worker`）はワーカー内の全セッションで共有している。Bash を使えるセッションが鍵を読み、別のセッションを名乗ってブリッジへつなぐことはできる。想定する脅威は不具合や暴走で、悪意あるモデルによる改ざんは対象外とする（S1 の「フック設定の改変」と同じ扱い）
- ハブの `events.jsonl` とメモリ上の一覧は際限なく増える。重複判定は索引にしたが、履歴の検索やスレッド表示は全件を走査する。ローテーションは未実装
- 秘書の追い出しは `ready` の状態だけを見る。メッセージを渡した直後で、まだ画面が `working` に変わる前の秘書を追い出すことがある
- 期限（`expires_at`）はハブの時計で決め、ワーカーの時計で判定する。2 台の時計がずれると、早すぎる失効や遅すぎる失効が起きる。同じ Mac の構成では問題にならない
- SSE（`/api/events`）は会話ごとに絞り込まず、全イベントを流す。画面の側で会話ごとに分けて表示している。利用者認証と一緒に Phase 4 で入れる
- `project_pm_send` は案件台帳の項目（`work_item_id`）を作らない。台帳には PM が `work_item_create` で登録したものだけが載る
- 子への直接投稿の後の子の返事は、委任元の `request_id` を持たずに PM へ届く（4.1 の 7）。PM が自分で `request_id` を付けて報告すれば、その依頼の会話へ届く。これは PM の判断に任せている
- 試験のワーカーは、会話記録を探すときに実際の `~/.claude/projects` を読む（書き込みはしない）。偽 Claude のセッション ID は存在しないので、60 秒後に `unavailable` になる
