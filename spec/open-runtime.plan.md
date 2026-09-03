# Implementation Plan: Open Runtime

対象: [open-runtime.md](open-runtime.md) v0.2。この計画は spec の完了条件 1 から 10 を満たすまでの順序とタスク。

## 概要

core の土台(エラー、ID、設定、イベントログ、Work、Tool の登録と検証、投影)を先に固め、次に「台本どおりに応答する fake の model で CSV を読み Markdown を書く」1 本を CLI まで通す。動く縦 1 本ができてから、本物の provider 2 つ、MCP、第三者 Tool の順に広げる。最後に JSON Schema の生成と quickstart。

## 設計上の決め

- 依存の向きは core ← agent, tools, mcp, cli。core は他の package を import しない。model provider の生成は agent が持ち、`createRuntime` には factory を渡す(core が provider の実装を知らないため)
- 設定の `module:` で指定された第三者 Tool は core が動的 import で読む
- 追加する依存とその理由: `zod`(schema と型の単一の正本)、`yaml`(行番号つきの解析)、`ajv`(第三者 Tool の任意の JSON Schema を検証)、`csv-parse` と `csv-stringify`(RFC 4180 準拠、Bun に CSV の組み込みがない)、`@anthropic-ai/sdk`、`openai`、`@modelcontextprotocol/sdk`。CLI の引数解析は `node:util` の `parseArgs` を使い、依存を足さない
- 版はすべて固定(exact)。更新は別 PR
- `FakeModelProvider` は `@openshain/agent/testing` として公開し、第三者が自分の Tool を試せるようにする
- CLI のコマンドは Runtime と ModelProvider を引数で受ける関数として書き、bin が本物を配線する。テストは関数を fake で呼ぶ

## 依存関係

```
errors, ids
  ├── config (yaml + zod)
  ├── work: events(zod は config で入る)→ event log → lock → Work と遷移 → projection
  ├── tool: 契約(events の ToolContent と Artifact を使う)→ registry(一意性、allow)→ ajv 検証 → path guard
  └── model: 契約
        └── createRuntime(config → registry、module 読み込み、events)
              ├── tools/standard(path guard、after の sha256)
              ├── agent/loop(fake model で先に通す)→ ask_user
              │     ├── providers/anthropic
              │     └── providers/openai-compatible
              ├── cli(init、run、work、tools)→ mcp コマンド
              └── mcp/server(loop は使わない)
examples/tools/echo(契約と module 読み込みだけに依存)
```

## タスク

サイズは AGENTS.md の目安(S: 1 から 2 ファイル、M: 3 から 5 ファイル)。テストは対象ファイルの隣に置く。各タスクは 1 つの PR。

### Phase 1: core の土台

#### Task 1: errors と ids

`OpenshainError(code, message, cause?)` と、`Bun.randomUUIDv7()` を使う `newWorkId()`、`newEventId()`。`WorkId`、`EventId` は branded type。

- 受け入れ: `code` が機械可読の文字列として型で列挙されている。ID は時刻順にソートできる(連続生成した 2 つを比較)。
- 検証: `bun test packages/core/src/errors.test.ts packages/core/src/ids.test.ts`
- 依存: なし
- ファイル: `packages/core/src/errors.ts`、`ids.ts`、各 test
- サイズ: S

#### Task 2: 設定の読み込みと検証

`openshain.yaml` の zod schema(version、company、principal、profession、model、tools、limits、debug)と `loadConfig(workspaceRoot)`。不備は行番号つきの `OpenshainError("config", …)`。

- 受け入れ: spec の設定例がそのまま通る。`api_key_env` 欠落、未知の provider 名(呼び出し側が既知の provider 一覧を渡したとき)、`allow` に文字列以外、のそれぞれで行番号つきのエラーになる。`limits` と `debug` の省略時に既定値が入る。
- 検証: `bun test packages/core/src/config`
- 依存: Task 1
- ファイル: `packages/core/src/config/schema.ts`、`load.ts`、test、`package.json`(zod、yaml)
- サイズ: M

