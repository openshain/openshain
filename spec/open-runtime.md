# Spec: Open Runtime

Status: draft v0.2

## 目的

openshain の最初の実装単位。Model、Tool、Agent の入口を交換できる Runtime を作る。

利用者は、会社のフォルダで `openshain run "<依頼>"` と打つか、Claude Code や Codex から MCP 経由で同じ Runtime を使う。どちらの経路でも、Work の状態、Tool の呼び出し、model の使用量が同じ形式で `work/<id>/` に残る。

この段階で証明したいことは 1 つ。設定ファイルを書き換えるだけで model provider が切り替わり、Tool provider を足せて、CLI と MCP のどちらからでも同じ Work を進められること。

### やらないこと

- Authority engine(設定ファイルの許可リスト以外は全 Tool 呼び出しを許可する。判定の差し込み口だけ置く)
- Need-to-Know、Knowledge Compiler、Embedded Search
- ChangeSet(propose → diff → approve → apply)。書き込みは workspace 内に限って直接行い、イベントに記録する
- Approval、ExpertReviewer、Profession Pack
- Office 文書(xlsx、docx、pdf)、Email
- Work の再開(`work resume`)。ただし再開できる形でイベントを残す
- 金額換算。使用量はトークン数で記録し、単価表は持たない
- streaming。CLI は Tool 呼び出しの進捗行で代替する
- 3 つ目以降の model provider

## 前提

- Bun 1.3、TypeScript strict、Biome。AGENTS.md のとおり。
- model provider の実装は各社の公式 SDK を使う。Anthropic は `@anthropic-ai/sdk`、OpenAI 互換 API は `openai` パッケージに base URL を渡す。
- Tool の定義は JSON Schema(draft 2020-12)。Runtime が ajv(2020-12 mode)で入力を検証してから実行する。第三者 Tool は zod を使わない前提なので、任意の schema を検証できる必要がある。
- ID は UUIDv7(`Bun.randomUUIDv7()`、依存なし)に接頭辞を付ける(`work_…`、`evt_…`)。コードでは branded type(`WorkId`、`EventId`)にして取り違えを防ぐ。
- 時刻は ISO 8601(UTC)。出来事の時刻(`occurred_at`)と記録した時刻(`recorded_at`)を分ける。
- ファイル(JSON、YAML)の項目名は snake_case、コードは camelCase。変換は読み書きの境界で 1 回だけ行う。
- API キーは環境変数名だけを設定ファイルに書く。値は書かない。

## 用語とデータ

原典の名前(Company、Principal、Work、Evidence、CostEvent)を使う。

### Company Workspace

会社ごとのディレクトリ。`openshain.yaml` があるディレクトリを workspace root とする。

```
<workspace>/
├── openshain.yaml         設定
├── work/
│   └── <work-id>/
│       ├── events.jsonl   追記専用のイベントログ。正本
│       ├── work.json      現在の状態。events.jsonl からの投影で、矛盾したら events.jsonl が正
│       └── lock           書き手の pid と開始時刻。2 つ目の書き手はエラーで止まる
└── (利用者のファイル)      Tool が読み書きしてよいのはこの下だけ
```

`openshain.yaml` と `work/` は Runtime の予約パス。Tool からは読み書きとも拒否する。

### Principal

Agent が代理する人。この段階では設定ファイルに 1 人書く。すべての Work は principal を持つ。

### Work

依頼から完了までの単位。チャットのセッションより上位にあり、CLI を閉じても残る。

```yaml
id: work_0192…
principal: alice
profession: generic
type: request
objective: "receipts/ の CSV を月別に集計して summary.md に書いて"
status: completed
created_at: 2026-09-10T01:23:45Z
started_at: …
completed_at: …
outcome:
  summary: "3 か月分を集計し summary.md を作成"
  artifacts:
    - path: summary.md
      sha256: "…"
```

`status` は `queued`、`in_progress`、`waiting_input`、`waiting_approval`、`waiting_external`、`completed`、`failed`、`cancelled`。この段階で使うのは `waiting_approval` と `waiting_external` 以外。

`profession` はこの段階では `generic` だけ。指示文は設定ファイルの `profession.instructions` から読む。Profession Pack が入ると Pack が供給する。

