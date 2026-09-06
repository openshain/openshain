# 実装計画: 対話型 CLI(セッション)

spec は [interactive-cli.md](interactive-cli.md) です。小さい縦の切れ目で進め、切れ目ごとにテストを通して commit します。

#### Task 1: build script

`scripts/build.ts` を作ります。`Bun.build` に compile と、`react-devtools-core` を空のモジュールに差し替える plugin を渡します。`bun run build` をこれに向けます。

- 受け入れ: `bun run build` で `dist/openshain` ができ、`--help` と `tools list` が動きます
- 検証: `bun run build && ./dist/openshain --help`
- サイズ: XS

#### Task 2: core の記録

`human.message` イベント、`work.created` の `parent`、投影が `human.message` を user message にすること。予約名に `work_run` と `work_show` を追加します。`WorkStore.create` が `parent` を受けます。schema を生成し直します。

- 受け入れ: `human.message` を含むログから投影を作ると人の発言が user message に並びます。`parent` 付きの Work を作れて JSON Schema を通ります。予約名を Tool provider が登録すると `invalid_tool` になります
- 検証: `bun test packages/core`、`bun run schemas`
- サイズ: S

#### Task 3: agent のセッション

`createSession(runtime, options)` を作ります。`turn(text)` で人の発言を記録し、社員エージェントを回し、返答を返します。社員エージェントの道具 `work_run`、`work_list`、`work_show` を Runtime の道具として実装します。`work_run` は `runWork` で子 Work を進め、進捗と質問を options の callback に流します。1 ターンの上限を持ちます。`close()` で `work.completed` を残します。

- 受け入れ: fake の model の台本で、返答だけのターン、`work_run` を呼ぶターン、子 Work が質問するターン、上限を超えるターンが spec どおりに動きます。社員エージェントに渡る Tool 定義に fs_* がありません
- 検証: `bun test packages/agent`
- サイズ: M

#### Task 4: cli の画面

Ink の画面です。会話、状態行、入力欄。スラッシュコマンド。Ctrl-C。`bin.ts` は引数なしで端末なら画面を表示します。

- 受け入れ: ink-testing-library で、発言と返答と子 Work の進捗が並び、`/work list` と `/tools` が既存の関数の出力を表示し、`/quit` で閉じます。端末でなければ使い方を表示します(既存のテスト)
- 検証: `bun test packages/cli`
- サイズ: M

#### Task 5: 文書と配布

README の使い方、docs/configuration.md、cli.md の設計ノート(REPL を捨てた案から採った案へ)、spec の CLI の表、CHANGELOG の 0.1.0、AGENTS.md の依存の方針を書きます。

- 受け入れ: README だけで `openshain` の対話に辿れます
- サイズ: S

### Checkpoint

- 本物の model で sample-client を擬似端末から回し、完了の条件 1 から 4 と 7 を目で確かめます
- レビュー

Checkpoint(2026-09-05 実走完了。レビューはこれから)。Task 1 から 5 は main に入りました(944d41f、f55106c、a6f4e08、45dbf66、303a2e0)。単体バイナリを擬似端末から動かし、claude-haiku-4-5-20251001 で「receipt/2026-07.csv を category ごとに集計して summary-tui.md に書いて」を頼みました。社員エージェントが work_run で子 Work を作り、csv_read と csv_aggregate の進捗が画面に流れました。実走の台本の都合で子 Work を途中で止め、別のプロセスから `/resume <id>` で続けたところ fs_write まで進んで完了し、10 カテゴリの数字は CSV と一致しました。続けて「ありがとう。何をしましたか?」に社員エージェントが返答しました。子 Work の `parent` はセッションを指し、`work show` でセッションの使用量が表示されます。止め方の実験で `in_progress` のまま残ったセッションがあったので、SIGHUP と SIGTERM でセッションを閉じるようにしました。