#### Task 3: イベントとイベントログ

Event の zod schema(共通項目と type ごとの payload)。`EventLog` の append(seq を単調増加、1 行 1 JSON、`v: 1`)と read。ファイルは snake_case、コードは camelCase で、変換はここで 1 回。

- 受け入れ: append と read の往復で等しい。seq が飛ばない。壊れた末尾行があれば `OpenshainError("corrupt_log", …)` で止まり、黙って読み飛ばさない。未知の type は読めるが payload は検証しない。
- 検証: `bun test packages/core/src/work/event-log.test.ts`
- 依存: Task 1、Task 2(zod を core の依存に入れるのが Task 2 のため)
- ファイル: `packages/core/src/work/events.ts`、`event-log.ts`、test
- サイズ: M

#### Task 4: Work、遷移、store、lock

Work の schema と遷移表、`work.json` への投影の書き出し、`WorkStore`(create、get、list)、`lock`(pid と開始時刻、生存確認、stale なら引き継ぐ)。

- 受け入れ: 許されない遷移(`completed` → `in_progress` など)が `invalid_transition` で止まる。create したものが list と get で見える。lock を持つ pid が生きている間は 2 つ目の取得が失敗し、死んでいれば取得できる。
- 検証: `bun test packages/core/src/work/work.test.ts packages/core/src/work/store.test.ts packages/core/src/work/lock.test.ts`
- 依存: Task 3
- ファイル: `packages/core/src/work/work.ts`、`store.ts`、`lock.ts`、各 test
- サイズ: M

#### Task 5: Tool の契約、registry、検証、path guard

ToolDefinition と ToolProvider の型。`ToolRegistry`(provider 登録、名前の一意性、allow による絞り込み)。ajv(2020-12)による `validateInput`。`resolveWorkspacePath(root, rel)`(`..`、絶対パス、symlink の先、予約パスを拒否)。

- 受け入れ: 同名 Tool の 2 重登録が `duplicate_tool` で止まる。allow 外の Tool は `listTools` に出ない。schema 不一致の入力が実行前に落ち、理由が読める。`../x`、`/etc/passwd`、`work/x`、`openshain.yaml`、root 外への symlink がすべて拒否される。
- 検証: `bun test packages/core/src/tool`
- 依存: Task 1、Task 3(ToolResult が events.ts の ToolContent と Artifact を使う)
- ファイル: `packages/core/src/tool/types.ts`、`registry.ts`、`validate.ts`、`paths.ts`、test、`package.json`(ajv)
- サイズ: M

#### Task 6: model の契約と投影

ModelProvider と message の型。`buildProjection(events, config, budget)`: system、追記だけの messages、許可済み Tool 定義、`opaque` の扱い、残量の 1 行。

- 受け入れ: 同じイベント列から 2 回作った投影が JSON 文字列として一致する。`opaque` は同じ provider にだけ返る。直近の user message の末尾に残量の 1 行がある。tool_result は 1 つの user message にまとまる。
- 検証: `bun test packages/core/src/work/projection.test.ts`
- 依存: Task 2(Config の型)、Task 3、Task 5
- ファイル: `packages/core/src/model/types.ts`、`work/projection.ts`、test
- サイズ: M

### Checkpoint 1

- `bun run typecheck`、`bun run lint`、`bun test` が通る
- core の公開 export(`packages/core/src/index.ts`)が上の型と関数を出している
- レビュー

Checkpoint 1(2026-09-03 完了)。次を保証する。WorkId の実行時検証、書き込みは handle と lock を通す、末尾に改行のないログの拒否、行き先が存在しない symlink も行き先で判定、reducer の厳密化、書いたイベントの読み返し確認、lock の所有権の確認と pid の範囲の限定、先頭が `.` の項目の予約、投影の正規形化と tool 呼び出しの対応検査。あわせて payload schema を loose にし、`tool.rejected` に code、`model.completed` に raw、human の入力に call_id、usage に cache 書き込みを足した。残した課題は 3 つ。TOCTOU(Task 8 で O_NOFOLLOW)、pid の再利用(spec に既知の限界として記載)、`list()` の性能(work.json を読む案は次の checkpoint)。

