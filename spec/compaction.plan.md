# 実装計画: 文脈の圧縮

spec は [interactive-cli.md](interactive-cli.md) の「文脈の圧縮」です。小さい縦の切れ目で進め、切れ目ごとにテストを通して commit します。各 Task で `bun run typecheck`、`bun run lint`、`bun test` を通し、package の振る舞いを変える Task は `docs/design/` のノートを同じ commit で更新します。

置き場です。`conversation.compacted` の schema と投影は `packages/core`。圧縮の実行(閾値、要約の呼び出し、失敗したときの扱い)は `packages/agent`。`/compact` と画面の行は `packages/cli`。新しい package は作りません。

#### Task 1: 記録と投影

`conversation.compacted`(要約した最後のイベントの `seq`、本文、モデル、使用量)を core のイベントに追加します。投影は、最後の `conversation.compacted` の本文を会話の先頭に置き、その `seq` より後のイベントを続けます。記録は書き換えません。`bun run schemas` が `spec/schemas/events.v1.json` を更新します。

- 受け入れ: 完了の条件 2。圧縮のイベントが無い記録の投影が今までと同じであること。2 件あるときは新しいほうだけが効くこと
- 検証: `bun test packages/core`、`bun run schemas`
- サイズ: S

#### Task 2: 圧縮の実行

直前のモデル呼び出しの入力トークンが `limits.compact_at_input_tokens`(既定 120000)を超えていたら、次のターンを始める前に 1 回だけ圧縮します。圧縮用の指示とそこまでの投影を同じモデルに 1 回渡し、`conversation.compacted` として記録します。呼び出しが失敗したら圧縮せずに続け、その旨を返します。設定に項目を足し、`openshain init` のコメントに載せます。

- 受け入れ: 完了の条件 1、4、5、6。fake model で、閾値の前後、失敗、要約に残る項目を確かめること
- 検証: `bun test packages/agent packages/core`
- サイズ: M

#### Task 3: `/compact` と画面

`/compact` を追加します。閾値に届いていなくても実行し、圧縮したことを 1 行表示します。失敗したときは注意として 1 行表示します。自動の圧縮も同じ行で知らせます。`/help` の一覧に載せます。

- 受け入れ: 完了の条件 3。ink-testing-library で行が出ること
- 検証: `bun test packages/cli`
- サイズ: S

#### Task 4: 実モデルでの確認と文書

live の eval(圧縮をまたいで前の話題を引き継ぐ)。docs/design/agent.md の「文脈が増える一方であることは、いまの版の限界」を実装済みの記述に更新、docs/configuration.md の `limits`、README の記述、CHANGELOG。3 観点のレビュー。

- 受け入れ: 完了の条件 7。文書に未実装の記述が残らないこと
- 検証: `OPENSHAIN_LIVE_TESTS=1 bun test packages/agent`、`bun test`
- サイズ: M
