# 実装計画: 文脈の圧縮

spec は [interactive-cli.md](interactive-cli.md) の「文脈の圧縮」です。小さい縦の切れ目で進め、切れ目ごとにテストを通して commit します。各 Task で `bun run typecheck`、`bun run lint`、`bun test` を通し、package の振る舞いを変える Task は `docs/design/` のノートを同じ commit で更新します。

置き場です。`conversation.compacted` の schema と投影は `packages/core`。`work_record` の受け付けと `work_select` の検査は `packages/mcp`。圧縮の実行(閾値、要約の呼び出し、失敗したときの扱い)は `packages/agent`。`/compact` と画面の行は `packages/cli`。新しい package は作りません。

#### Task 0: 別の人の Work に書けないようにする

`work_select` が、その Work の principal と設定の principal の一致を確かめます。`work_record` は選んだ Work にしか書けないので、ここを塞げば client が別の人の会話にイベントを書く経路がなくなります。圧縮より前に入れます。要約を偽造されると、会話のこれまでの経緯が丸ごと差し替わるためです。読み取り(`work_get`、`work_list`)はこの版では変えません。

- 受け入れ: 別の principal の Work を `work_select` が拒否すること。拒否された Work に `work_record` が書けないこと。同じ principal の Work は今までどおり選べること
- 検証: `bun test packages/mcp`
- サイズ: S

#### Task 1: 記録と投影

`conversation.compacted`(要約した最後のイベントの id、本文、モデル)を core のイベントに追加し、`packages/mcp` の受け付ける type に加えます。投影は、最後の `conversation.compacted` の本文を断り書き付きで会話の先頭に置き、そのイベントより後を続けます。あわせて、会話に残った古い Tool の結果(直近 5 件の人の発言より前)を投影の中で「省略」に置き換えます。記録は書き換えません。`bun run schemas` が `spec/schemas/events.v1.json` を更新します。

- 受け入れ: 完了の条件 2、7。圧縮のイベントが無い記録の投影が今までと同じであること。2 件あるときは新しいほうだけが効くこと。切れ目が人の発言の境目にあるとき Tool の対が壊れないこと。`reduceWork` と authority の判定がこのイベントを参照しないことをテストで固定すること
- 検証: `bun test packages/core packages/mcp`、`bun run schemas`
- サイズ: M

#### Task 2: 圧縮の実行

直前のモデル呼び出しの入力トークンが閾値を超えていたら、次のターンを始める前に 1 回だけ圧縮します。閾値は `limits.compact_at_input_tokens`、既定は `model.context_tokens` があればその 70%、なければ 150000。設定に 2 つの項目を追加し(`config.v1.json` の再生成、`openshain init` のコメント、docs/configuration.md の表)、圧縮用の指示とそこまでの投影を同じモデルに 1 回渡します。「引いた会社の決まり」と「実行しなかった呼び出し」の 2 節はコードが埋めます。圧縮の呼び出しは社員エージェントの発言として記録せず、`usage.recorded` と `conversation.compacted` だけを残します。失敗、空の要約、縮まなかった要約は記録せずに続けます。入力の大きさで呼び出しが失敗したときは、圧縮して 1 回やり直します。

- 受け入れ: 完了の条件 1、4、5、6、8。fake model で、閾値の前後、失敗の 3 種、入力過大からの再試行、コードが埋める 2 節を確かめること
- 検証: `bun test packages/agent packages/core`
- サイズ: L

#### Task 3: `/compact` と画面

`Session` に圧縮を起こす手段を追加し、`/compact` から呼びます。自動の圧縮も `/compact` も `⎿` の行で 1 行表示します(要約が覆った範囲と、「人が伝えた前提」の節を短く)。セッション自身の Work の出来事は画面が捨てているので、この type を通す経路を追加します。`/help` の一覧に載せます。

- 受け入れ: 完了の条件 3。ink-testing-library で、自動と手動の両方の行が出ること
- 検証: `bun test packages/cli`
- サイズ: M

#### Task 4: 実モデルでの確認と文書

live の eval(圧縮をまたいで前の話題を引き継ぐ)。圧縮の前後で同じ問いを当て、「開いている Work の id」「書いたファイルの場所」「人が伝えた前提」が答えられることを確かめます。docs/design/agent.md の「文脈が増える一方であることは、いまの版の限界」を実装済みの記述に更新、docs/configuration.md の `limits` と `model`、README の記述、CHANGELOG。3 観点のレビュー。

- 受け入れ: 完了の条件 9。文書に未実装の記述が残らないこと
- 検証: `OPENSHAIN_LIVE_TESTS=1 bun test packages/agent`、`bun test`
- サイズ: M