### Phase 2: 縦 1 本(fake model → 標準 Tool → CLI)

#### Task 7: createRuntime

設定から registry を組み立てる。`module:` の provider を動的 import。`runtime.works`、`runtime.tools`(list、call: 検証 → authorize → 実行 → events)、`runtime.events`。`capabilities.tools` が false なら起動時にエラー。

- 受け入れ: fake の ToolProvider と ModelProvider を factory で渡して起動できる。`tools.call` が `tool.called` と `tool.completed`(または `tool.rejected`)と `usage.recorded(tool_execution)` を残す。Tool 非対応の model で `config` エラー。
- 検証: `bun test packages/core/src/runtime.test.ts`
- 依存: Task 2、4、5、6
- ファイル: `packages/core/src/runtime.ts`、`tool/load-module.ts`、test、`index.ts`
- サイズ: M

#### Task 8: 標準 Tool

`fs_list`、`fs_read`、`fs_write`、`csv_read`、`csv_write`、`markdown_read`。path guard を通す。mutate は `after` に sha256。

- 受け入れ: 各 Tool が spec の表どおりに動く。予約パスと root 外が `isError` ではなく registry 側の拒否になる(実行前)。`fs_write` 後の `after.sha256` が実ファイルと一致する。CSV の引用符とカンマを含むセルが往復で崩れない。
- 検証: `bun test packages/tools`
- 依存: Task 5
- ファイル: `packages/tools/src/index.ts`、`fs.ts`、`csv.ts`、`markdown.ts`、test、`package.json`(csv-parse、csv-stringify)
- サイズ: M

#### Task 9: agent loop(fake model)

`runWork(runtime, workId, { model })`。投影 → generate → stop_reason で分岐 → tool_call は順に実行して 1 message で返す → 上限 → events。`FakeModelProvider`(台本)を `@openshain/agent/testing` に置く。

- 受け入れ: 台本「csv_read → fs_write → end_turn」で Work が `completed` になり、`outcome.artifacts` の sha256 を Runtime が計算している。`max_model_calls: 2` で `failed(limit_reached)`。`refusal` で `failed(model_refusal)`。provider が throw すると `model.failed` の後に `failed(model_error)`。1 応答に 2 つの tool_call があると両方の結果が 1 つの user message に入る。
- 検証: `bun test packages/agent/src/loop.test.ts`
- 依存: Task 7、Task 8
- ファイル: `packages/agent/src/loop.ts`、`testing/fake-model.ts`、test、`package.json`(exports に `./testing`)
- サイズ: M

#### Task 10: ask_user と評価の記録

Runtime が足す `ask_user` Tool。呼ばれたら `human.input_requested` を残して `waiting_input` にし、`onInput` の答えで `human.input_provided` から続行。完了時の `evidence.recorded`(claim、refs、artifacts)。

- 受け入れ: 台本「ask_user → (答え) → end_turn」で状態が `waiting_input` を経て `completed` になる。`evidence.recorded.refs` が mutate Tool のイベント id を指す。
- 検証: `bun test packages/agent/src/ask-user.test.ts packages/agent/src/loop.test.ts`
- 依存: Task 9
- ファイル: `packages/agent/src/ask-user.ts`、`loop.ts`、test
- サイズ: S

#### Task 11: CLI の init、run、tools list

`node:util` の `parseArgs`。`openshain init`(ひな型)、`openshain run "<依頼>"`(Tool ごとに 1 行、最後に状態、結果、使用量、次に動く人)、`openshain tools list`。`--workspace` と上方向の探索。コマンドは関数、bin は配線だけ。

- 受け入れ: 一時ディレクトリで `init` → 設定の provider を fake に差し替え → `run` が完走し、`work/<id>/events.jsonl` ができる。`tools list` に provider と effect と許可の有無が出る。
- 検証: `bun test packages/cli`
- 依存: Task 9
- ファイル: `packages/cli/src/bin.ts`、`commands/init.ts`、`commands/run.ts`、`commands/tools.ts`、test
- サイズ: M

