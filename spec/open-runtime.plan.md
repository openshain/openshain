# Implementation Plan: Open Runtime

対象は [open-runtime.md](open-runtime.md) v0.2 です。この計画は spec の完了条件 1 から 10 を満たすまでの順序とタスクです。

## 概要

core の基本部分(エラー、ID、設定、イベントログ、Work、Tool の登録と検証、投影)を先に固め、次に「台本どおりに応答する fake の model で CSV を読み Markdown を書く」1 本を CLI まで通します。動く縦 1 本ができてから、本物の provider 2 つ、MCP、第三者 Tool の順に広げます。最後に JSON Schema の生成と quickstart です。

## 設計上の決め

- 依存の向きは core ← agent, tools, mcp, cli です。core は他の package を import しません。model provider の生成は agent が持ち、`createRuntime` には factory を渡します(core が provider の実装を知らないためです)
- 設定の `module:` で指定された第三者 Tool は core が動的 import で読みます
- 追加する依存とその理由: `zod`(schema と型の単一の原本)、`yaml`(行番号つきの解析)、`ajv`(第三者 Tool の任意の JSON Schema を検証)、`csv-parse` と `csv-stringify`(RFC 4180 準拠、Bun に CSV の組み込みがない)、`@anthropic-ai/sdk`、`openai`、`@modelcontextprotocol/sdk`。CLI の引数解析は `node:util` の `parseArgs` を使い、依存を足しません
- 版はすべて固定(exact)です。更新は別 PR で行います
- `FakeModelProvider` は `@openshain/agent/testing` として公開し、第三者が自分の Tool を試せるようにします
- CLI のコマンドは Runtime と ModelProvider を引数で受ける関数として書き、bin が本物を配線します。テストは関数を fake で呼びます

## 依存関係

```
errors, ids
  ├── config (yaml + zod)
  ├── work: events(zod は config で入る)→ event log → lock → Work と遷移 → projection
  ├── tool: インターフェース(events の ToolContent と Artifact を使う)→ registry(一意性、allow)→ ajv 検証 → path guard
  └── model: インターフェース
        └── createRuntime(config → registry、module 読み込み、events)
              ├── tools/standard(path guard、after の sha256)
              ├── agent/loop(fake model で先に通す)→ ask_user
              │     ├── providers/anthropic
              │     └── providers/openai-compatible
              ├── cli(init、run、work、tools)→ mcp コマンド
              └── mcp/server(loop は使わない)
examples/tools/echo(インターフェースと module 読み込みだけに依存)
```

## タスク

サイズは AGENTS.md の目安です(S: 1 から 2 ファイル、M: 3 から 5 ファイル)。テストは対象ファイルの隣に置きます。各タスクは 1 つの PR です。

### Phase 1: core の基本部分

#### Task 1: errors と ids

`OpenshainError(code, message, cause?)` と、`Bun.randomUUIDv7()` を使う `newWorkId()`、`newEventId()` を作ります。`WorkId`、`EventId` は branded type です。

- 受け入れ: `code` が機械可読の文字列として型で列挙されています。ID は時刻順にソートできます(連続生成した 2 つを比較します)。
- 検証: `bun test packages/core/src/errors.test.ts packages/core/src/ids.test.ts`
- 依存: なし
- ファイル: `packages/core/src/errors.ts`、`ids.ts`、各 test
- サイズ: S

#### Task 2: 設定の読み込みと検証

`openshain.yaml` の zod schema(version、company、principal、profession、model、tools、limits、debug)と `loadConfig(workspaceRoot)` を作ります。不備は行番号つきの `OpenshainError("config", …)` にします。

- 受け入れ: spec の設定例がそのまま通ります。`api_key_env` 欠落、未知の provider 名(呼び出し側が既知の provider 一覧を渡したとき)、`allow` に文字列以外、のそれぞれで行番号つきのエラーになります。`limits` と `debug` の省略時に既定値が入ります。
- 検証: `bun test packages/core/src/config`
- 依存: Task 1
- ファイル: `packages/core/src/config/schema.ts`、`load.ts`、test、`package.json`(zod、yaml)
- サイズ: M