`outcome.artifacts` は Runtime が作る。mutate Tool のイベントから書き込んだファイルを集め、ハッシュも Runtime が計算する。model が申告できるのは summary の文章だけ。

### Event

`events.jsonl` の 1 行。`v` はイベント行の schema の版で、読む側は版ごとに解釈する。

```json
{"v":1,"id":"evt_0192…","work_id":"work_0192…","seq":7,"type":"tool.called","occurred_at":"…","recorded_at":"…","payload":{"call_id":"…","provider":"standard","name":"fs_read","input":{"path":"receipts/2026-07.csv"}}}
```

種類:

| type | payload |
|---|---|
| `work.created` | objective、principal、profession、type |
| `work.status_changed` | from、to、reason |
| `model.requested` | provider、model、message_count、tool_names |
| `model.completed` | stop_reason、content(text と tool_call)。`max_tokens` で切れた途中の出力もここに残す |
| `model.failed` | code、message |
| `tool.called` | call_id、provider、name、input |
| `tool.completed` | call_id、content、is_error、observation、after(mutate のとき、書き込み後の path と sha256) |
| `tool.rejected` | call_id、name、reason(schema 不一致、未登録、許可リスト外、予約パス、workspace 外) |
| `human.input_requested` | question |
| `human.input_provided` | answer |
| `usage.recorded` | kind(`model_inference` か `tool_execution`)、provider、model、usage。`tool_execution` のときは `duration_ms` だけ |
| `evidence.recorded` | claim、refs(event id)、artifacts(path と sha256) |
| `work.completed` | summary |
| `work.failed` | reason、detail |

`usage.recorded` が原典の CostEvent。model のときの `usage` は `input_tokens`、`output_tokens`、`cached_input_tokens`、`reasoning_tokens` を持ち、Work ごとに合計できる。SpendEvent はこの段階では発生させない。

`evidence.recorded` は完了時に 1 件残す。成果物のパスとハッシュ、根拠にしたイベントの id を結びつける。

### 投影(Projection)

model に渡す内容は events.jsonl から組み立てる。会話履歴を別に保存しない。

- system: profession の指示文、principal、workspace の事実
- messages: objective、model の出力、Tool の結果を発生順に並べたもの
- tools: 許可リストを通った Tool 定義

規則:

- 過去の message は書き換えない。追記だけ。
- 同じイベント列からは byte 単位で同じ messages を作る。provider の thinking を返せる条件であり、prompt cache の前提でもある。
- provider 固有の内容(thinking など)は `opaque` として保存し、同じ provider には無変更で返し、別の provider には渡さない。
- 直近の user message の末尾に Runtime の 1 行を足す。「残り model 呼び出し N 回、Tool 呼び出し M 回」。model が残量を知って畳めるようにする。追記なので過去の message は変わらない。

## Contract

`packages/core` に置く。公式実装も第三者実装も同じものを使う。

### ModelProvider

```ts
export interface ModelProvider {
  readonly id: string; // "anthropic" | "openai-compatible" | 第三者の id
  describe(): { provider: string; model: string; capabilities: { tools: boolean } };
  generate(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
}

export interface ModelRequest {
  system?: string;
  messages: ModelMessage[];
  tools?: ToolDefinition[];
  maxOutputTokens?: number;
  providerOptions?: Record<string, unknown>; // provider にそのまま渡す。共通化しない
}

export type ModelMessage =
  | { role: "user"; content: UserPart[] }
  | { role: "assistant"; content: AssistantPart[] };

export type UserPart =
  | { type: "text"; text: string }
  | { type: "tool_result"; callId: string; content: string; isError?: boolean };

export type AssistantPart =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "opaque"; provider: string; data: unknown }; // thinking など。同じ provider にだけ返す

export interface ModelResponse {
  message: { role: "assistant"; content: AssistantPart[] };
  stopReason: "end_turn" | "tool_call" | "max_tokens" | "refusal" | "other";
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
  };
  raw?: unknown; // provider の生の応答。既定では保存しない
}
```