#### Task 12: CLI の work list と show

`openshain work list`、`openshain work show <id>`(状態、イベントの要約、`usage.recorded` の合計、次に動く人)。

- 受け入れ: 2 つの Work を作った後に list が 2 行。show の合計が events.jsonl の `usage.recorded` を足した値と一致する。`waiting_input` の Work で「次に動くのは利用者」と出る。
- 検証: `bun test packages/cli/src/commands/work.test.ts`
- 依存: Task 11
- ファイル: `packages/cli/src/commands/work.ts`、test、`bin.ts`
- サイズ: S

### Checkpoint 2

- 一時 workspace で `openshain run` が fake model で完走する(完了条件 4、6、7、8、9、10 の自動テストがここで揃う)
- レビュー

### Phase 3: 本物の provider と交換の証明

#### Task 13: Anthropic provider

`@anthropic-ai/sdk`。ModelRequest → `messages.create`(system、tools、max_tokens、providerOptions の透過)。応答の text、tool_use、thinking(→ `opaque`)と stop_reason、usage(cache 読み取りを含む)の対応。SDK の例外を `code` に対応づける。

- 受け入れ: 記録した応答(text のみ、tool_use あり、max_tokens、refusal)の 4 fixture で対応どおりに変換される。`providerOptions.effort` が request に載る。認証エラーが `auth` になる。
- 検証: `bun test packages/agent/src/providers/anthropic.test.ts`
- 依存: Task 6
- ファイル: `packages/agent/src/providers/anthropic.ts`、test、`fixtures/anthropic/*.json`、`package.json`
- サイズ: M

#### Task 14: OpenAI 互換 provider

`openai` パッケージに `baseURL`。chat.completions の function calling。finish_reason(stop、tool_calls、length、content_filter)と usage(`reasoning_tokens`、`cached_tokens`)の対応。

- 受け入れ: 4 fixture で対応どおりに変換される。`base_url` が設定から渡る。tool 非対応を示す応答で `capabilities.tools` が false になる経路がある(設定で明示)。
- 検証: `bun test packages/agent/src/providers/openai-compatible.test.ts`
- 依存: Task 6
- ファイル: `packages/agent/src/providers/openai-compatible.ts`、test、`fixtures/openai/*.json`、`package.json`
- サイズ: M

#### Task 15: 交換の証明と live smoke

同じ台本(CSV を読み Markdown を書く)を、設定の `model` だけ変えて両 provider の fixture で完走させるテスト。`OPENSHAIN_LIVE_TESTS=1` のときだけ実 API に当たる smoke。

- 受け入れ: 完了条件 1 が `bun test` で再現する。live smoke は環境変数なしでは skip と表示される。
- 検証: `bun test packages/agent/src/swap.test.ts`
- 依存: Task 11、13、14
- ファイル: `packages/agent/src/swap.test.ts`、`live.test.ts`
- サイズ: S

### Checkpoint 3

- 完了条件 1 のテストが通る。中谷が実キーで live smoke を 1 回回す
- レビュー

### Phase 4: MCP と第三者 Tool

#### Task 16: MCP Server

`@modelcontextprotocol/sdk`。`work_create`、`work_select`、`work_get`、`work_list`、`work_complete`(artifacts の存在と sha256 を検証)、`work_fail`、登録済み全 Tool。セッションの現在の Work。

- 受け入れ: in-memory transport の client から `work_create` → `fs_read` → `work_complete` で Work が `completed` になり、events に Tool 呼び出しと `evidence.recorded` が残る。現在の Work なしの Tool 呼び出しがエラー文で案内する。申告と違う sha256 のとき Runtime の値が残る。
- 検証: `bun test packages/mcp`
- 依存: Task 7、Task 8
- ファイル: `packages/mcp/src/server.ts`、`session.ts`、test、`package.json`
- サイズ: M

#### Task 17: `openshain mcp` と第三者 Tool の例