#### Task 3: イベントとイベントログ

Event の zod schema(共通項目と type ごとの payload)を作ります。`EventLog` の append(seq を単調増加、1 行 1 JSON、`v: 1`)と read です。ファイルは snake_case、コードは camelCase で、変換はここで 1 回だけ行います。

- 受け入れ: append と read の往復で等しくなります。seq が飛びません。壊れた末尾行があれば `OpenshainError("corrupt_log", …)` で止まり、黙って読み飛ばしません。未知の type は読めますが payload は検証しません。
- 検証: `bun test packages/core/src/work/event-log.test.ts`
- 依存: Task 1、Task 2(zod を core の依存に入れるのが Task 2 のためです)
- ファイル: `packages/core/src/work/events.ts`、`event-log.ts`、test
- サイズ: M

#### Task 4: Work、遷移、store、lock

Work の schema と遷移表、`work.json` への投影の書き出し、`WorkStore`(create、get、list)、`lock`(pid と開始時刻、生存確認、stale なら引き継ぐ)を作ります。

- 受け入れ: 許されない遷移(`completed` → `in_progress` など)が `invalid_transition` で止まります。create したものが list と get で見えます。lock を持つ pid が生きている間は 2 つ目の取得が失敗し、死んでいれば取得できます。
- 検証: `bun test packages/core/src/work/work.test.ts packages/core/src/work/store.test.ts packages/core/src/work/lock.test.ts`
- 依存: Task 3
- ファイル: `packages/core/src/work/work.ts`、`store.ts`、`lock.ts`、各 test
- サイズ: M

#### Task 5: Tool のインターフェース、registry、検証、path guard

ToolDefinition と ToolProvider の型、`ToolRegistry`(provider 登録、名前の一意性、allow による絞り込み)、ajv(2020-12)による `validateInput`、`resolveWorkspacePath(root, rel)`(`..`、絶対パス、symlink の先、予約パスを拒否)を作ります。

- 受け入れ: 同名 Tool の 2 重登録が `duplicate_tool` で止まります。allow 外の Tool は `listTools` に出ません。schema 不一致の入力が実行前に落ち、理由が読めます。`../x`、`/etc/passwd`、`work/x`、`openshain.yaml`、root 外への symlink がすべて拒否されます。
- 検証: `bun test packages/core/src/tool`
- 依存: Task 1、Task 3(ToolResult が events.ts の ToolContent と Artifact を使います)
- ファイル: `packages/core/src/tool/types.ts`、`registry.ts`、`validate.ts`、`paths.ts`、test、`package.json`(ajv)
- サイズ: M

#### Task 6: model のインターフェースと投影

ModelProvider と message の型、`buildProjection(events, config, budget)` を作ります。system、追記だけの messages、許可済み Tool 定義、`opaque` の扱い、残量の 1 行です。

- 受け入れ: 同じイベント列から 2 回作った投影が JSON 文字列として一致します。`opaque` は同じ provider にだけ返ります。直近の user message の末尾に残量の 1 行があります。tool_result は 1 つの user message にまとまります。
- 検証: `bun test packages/core/src/work/projection.test.ts`
- 依存: Task 2(Config の型)、Task 3、Task 5
- ファイル: `packages/core/src/model/types.ts`、`work/projection.ts`、test
- サイズ: M

### Checkpoint 1

- `bun run typecheck`、`bun run lint`、`bun test` が通ります
- core の公開 export(`packages/core/src/index.ts`)が上の型と関数を出しています
- レビュー

Checkpoint 1(2026-09-03 完了)。次を保証します。WorkId の実行時検証、書き込みは handle と lock を通すこと、末尾に改行のないログの拒否、行き先が存在しない symlink も行き先で判定すること、reducer の厳密化、書いたイベントの読み返し確認、lock の所有権の確認と pid の範囲の限定、先頭が `.` の項目の予約、投影の正規形化と tool 呼び出しの対応検査です。あわせて payload schema を loose にし、`tool.rejected` に code、`model.completed` に raw、human の入力に call_id、usage に cache 書き込みを足しました。残した課題は 3 つです。TOCTOU(Task 8 で O_NOFOLLOW)、pid の再利用(spec に既知の限界として記載)、`list()` の性能(work.json を読む案は次の checkpoint)。