- `capabilities.tools` が false の model を設定したら、起動時にエラーにする。
- `refusal` は provider が安全上の理由で応答を止めたことを表す。Runtime は Work を `failed`(reason: `model_refusal`)にする。
- provider ごとの違い(thinking、effort、cache)は `providerOptions` で渡す。契約側で吸収しない。

### ToolProvider

```ts
export interface ToolProvider {
  readonly id: string; // "standard" | 第三者の id
  listTools(): Promise<ToolDefinition[]>;
  call(call: { id: string; name: string; input: unknown }, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolDefinition {
  name: string; // ^[a-z][a-z0-9_]*$。provider をまたいで一意
  description: string;
  inputSchema: JsonSchema; // draft 2020-12 の object
  effect: "observe" | "mutate";
}

export interface ToolContext {
  workId: WorkId;
  principalId: string;
  workspaceRoot: string;
  signal?: AbortSignal;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string } | { type: "json"; value: unknown }>;
  isError?: boolean;
  observation?: { source: string; retrievedAt: string }; // 出典
  after?: Array<{ path: string; sha256: string }>; // mutate のとき、書き込み後の状態
}
```

- 名前が重複する Tool が登録されたら起動時にエラーにする。黙って上書きしない。
- Runtime は `inputSchema` で入力を検証してから `call` する。不一致は `tool.rejected` として記録し、model には `isError` の結果として返す。
- 1 つの応答に複数の tool_call が来たら、順に実行し、結果はまとめて 1 つの user message で返す。分けて返すと model が並列呼び出しをやめる。
- `effect: "mutate"` の Tool は、この段階では直接実行する。後の段階で ChangeSet を通す差し込み口になる。

### エラー

- provider(Model、Tool)の失敗は `OpenshainError`(`code` と `message`)を throw する。`code` は `auth`、`network`、`rate_limit`、`invalid_response`、`config` のような機械が読める語。Runtime が捕まえて `model.failed` などのイベントにし、Work を `failed` にする。
- Tool の業務上の失敗(ファイルがない、CSV が壊れている)は throw せず、`isError: true` の ToolResult で返す。model に見せて続行する。
- provider の応答は第三者データとして扱い、イベントに入れる前に形を検証する。検証に落ちたら `invalid_response`。
- `raw` は既定で保存しない。`debug.persist_raw: true` のときだけイベントに含める。

### 標準 Tool(`packages/tools`)

| name | effect | 内容 |
|---|---|---|
| `fs_list` | observe | ディレクトリ一覧 |
| `fs_read` | observe | テキストファイルの読み取り |
| `fs_write` | mutate | テキストファイルの書き込み(新規か上書き)。結果に `after` を含める |
| `csv_read` | observe | CSV を行の配列として返す。ヘッダ行あり |
| `csv_write` | mutate | 行の配列を CSV に書く。結果に `after` を含める |
| `markdown_read` | observe | Markdown をテキストとして読む(見出し一覧つき) |

- すべてのパスは workspace root からの相対パス。root の外を指すパス(`..`、絶対パス、symlink の先)と予約パス(`openshain.yaml`、`work/`)は拒否する。
- Runtime 自身が 1 つ Tool を足す。`ask_user`(effect: observe)。model がこれを呼ぶと Work は `waiting_input` になる。CLI では利用者に質問を表示して答えを受け取り、続行する。MCP では外部 Agent 側が利用者に聞くので登録しない。

## Runtime の振る舞い(`packages/agent`)

```
Work を作る(work.created)。lock を取る
  ↓
投影を組み立てる
  ↓
ModelProvider.generate(model.requested → model.completed → usage.recorded)
  ↓
stop_reason で分岐
  end_turn   → evidence.recorded → work.completed
  tool_call  → 各 tool_call を検証 → 実行(tool.called → tool.completed | tool.rejected) → 結果を追記 → 先頭へ
  max_tokens → 途中の出力を model.completed に残し、work.failed(limit_reached)
  refusal    → work.failed(model_refusal)
provider が throw → model.failed → work.failed(model_error)
```