CLI の `mcp` コマンド(stdio)。`examples/tools/echo/tool.ts`(ToolProvider を default export)。設定の `module:` で読み込み、`tools list`、`run`(fake model が echo を呼ぶ台本)、MCP の 3 経路から呼べることのテスト。

- 受け入れ: 完了条件 2 と 3 が `bun test` で再現する。
- 検証: `bun test packages/cli/src/commands/mcp.test.ts examples/tools/echo`
- 依存: Task 11、Task 16
- ファイル: `packages/cli/src/commands/mcp.ts`、`bin.ts`、`examples/tools/echo/tool.ts`、test
- サイズ: M

### Checkpoint 4

- 完了条件 2、3 のテストが通る。中谷が Claude Code から `openshain mcp` に接続して 1 件通す
- レビュー

### Phase 5: schema の生成と quickstart

#### Task 18: JSON Schema の生成

zod から config と event の JSON Schema を `spec/schemas/` に生成する script。CI で生成物が最新かを確認する(生成して差分があれば失敗)。

- 受け入れ: `bun run schemas` で `spec/schemas/config.v1.json` と `events.v1.json` ができる。手で編集した生成物は CI で落ちる。
- 検証: `bun run schemas && git diff --exit-code spec/schemas`
- 依存: Task 2、Task 3
- ファイル: `scripts/generate-schemas.ts`、`spec/schemas/*.json`、`package.json`、`.github/workflows/ci.yml`
- サイズ: S

#### Task 19: quickstart

README の「状態」を quickstart に置き換える(インストール、`openshain init`、API キーの環境変数、`run`、Claude Code からの MCP 接続)。`docs/` に設定ファイルの説明。

- 受け入れ: 初めての人が README だけで `init` → `run` まで辿れる。設定ファイルの全項目に説明がある。
- 検証: 新しい一時ディレクトリで README の手順を上から実行する
- 依存: Task 15、Task 17
- ファイル: `README.md`、`docs/configuration.md`、`docs/principles.md`
- サイズ: S

### Checkpoint 5(完了)

- 完了条件 1 から 10 が、それぞれどのテストで確認されるか対応表を spec に足す
- レビュー

## 並行できるもの

Checkpoint 1 の後は、Task 8(標準 Tool)、Task 13 と 14(provider)、Task 16(MCP)が互いに独立。worktree を分ければ同時に進められる。Task 9 から 12 は直列。

## リスク

| リスク | 影響 | 手当て |
|---|---|---|
| TypeScript 7(native tsc)がライブラリの型定義で躓く | 中 | 版を固定。躓いたら typecheck だけ TypeScript 5.9 に戻す ADR を書く |
| Anthropic API の仕様変化(thinking、effort、refusal の扱い) | 中 | fixture は実応答から記録する。providerOptions は透過にして契約側で吸収しない |
| OpenAI 互換サーバーごとの差(tool 対応、strict、usage の項目) | 中 | 契約は最小の共通部分。差は `capabilities` と providerOptions で表す。live smoke は OpenAI 本家とローカル 1 つ |
| ajv の 2020-12 と strict mode が第三者 schema を弾く | 低 | strict を off にして未知キーワードを許す。弾いた理由を `tool.rejected` に残す |
| lock の pid 生存確認が WSL と macOS で挙動が違う | 低 | `process.kill(pid, 0)` の例外種別で判定し、両 OS でテスト |
| 投影の決定性が provider の `opaque` で崩れる | 中 | Task 6 のテストで JSON 文字列の一致を固定する |

## レビューで決めたこと

- PR の粒度は 1 タスク 1 PR。19 本。
- CSV は `csv-parse` と `csv-stringify`。
- CLI に色や spinner の依存は入れない。`node:util` の `parseArgs` と素の行出力。
- live smoke の 2 つ目の provider は、Anthropic の OpenAI 互換 endpoint 経由で Claude を呼ぶ。`ANTHROPIC_API_KEY` 1 つで両 provider を本物で試せる。endpoint と対応範囲(tool calling、usage の項目)は Task 15 の実装時に公式ドキュメントで確認する。