### Phase 2: 縦 1 本(fake model → 標準 Tool → CLI)

#### Task 7: createRuntime

設定から registry を組み立てます。`module:` の provider を動的 import します。`runtime.works`、`runtime.tools`(list、call: 検証 → authorize → 実行 → events)、`runtime.events` を持ちます。`capabilities.tools` が false なら起動時にエラーにします。

- 受け入れ: fake の ToolProvider と ModelProvider を factory で渡して起動できます。`tools.call` が `tool.called` と `tool.completed`(または `tool.rejected`)と `usage.recorded(tool_execution)` を残します。Tool 非対応の model で `config` エラーになります。
- 検証: `bun test packages/core/src/runtime.test.ts`
- 依存: Task 2、4、5、6
- ファイル: `packages/core/src/runtime.ts`、`tool/load-module.ts`、test、`index.ts`
- サイズ: M

#### Task 8: 標準 Tool

`fs_list`、`fs_read`、`fs_write`、`csv_read`、`csv_write`、`markdown_read` を作ります。path guard を通します。mutate は `after` に sha256 を返します。

追記(Phase 4 の後): 読む Tool は範囲と件数を返す形に改め、`fs_search` と `csv_aggregate` を足しました。CSV を丸ごと context に載せると入力トークンの大半をそれが占めたためです。表は spec を正とします。

- 受け入れ: 各 Tool が spec の表どおりに動きます。予約パスと root 外は Tool が `reserved_path` などの OpenshainError を throw し、Runtime が `tool.rejected` として記録します(`isError` の結果ではありません)。`fs_write` 後の `after.sha256` が実ファイルと一致します。CSV の引用符とカンマを含むセルが往復で崩れません。
- 検証: `bun test packages/tools`
- 依存: Task 5
- ファイル: `packages/tools/src/index.ts`、`fs.ts`、`csv.ts`、`markdown.ts`、test、`package.json`(csv-parse、csv-stringify)
- サイズ: M

#### Task 9: agent loop(fake model)

`runWork(runtime, workId, { model })` を作ります。投影 → generate → stop_reason で分岐 → tool_call は順に実行して 1 message で返す → 上限 → events。`FakeModelProvider`(台本)を `@openshain/agent/testing` に置きます。

- 受け入れ: 台本「csv_read → fs_write → end_turn」で Work が `completed` になり、`outcome.artifacts` の sha256 を Runtime が計算しています。`max_model_calls: 2` で `failed(limit_reached)` になります。`refusal` で `failed(model_refusal)` になります。provider が throw すると `model.failed` の後に `failed(model_error)` になります。1 応答に 2 つの tool_call があると両方の結果が 1 つの user message に入ります。
- 検証: `bun test packages/agent/src/loop.test.ts`
- 依存: Task 7、Task 8
- ファイル: `packages/agent/src/loop.ts`、`testing/fake-model.ts`、test、`package.json`(exports に `./testing`)
- サイズ: M

#### Task 10: ask_user と評価の記録

Runtime が足す `ask_user` Tool です。呼ばれたら `human.input_requested` を残して `waiting_input` にし、`onInput` の答えで `human.input_provided` から続行します。完了時の `evidence.recorded`(claim、refs、artifacts)も作ります。

- 受け入れ: 台本「ask_user → (答え) → end_turn」で状態が `waiting_input` を経て `completed` になります。`evidence.recorded.refs` が mutate Tool のイベント id を指します。
- 検証: `bun test packages/agent/src/loop.test.ts`
- 依存: Task 9
- ファイル: `packages/agent/src/loop.ts`(ask_user の処理は loop に同居)、test
- サイズ: S

#### Task 11: CLI の init、run、tools list

