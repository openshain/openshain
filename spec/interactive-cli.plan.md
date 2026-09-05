# 実装計画: 対話型 CLI(セッション)

spec は [interactive-cli.md](interactive-cli.md)。小さい縦の切れ目で進め、切れ目ごとにテストを通して commit する。

#### Task 1: build script

`scripts/build.ts`。`Bun.build` に compile と、`react-devtools-core` を空のモジュールに差し替える plugin。`bun run build` をこれに向ける。

- 受け入れ: `bun run build` で `dist/openshain` ができ、`--help` と `tools list` が動く
- 検証: `bun run build && ./dist/openshain --help`
- サイズ: XS

#### Task 2: core の記録

`human.message` イベント、`work.created` の `parent`、投影が `human.message` を user message にする。予約名に `work_run` と `work_show`。`WorkStore.create` が `parent` を受ける。schema を生成し直す。

- 受け入れ: `human.message` を含むログから投影を作ると人の発言が user message に並ぶ。`parent` 付きの Work を作れて JSON Schema を通る。予約名を Tool provider が登録すると `invalid_tool`
- 検証: `bun test packages/core`、`bun run schemas`
- サイズ: S

#### Task 3: agent のセッション

`createSession(runtime, options)`。`turn(text)` で人の発言を記録し、担当を回し、返答を返す。担当の道具 `work_run`、`work_list`、`work_show` を Runtime の道具として実装する。`work_run` は `runWork` で子 Work を進め、進捗と質問を options の callback に流す。1 ターンの上限。`close()` で `work.completed`。

- 受け入れ: fake の model の台本で、返答だけのターン、`work_run` を呼ぶターン、子 Work が質問するターン、上限を超えるターンが spec どおりに動く。担当に渡る Tool 定義に fs_* が無い
- 検証: `bun test packages/agent`
- サイズ: M

#### Task 4: cli の画面

Ink の画面。会話、状態行、入力欄。スラッシュコマンド。Ctrl-C。`bin.ts` は引数なしで端末なら画面を出す。

- 受け入れ: ink-testing-library で、発言と返答と子 Work の進捗が並び、`/work list` と `/tools` が既存の関数の出力を出し、`/quit` で閉じる。端末でなければ使い方を出す(既存のテスト)
- 検証: `bun test packages/cli`
- サイズ: M

#### Task 5: 文書と配布

README の使い方、docs/configuration.md、cli.md の設計ノート(REPL を捨てた案から採った案へ)、spec の CLI の表、CHANGELOG の 0.1.0、AGENTS.md の依存の方針。

- 受け入れ: README だけで `openshain` の対話に辿れる
- サイズ: S

### Checkpoint

- 本物の model で sample-client を擬似端末から回し、完了の条件 1 から 4 と 7 を目で確かめる
- レビュー