- 停止条件: 完了、`ask_user`、上限到達、model の refusal、回復できないエラー。
- 上限は設定ファイルで持つ。初期値は `max_model_calls: 30`、`max_tool_calls: 100`、`max_output_tokens: 16000`。計測して直す。超えたら `work.failed`(reason: `limit_reached`)。
- Tool の失敗は model に `isError` で返し、Work は続く。Tool 呼び出しの回数には数える。
- model の API エラーは SDK の再試行に任せ、それでもだめなら `model.failed` を残して `work.failed`(reason: `model_error`)。
- 判定の差し込み口: Tool を実行する直前に `authorize(call, ctx)` を通す。この段階の実装は許可リストの判定だけで、それ以外は常に許可。
- lock: `work/<id>/lock` に pid と開始時刻を書く。すでにあり、その pid が生きていればエラー。死んでいれば引き継ぐ。

## 入口

### CLI(`packages/cli`、コマンド名 `openshain`)

| コマンド | 動き |
|---|---|
| `openshain init` | カレントディレクトリに `openshain.yaml` のひな型を書く |
| `openshain run "<依頼>"` | Work を作って完了か停止まで進める。Tool 呼び出しごとに 1 行出す。最後に状態、結果、使用量の合計、次に動くのが誰か(利用者、model、なし)を出す |
| `openshain work list` | Work の一覧(id、status、objective、created_at) |
| `openshain work show <id>` | 状態、イベントの要約、使用量の合計、次に動くのが誰か |
| `openshain tools list` | 登録された Tool の一覧(name、provider、effect、許可の有無) |
| `openshain mcp` | MCP Server を stdio で起動する |

`--workspace <dir>` で workspace root を指定できる。省略時はカレントディレクトリから上に向かって `openshain.yaml` を探す。

### MCP Server(`packages/mcp`)

外部 Agent が思考し、Runtime は Work の状態と Tool と記録を提供する。

MCP tool:

| name | 内容 |
|---|---|
| `work_create` | objective と type を受けて Work を作り、そのセッションの現在の Work にする |
| `work_select` | 既存の Work を現在の Work にする |
| `work_get`、`work_list` | 参照 |
| `work_complete` | summary と artifacts を受ける。artifacts は Runtime がファイルの存在と sha256 を検証し、Runtime の Tool で書いたファイルと合わせて `evidence.recorded` と `work.completed` を残す |
| `work_fail` | reason を受けて `work.failed` を残す |
| 登録された全 Tool | CLI と同じ名前、同じ schema。呼び出しは現在の Work に記録される |

現在の Work がない状態で Tool を呼ぶと、Work を作るよう促すエラーを返す。外部 Agent の model 使用量は Runtime から見えないので、この経路では `usage.recorded` は Tool 実行の分だけになる。

### SDK(`@openshain/core`、`@openshain/agent`)

```ts
import { createRuntime } from "@openshain/core";
import { runWork } from "@openshain/agent";

const runtime = await createRuntime({ workspaceRoot: "." });
const work = await runtime.works.create({ objective: "…" });
await runWork(runtime, work.id);
```

`runtime.works`(create、get、list)、`runtime.tools`(list、call)、`runtime.events`(append、read)を公開する。CLI と MCP はこの SDK の上に載る。

## 設定ファイル `openshain.yaml`

```yaml
version: 1
company:
  name: サンプル株式会社
principal:
  id: alice
  name: Alice
profession:
  id: generic
  instructions: |
    あなたはこの会社の事務担当です。依頼された作業を、workspace 内のファイルだけを使って進めてください。
model:
  provider: anthropic            # anthropic | openai-compatible
  model: claude-opus-5
  api_key_env: ANTHROPIC_API_KEY
  # base_url: http://localhost:11434/v1   # openai-compatible のとき
  # options: { effort: high }             # providerOptions にそのまま渡す
tools:
  - provider: standard
    allow: [fs_list, fs_read, csv_read, markdown_read, fs_write, csv_write]  # 省略時は全部
  - module: ./tools/my-tool.ts   # ToolProvider を default export するモジュール
limits:
  max_model_calls: 30
  max_tool_calls: 100
  max_output_tokens: 16000
# debug:
#   persist_raw: true
```

- 設定の検証は起動時に行い、不備は行番号つきで報告する。
- `model` を書き換えるだけで provider が切り替わる。コードは変えない。
- `allow` に書かれていない Tool は model に定義を渡さない。呼ばれたら `tool.rejected`(reason: 許可リスト外)。