`node:util` の `parseArgs` を使います。`openshain init`(ひな型)、`openshain run "<依頼>"`(Tool ごとに 1 行、最後に状態、結果、使用量、次に動く人)、`openshain tools list` を作ります。`--workspace` と上方向の探索も入れます。コマンドは関数、bin は配線だけです。

- 受け入れ: 一時ディレクトリで `init` → 設定の provider を fake に差し替え → `run` が完走し、`work/<id>/events.jsonl` ができます。`tools list` に provider と effect と許可の有無が出ます。
- 検証: `bun test packages/cli`
- 依存: Task 9
- ファイル: `packages/cli/src/bin.ts`、`commands/init.ts`、`commands/run.ts`、`commands/tools.ts`、test
- サイズ: M

#### Task 12: CLI の work list と show

`openshain work list`、`openshain work show <id>`(状態、イベントの要約、`usage.recorded` の合計、次に動く人)を作ります。実装時に `openshain work resume <id>` を足しました。

- 受け入れ: 2 つの Work を作った後に list が 2 行になります。show の合計が events.jsonl の `usage.recorded` を足した値と一致します。`waiting_input` の Work で「次に動くのは利用者」と出ます。
- 検証: `bun test packages/cli/src/commands/work.test.ts`
- 依存: Task 11
- ファイル: `packages/cli/src/commands/work.ts`、test、`bin.ts`
- サイズ: S

### Checkpoint 2

- 一時 workspace で `openshain run` が fake model で完走します(完了条件 4、6、7、8、9、10 の自動テストがここで揃います)
- レビュー

Checkpoint 2(2026-09-04 完了)。4 面のレビュー(敵対、spec と code、コード品質、初回利用者)を 4 群に分けて反映しました。壊れた model 応答は `work.failed` へ、循環参照の検出、call id の重複、捏造された質問、読めない成果物の `missing`、fs_write の上限、csv_write の数式無効化、予約パスの大文字小文字、`authorize()` の継ぎ目、`ModelRequest.budget`、隠れた Tool の effect、CLI の見出し表と表示、テスト 13 本です。

### Phase 3: 本物の provider と交換の証明

#### Task 13: Anthropic provider

`@anthropic-ai/sdk` を使います。ModelRequest → `messages.create`(system、tools、max_tokens、providerOptions はそのまま渡します)。応答の text、tool_use、thinking(→ `opaque`)と stop_reason、usage(cache 読み取りを含む)を対応づけます。SDK の例外を `code` に対応づけます。

- 受け入れ: 記録した応答(text のみ、tool_use あり、max_tokens、refusal)の 4 fixture で対応どおりに変換されます。`providerOptions.effort` が request に載ります。認証エラーが `auth` になります。
- 検証: `bun test packages/agent/src/providers/anthropic.test.ts`
- 依存: Task 6
- ファイル: `packages/agent/src/providers/anthropic.ts`、test、`fixtures/anthropic/*.json`、`package.json`
- サイズ: M

#### Task 14: OpenAI 互換 provider

`openai` パッケージに `baseURL` を渡します。chat.completions の function calling を使います。finish_reason(stop、tool_calls、length、content_filter)と usage(`reasoning_tokens`、`cached_tokens`)を対応づけます。

- 受け入れ: 4 fixture で対応どおりに変換されます。`base_url` が設定から渡ります。tool 非対応を示す応答で `capabilities.tools` が false になる経路があります(設定で明示します)。
- 検証: `bun test packages/agent/src/providers/openai-compatible.test.ts`
- 依存: Task 6
- ファイル: `packages/agent/src/providers/openai-compatible.ts`、test、`fixtures/openai/*.json`、`package.json`
- サイズ: M

#### Task 15: 交換の証明と live smoke

同じ台本(CSV を読み Markdown を書く)を、設定の `model` だけ変えて両 provider の fixture で完走させるテストです。`OPENSHAIN_LIVE_TESTS=1` のときだけ実 API に当たる smoke も作ります。

- 受け入れ: 完了条件 1 が `bun test` で再現します。live smoke は環境変数なしでは skip と表示されます。
- 検証: `bun test packages/agent/src/swap.test.ts`
- 依存: Task 11、13、14
- ファイル: `packages/agent/src/swap.test.ts`、`live.test.ts`
- サイズ: S

### Checkpoint 3

- 完了条件 1 のテストが通ります。maintainer が実キーで live smoke を 1 回回します
- レビュー

Checkpoint 3(2026-09-05 完了)。claude-haiku-4-5-20251001 で両 provider の live smoke を 2 回回し、summary.md の「合計 350」と同じ成果物ハッシュを確認しました。1 回目に見えた「残り回数の通知に model が返事をする」挙動は system prompt の一文で直しました。2 面のレビュー(敵対、spec と code)から、Anthropic の end_turn に tool_use が同居する応答、custom の tool 呼び出し、設定からの上限のすり抜け、options からの system と tools の漏れ、読めない 200 応答、キーの空白、content: null、空の assistant ターン、拒否理由の記録を反映しました。

### Phase 4: MCP と第三者 Tool

#### Task 16: MCP Server

`@modelcontextprotocol/sdk` を使います。`work_create`、`work_select`、`work_get`、`work_list`、`work_complete`(artifacts の存在と sha256 を検証)、`work_fail`、登録済み全 Tool を出します。セッションが現在の Work を持ちます。

- 受け入れ: in-memory transport の client から `work_create` → `fs_read` → `work_complete` で Work が `completed` になり、events に Tool 呼び出しと `evidence.recorded` が残ります。現在の Work なしの Tool 呼び出しがエラー文で案内します。申告と違う sha256 のとき Runtime の値が残ります。
- 検証: `bun test packages/mcp`
- 依存: Task 7、Task 8
- ファイル: `packages/mcp/src/server.ts`、`session.ts`、test、`package.json`
- サイズ: M

#### Task 17: `openshain mcp` と第三者 Tool の例

CLI の `mcp` コマンド(stdio)と、`examples/tools/echo/tool.ts`(ToolProvider を default export)を作ります。設定の `module:` で読み込み、`tools list`、`run`(fake model が echo を呼ぶ台本)、MCP の 3 経路から呼べることをテストします。

- 受け入れ: 完了条件 2 と 3 が `bun test` で再現します。
- 検証: `bun test packages/cli/src/commands/mcp.test.ts examples/tools/echo`
- 依存: Task 11、Task 16
- ファイル: `packages/cli/src/commands/mcp.ts`、`bin.ts`、`examples/tools/echo/tool.ts`、test
- サイズ: M

### Checkpoint 4

- 完了条件 2、3 のテストが通ります。maintainer が Claude Code から `openshain mcp` に接続して 1 件通します
- レビュー

Checkpoint 4(2026-09-05 完了)。Claude Code 2.1.261 を架空の会社のフォルダで起動し、`.mcp.json` の `openshain mcp` に接続して、296 行の CSV の category 別集計を 1 件通しました。work_create → fs_list → csv_read(limit 5) → csv_aggregate 2 回 → fs_write → work_complete の 5 呼び出しで、model 呼び出しは 0 回でした。Runtime が計算した成果物の sha256 はファイルと一致し、10 カテゴリの件数と合計も CSV と一致しました。詰まったのは 2 点です。Claude Code はフォルダを信頼するまで `.mcp.json` を読まないこと(quickstart に書きます。Task 19)と、依頼文で Claude Code 自身の Read と Write を使わないよう言わないと Runtime を通らないこと(mcp.md に「外部エージェントの自前の Tool は塞がない」として書きました)。レビューから、エージェントが挙げただけの成果物に `claimed` の印を付け、model 呼び出しのない Work の使用量の表示を直しました。

### Phase 5: schema の生成と quickstart

#### Task 18: JSON Schema の生成

zod から config と event の JSON Schema を `spec/schemas/` に生成する script を作ります。CI で生成物が最新かを確認します(生成して差分があれば失敗します)。

- 受け入れ: `bun run schemas` で `spec/schemas/config.v1.json` と `events.v1.json` ができます。手で編集した生成物は CI で落ちます。
- 検証: `bun run schemas && git diff --exit-code spec/schemas`
- 依存: Task 2、Task 3
- ファイル: `scripts/generate-schemas.ts`、`spec/schemas/*.json`、`package.json`、`.github/workflows/ci.yml`
- サイズ: S