## 構成

| パス | この spec で置くもの |
|---|---|
| `packages/core/src/model/` | ModelProvider の契約と message 型 |
| `packages/core/src/tool/` | ToolProvider の契約、JSON Schema 検証、名前の登録と許可リスト |
| `packages/core/src/work/` | Work、Event、投影、`work/<id>/` の読み書きと lock |
| `packages/core/src/config/` | `openshain.yaml` の読み込みと検証 |
| `packages/core/src/errors.ts` | `OpenshainError` |
| `packages/core/src/runtime.ts` | `createRuntime` |
| `packages/agent/src/` | loop、`ask_user`、Anthropic と OpenAI 互換の ModelProvider |
| `packages/tools/src/` | 標準 Tool |
| `packages/mcp/src/` | MCP Server |
| `packages/cli/src/` | コマンド |
| `examples/tools/echo/` | 第三者 Tool の例。契約と設定だけで組み込めることの証明に使う |

## コードの書き方

契約は `interface`、データは `type` と zod の schema。zod の schema から JSON Schema を生成して `spec/` に置く。

```ts
// packages/core/src/work/work.ts
import { z } from "zod";

export const WorkStatus = z.enum([
  "queued", "in_progress", "waiting_input", "waiting_approval",
  "waiting_external", "completed", "failed", "cancelled",
]);
export type WorkStatus = z.infer<typeof WorkStatus>;

export function transition(from: WorkStatus, to: WorkStatus): void {
  if (!allowed[from].includes(to)) {
    throw new OpenshainError("invalid_transition", `cannot move work from ${from} to ${to}`);
  }
}
```

状態遷移、上限の判定、パスの検査は普通の関数で書き、model の出力に頼らない。

## テスト

- `bun test`。ネットワークなしで全部通る。
- loop は台本どおりに応答する `FakeModelProvider` で試す。
- Anthropic と OpenAI 互換の provider は、記録した HTTP 応答を fetch の差し替えで返して試す。実 API への smoke test は `OPENSHAIN_LIVE_TESTS=1` のときだけ動く。
- MCP Server は MCP SDK の in-memory transport で、client から `work_create` → Tool 呼び出し → `work_complete` を通す。
- 第三者 Tool は、一時 workspace の `openshain.yaml` に `examples/tools/echo` を書いて読み込む。
- テストで確認する約束: workspace 外と予約パスは拒否される、schema 不一致と許可リスト外は実行前に止まる、上限で止まる、同じ Work の使用量が合計できる、同じイベント列から同じ投影が作られる、2 つ目の書き手は lock で止まる、Tool に対応しない model は起動時に止まる。

## 完了の条件

1. 同じ依頼を、`openshain.yaml` の `model` を書き換えるだけで Anthropic と OpenAI 互換 API の両方で完走する。コードは変えない。
2. Claude Code か Codex を MCP client として接続し、`work_create` → Tool 呼び出し → `work_complete` で同じ依頼を完走する。Runtime 側のコードは変えない。
3. `examples/tools/echo` の Tool を設定ファイルに書くだけで、`openshain tools list`、`openshain run`、MCP の 3 つから呼べる。
4. すべての model 呼び出しが `usage.recorded` として残り、`openshain work show <id>` が Work ごとの合計を出す。
5. 1 から 4 を `bun test` で再現できる。
6. workspace 外と予約パスへの読み書きは拒否され、`tool.rejected` として残る。
7. schema に合わない Tool 入力と許可リスト外の Tool は実行前に止まり、`tool.rejected` として残る。
8. 上限に達した Work は `failed`(reason: `limit_reached`)で止まり、途中までのイベントが残る。
9. 完了した Work の `outcome.artifacts` は Runtime が計算したハッシュを持ち、model の申告と食い違っても Runtime の値が残る。
10. 同じ `events.jsonl` から投影を 2 回作ると byte 単位で一致する。

## 未決

- MCP の elicitation を `ask_user` の代わりに使うか。この段階では使わない。
- 設定ファイルの `allow` を、後の Authority policy とどう統合するか。ChangeSet の spec で決める。