#### Task 19: quickstart

README の「状態」を quickstart に置き換えます(インストール、`openshain init`、API キーの環境変数、`run`、Claude Code からの MCP 接続)。`docs/` に設定ファイルの説明を置きます。MCP 接続の手順には `.mcp.json` の書き方(バイナリなら `openshain mcp`)と、Claude Code がフォルダを信頼するまで `.mcp.json` を読まないことを含めます。会社フォルダに置くエージェント向けの指示(CLAUDE.md、AGENTS.md)のひな型を `openshain init` が書くかは、配布の形と一緒にここで決めます。

- 受け入れ: 初めての人が README だけで `init` → `run` まで辿れます。設定ファイルの全項目に説明があります。
- 検証: 新しい一時ディレクトリで README の手順を上から実行します
- 依存: Task 15、Task 17
- ファイル: `README.md`、`docs/configuration.md`、`docs/principles.md`
- サイズ: S

### Checkpoint 5(完了)

- 完了条件 1 から 10 が、それぞれどのテストで確認されるか対応表を spec に足します
- レビュー

Checkpoint 5(2026-09-05 完了)。Task 18 は zod から config、events、work の JSON Schema を生成し、CI が最新かを見ます。Task 19 は README の quickstart(バイナリを作って PATH に置く)、docs/configuration.md、`openshain init` が書く 4 ファイルです。quickstart は新しいディレクトリで上から実行し、`run` と `.mcp.json` 経由の MCP 接続まで通しました。Runtime の model が AGENTS.md を読んで work_* を探す挙動が出たので、AGENTS.md の冒頭で MCP 経由のエージェント向けだと断りました。対応表は spec の「条件とテストの対応」です。レビューでは、架空の会社の 4 Work の記録 136 行が生成した schema を通ることを確かめ、core.md に jsonSchemas の節、format の注記、quickstart の補足を入れ、spec の Status を v0.3 に上げました。

## 並行できるもの

Checkpoint 1 の後は、Task 8(標準 Tool)、Task 13 と 14(provider)、Task 16(MCP)が互いに独立です。worktree を分ければ同時に進められます。Task 9 から 12 は直列です。

## リスク

| リスク | 影響 | 手当て |
|---|---|---|
| TypeScript 7(native tsc)がライブラリの型定義で躓く | 中 | 版を固定します。躓いたら typecheck だけ TypeScript 5.9 に戻す ADR を書きます |
| Anthropic API の仕様変化(thinking、effort、refusal の扱い) | 中 | fixture は実応答から記録します。providerOptions はそのまま渡してインターフェース側で吸収しません |
| OpenAI 互換サーバーごとの差(tool 対応、strict、usage の項目) | 中 | インターフェースは最小の共通部分にします。差は `capabilities` と providerOptions で表します。live smoke は OpenAI 本家とローカル 1 つです |
| ajv の 2020-12 と strict mode が第三者 schema を弾く | 低 | strict を off にして未知キーワードを許します。弾いた理由を `tool.rejected` に残します |
| lock の pid 生存確認が WSL と macOS で挙動が違う | 低 | `process.kill(pid, 0)` の例外種別で判定し、両 OS でテストします |
| 投影の決定性が provider の `opaque` で崩れる | 中 | Task 6 のテストで JSON 文字列の一致を固定します |

## レビューで決めたこと

- PR の粒度は 1 タスク 1 PR です。19 本。
- CSV は `csv-parse` と `csv-stringify` を使います。
- CLI に色や spinner の依存は入れません。`node:util` の `parseArgs` と素の行出力です。
- live smoke の 2 つ目の provider は、Anthropic の OpenAI 互換 endpoint 経由で Claude を呼びます。`ANTHROPIC_API_KEY` 1 つで両 provider を本物で試せます。endpoint と対応範囲(tool calling、usage の項目)は Task 15 の実装時に公式ドキュメントで確認します。
