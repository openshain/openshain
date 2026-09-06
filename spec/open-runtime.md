# Spec: Open Runtime

Status: v0.3(実装済み。完了の条件 1 から 10 を満たし、対応するテストがあります)

## 目的

openshain で最初に作る部分です。Model、Tool、エージェントの入口を交換できる Runtime を作ります。

利用者は、会社のフォルダで `openshain run "<依頼>"` と打つか、Claude Code や Codex から MCP 経由で同じ Runtime を使います。どちらの経路でも、Work の状態、Tool の呼び出し、model の使用量が同じ形式で `work/<id>/` に残ります。

この段階で証明したいことは 1 つです。設定ファイルを書き換えるだけで model provider が切り替わり、Tool provider を足せて、CLI と MCP のどちらからでも同じ Work を進められることです。

### やらないこと

- Authority engine(設定ファイルの許可リスト以外は全 Tool 呼び出しを許可します。判定の差し込み口だけ置きます)
- Need-to-Know、Knowledge Compiler、Embedded Search
- ChangeSet(propose → diff → approve → apply)。書き込みは workspace 内に限って直接行い、イベントに記録します
- Approval、ExpertReviewer、Profession Pack
- Office 文書(xlsx、docx、pdf)、Email
- 金額換算。使用量はトークン数で記録し、単価表は持ちません
- streaming。CLI は Tool 呼び出しの進捗行で代替します
- 3 つ目以降の model provider

## 前提

- Bun 1.3、TypeScript strict、Biome です。AGENTS.md のとおりです。
- model provider の実装は各社の公式 SDK を使います。Anthropic は `@anthropic-ai/sdk`、OpenAI 互換 API は `openai` パッケージに base URL を渡します。
- Tool の定義は JSON Schema(draft 2020-12)です。Runtime が ajv(2020-12 mode)で入力を検証してから実行します。第三者 Tool は zod を使わない前提なので、任意の schema を検証できる必要があります。
- ID は UUIDv7(`Bun.randomUUIDv7()`、依存なし)に接頭辞を付けます(`work_…`、`evt_…`)。コードでは branded type(`WorkId`、`EventId`)にして取り違えを防ぎます。
- 時刻は ISO 8601(UTC)です。出来事の時刻(`occurred_at`)と記録した時刻(`recorded_at`)を分けます。
- ファイル(JSON、YAML)の項目名は snake_case、コードは camelCase です。変換は読み書きの境界で 1 回だけ行います。
- API キーは環境変数名だけを設定ファイルに書きます。値は書きません。

## 用語とデータ

原典の名前(Company、Principal、Work、Evidence、CostEvent)を使います。

### Company Workspace

会社ごとのディレクトリです。`openshain.yaml` があるディレクトリを workspace root とします。

```
<workspace>/
├── openshain.yaml         設定
├── work/
│   └── <work-id>/
│       ├── events.jsonl   追記専用のイベントログ。原本
│       ├── work.json      現在の状態。events.jsonl からの投影で、矛盾したら events.jsonl が原本
│       └── lock           書き手の pid と開始時刻。2 つ目の書き手はエラーで止まる
└── (利用者のファイル)      Tool が読み書きしてよいのはこの下だけ
```

`openshain.yaml` と `work/`、および先頭が `.` の項目(`.git`、`.github`、`.env` など)は Runtime の予約パスです。Tool からは読み書きとも拒否します。

lock は取得した書き手(pid と開始時刻)だけが解放できます。pid が 1 以下か整数でない lock は死んだものとして引き継ぎます。既知の限界として、別のプロセスに再利用された pid は検出できません。手で lock を消すまで `lock_held` のままになります。

### openshain.yaml の責務

Company Workspace の manifest です。root の印であり、この会社に属するものを宣言します。会社の repo に入れて版管理し、self-host でも managed でも同じ中身を使います。会社の事実を置く別のファイル(company.yaml など)は作らず、必要になった事実はこのファイルに追加します。

持つもの:

- 会社の事実(`company`)と、エージェントが代理する人(`principal`)
- 使う職能(`profession`)。いまは指示文を直接書きます。Profession Pack が入ったら `pack:` で参照します
- 社員が使ってよい Tool(`tools`)と、その許可リスト(`allow`)
- 呼び出し回数の上限(`limits`)
- 使うベンダーと model(`model.provider`、`model.model`)

環境の節。`model.api_key_env`、`model.base_url`、`model.options`、`debug` は Runtime を動かす環境に属します。当面は同じファイルに置きますが、2 つ目の環境(managed)が現れた時点で、commit しない `openshain.local.yaml` による上書きを追加します。それまでは作りません。

持たないもの: 秘密の値(環境変数名だけを書きます)、Work の状態(`work/`)、知識(`rules/`、`sources/`)、証跡、生成物(`build/`)。

### Principal

エージェントが代理する人です。この段階では設定ファイルに 1 人書きます。すべての Work は principal を持ちます。

### Work

依頼から完了までの単位です。チャットのセッションより上位にあり、CLI を閉じても残ります。

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

`status` は `queued`、`in_progress`、`waiting_input`、`waiting_approval`、`waiting_external`、`completed`、`failed`、`cancelled` です。この段階で使うのは `waiting_approval` と `waiting_external` 以外です。`completed` と `failed` には `work.completed` と `work.failed` のイベントでだけ到達します。`failed` のときは `failure: { reason, detail }` を持ちます。

`profession` はこの段階では `generic` だけです。指示文は設定ファイルの `profession.instructions` から読みます。Profession Pack が入ると Pack が供給します。

`outcome.artifacts` は Runtime が作ります。mutate Tool のイベントから書き込んだファイルを集め、ハッシュも Runtime が計算します。model が申告できるのは summary の文章だけです。

### Event

`events.jsonl` の 1 行です。`v` はイベント行の schema の版で、読む側は版ごとに解釈します。envelope(v、id、work_id、seq、type、occurred_at、recorded_at)は厳密に検証し、payload は知らない項目を保持して通します。これにより、後から項目を追加しても古い Runtime がログを拒否しません。envelope を変えるときは `v` を上げます。

書き込みは正規形で行います。キーは再帰的にソートし、自由形式の値(`input`、`data`、`value`、`raw`)の中の undefined は null にします。同じイベントは同じバイト列になります。append は自分の行を読み返してから書き、読めない行は書きません。末尾が改行で終わっていないファイルと、開いてから他の書き手が変えたファイルへの追記は拒否します。

```json
{"v":1,"id":"evt_0192…","work_id":"work_0192…","seq":7,"type":"tool.called","occurred_at":"…","recorded_at":"…","payload":{"call_id":"…","provider":"standard","name":"fs_read","input":{"path":"receipts/2026-07.csv"}}}
```

種類:

| type | payload |
|---|---|
| `work.created` | objective、principal、profession、type、parent(任意。この Work を始めた Work の id)、agent_name(任意。この Work で model が名乗る名前。セッションが選び、そこから始めた Work は同じ値を持ちます) |
| `work.status_changed` | from、to、reason |
| `model.requested` | provider、model、message_count、tool_names |
| `model.completed` | stop_reason、content(text と tool_call)、raw(`debug.persist_raw` のときだけ)。`max_tokens` で切れた途中の出力もここに残します |
| `model.failed` | code、message |
| `tool.called` | call_id、provider、name、input |
| `tool.completed` | call_id、content、is_error、observation、after(mutate のとき、書き込み後の path と sha256) |
| `tool.rejected` | call_id、name、code(`schema_mismatch`、`unknown_tool`、`not_allowed`、`reserved_path`、`outside_workspace`、`invalid_path`)、reason |
| `human.input_requested` | call_id(`ask_user` の呼び出し)、question |
| `human.input_provided` | call_id、answer。答えは同じ call_id の `tool.completed` としても記録し、投影はそちらを使います |
| `human.message` | text。セッションで人が言ったことです。投影では user message になります |
| `usage.recorded` | kind(`model_inference` か `tool_execution`)、provider、model、usage。`tool_execution` のときは `duration_ms` だけです |
| `evidence.recorded` | claim、refs(event id)、artifacts(path、sha256、完了時に読めなかったときは missing、この Work の Tool が書いていない申告だけのものは claimed) |
| `work.completed` | summary |
| `work.failed` | reason、detail |

`usage.recorded` が原典の CostEvent です。model のときの `usage` は `input_tokens`、`output_tokens`、`cached_input_tokens`、`cache_write_tokens`、`reasoning_tokens` を持ち、Work ごとに合計できます。SpendEvent はこの段階では発生させません。

`evidence.recorded` は完了時に 1 件残します。成果物のパスとハッシュ、根拠にしたイベントの id を結びつけます。ハッシュは Runtime がそのときのファイルから計算します。読めなかった成果物には `missing: true` を付け、sha256 は Tool の申告のまま残します。検証できた値ではありません。エージェントが挙げただけで、この Work の Tool が書いていないファイルには `claimed: true` を付けます。ハッシュは Runtime の値ですが、その Work の作業の結果だという裏付けは記録にありません。

### 投影(Projection)

model に渡す内容は events.jsonl から組み立てます。会話履歴を別に保存しません。

- system: profession の指示文、会社名、依頼する人(principal。model はその人の代理として働き、その人と話す。model 自身はその人ではなく、この会社の社員エージェント)、記録に `agent_name` があればその名前、Runtime の決まり(件数、合計、検索は Tool の値をそのまま使う。末尾の残量の 1 行は通知で返事は要らない。依頼が終わったら要約して終える)です
- messages: objective、人の発言(`human.message`)、model の出力、Tool の結果を発生順に並べたものです。`type: session` の Work では objective は入れません。`session` は会話の記録に予約した type で、`work_create` と `work_run` は受け付けず、`work resume` でも動きません
- tools: 許可リストを通った Tool 定義です

規則:

- 過去の message は書き換えません。追記だけです。
- 同じイベント列からは byte 単位で同じ messages を作ります。provider の thinking を返せる条件であり、prompt cache の前提でもあります。
- provider 固有の内容(thinking など)は `opaque` として保存し、同じ provider には無変更で返し、別の provider には渡しません。
- 末尾に Runtime の user message を 1 つ追加します。「残り model 呼び出し N 回、Tool 呼び出し M 回」の 1 行だけを持ちます。同じ数値を `budget` として構造化しても返します。model が残量を知って畳めるようにします。独立した message なので、前の message の byte はターンをまたいで変わりません。Runtime は `stableMessages` で「末尾の残り回数の行を除いた件数」を provider に渡し、provider はそこに prompt cache の切れ目を置きます。provider は連続する user message を 1 ターンとして送ります。
- tool_result は直前の assistant message の tool_call に対応していなければならず、tool_call は次の message までに結果を持たなければなりません。どちらかが欠けたログは壊れたものとして扱います。

## インターフェース

`packages/core` に置きます。公式実装も第三者実装も同じものを使います。

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
  budget?: { modelCallsLeft: number; toolCallsLeft: number }; // 残りの回数。provider は無視してよい。公式の 2 つの provider は送らない
  stableMessages?: number; // 先頭から何件の message が次のターンも変わらないか。provider は prompt cache の切れ目に使う
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
    cacheWriteTokens?: number;
    reasoningTokens?: number;
  };
  raw?: unknown; // provider の生の応答。既定では保存しない
}
```

- `capabilities.tools` が false の model を設定したら、起動時にエラーにします。
- `refusal` は provider が安全上の理由で応答を止めたことを表します。Runtime は Work を `failed`(reason: `model_refusal`)にします。
- provider ごとの違い(thinking、effort、cache)は `providerOptions` で渡します。インターフェース側で吸収しません。
- usage の `inputTokens` は入力の全部で、prompt cache から読んだ分と書いた分を含みます。`cachedInputTokens` はそのうち読んだ分、`cacheWriteTokens` は書いた分、`reasoningTokens` は出力のうち thinking の分です。provider によって生の値の意味が違うので、provider がこの形に揃えます。

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

- 名前が重複する Tool が登録されたら起動時にエラーにします。黙って上書きしません。
- Runtime は `inputSchema` で入力を検証してから `call` します。不一致は `tool.rejected` として記録し、model には `isError` の結果として返します。
- `inputSchema` は `type: object` でなければなりません。入力の値を渡すのは model なので、`pattern` と `patternProperties` にバックトラックが爆発する正規表現(ReDoS)があれば登録を拒否します。
- 1 つの応答に複数の tool_call が来たら、順に実行し、結果はまとめて 1 つの user message で返します。分けて返すと model が並列呼び出しをやめます。
- Tool の結果の text は 50,000 文字で切り、切ったことを末尾に印します。Tool 1 つで model の context を溢れさせないためです。
- `effect: "mutate"` の Tool は、この段階では直接実行します。後の段階で ChangeSet を通す差し込み口になります。

### エラー

- provider(Model、Tool)の失敗は `OpenshainError`(`code` と `message`)を throw します。`code` は `auth`、`network`、`rate_limit`、`invalid_response`、`config` のような機械が読める語です。Runtime が捕まえて `model.failed` などのイベントにし、Work を `failed` にします。
- Tool の業務上の失敗(ファイルがない、CSV が壊れている)は `isError: true` の ToolResult として model に見せ、Work は続きます。Tool が素の Error を throw した場合も Runtime が同じ形に変換します。
- provider の応答は第三者データとして扱い、イベントに入れる前に形を検証します。検証に落ちたら `invalid_response` です。
- Tool の `call` が `tool.rejected` のコード(`schema_mismatch`、`unknown_tool`、`not_allowed`、`reserved_path`、`outside_workspace`、`invalid_path`)を持つ OpenshainError を throw したら、Runtime は実行前の拒否と同じ `tool.rejected` として記録します。
- `code` の一覧: `auth`、`network`、`rate_limit`、`invalid_response`、`config`、`corrupt_log`、`invalid_transition`、`duplicate_tool`、`invalid_id`、`invalid_tool`、`invalid_path`、`lock_held`、`not_found`、`reserved_path`、`outside_workspace`、`concurrent_write`、`invalid_event`。第三者の provider が独自の理由を持つときは `message` に書きます。
- `raw` は既定で保存しません。`debug.persist_raw: true` のときだけイベントに含めます。

### Anthropic provider(`packages/agent`)

`@anthropic-ai/sdk` の Messages API を使います。対応は次のとおりです。

- stop_reason: `end_turn` と `stop_sequence` は `end_turn`、`tool_use` は `tool_call`、`max_tokens` と `refusal` はそのままです。それ以外(`pause_turn`、`model_context_window_exceeded`)は `other` です。content に tool_use があれば stop_reason が `end_turn` でも `tool_call` にします(そう返すゲートウェイがあります)。refusal の `stop_details.explanation` は text として残します
- content: text と tool_use はそのままです。thinking と redacted_thinking、その他のブロックは `opaque`(provider: anthropic)として保存し、次の request の assistant message に無変更で戻します
- usage: inputTokens は input_tokens と cache_read_input_tokens と cache_creation_input_tokens の和です(API の input_tokens はキャッシュ分を含みません)。output_tokens、cache_read_input_tokens(cachedInputTokens)、cache_creation_input_tokens(cacheWriteTokens)、output_tokens_details.thinking_tokens(reasoningTokens)を写します
- エラー: 401 と 403 は `auth`、429 は `rate_limit`、400 と 404 は `config`、接続の失敗と中断と 5xx は `network`、読めない応答とそれ以外の API エラーは `invalid_response` です。SDK の再試行(既定 2 回)の後に投げます
- request: prompt cache の切れ目は、`stableMessages` が指す最後の message の末尾のブロックに `cache_control: { type: ephemeral }` として置きます。次のターンはそこまでをキャッシュから読み、続きを書きます。request 末尾の自動キャッシュは使いません(切れ目が毎ターン変わる残り回数の行の後ろになり、一度も当たりません)。`providerOptions` は request の body にそのまま載ります(`thinking`、`output_config`、`cache_control` の上書きなど)。`effort` だけは `output_config.effort` の略記として受けます。model、max_tokens、system、tools、messages、stream(常に false)は Runtime のもので上書きできません
- API キーは `api_key_env` の環境変数から読みます(前後の空白は取り除きます)。未設定なら起動時に `config` エラーです。認証は `x-api-key` ヘッダです。`base_url` は root を指し、省略時は `https://api.anthropic.com` です。末尾の `/v1` は SDK が自分で追加するので外します
- 応答が message の形でない(content や usage が欠けている、JSON でない)ときは `invalid_response` です。usage の項目が欠けていれば 0 にします。`maxOutputTokens` が省略された request では 16,000 です。system と tools が空なら送りません。相手 provider の opaque だけでできた assistant のターンは送る前に `invalid_response` にします

### OpenAI 互換 provider(`packages/agent`)

`openai` パッケージの chat completions を使います。OpenAI 本体、ローカルのサーバー、他社の互換 API のどれでも `base_url` で切り替えます。対応は次のとおりです。

- finish_reason: `stop` は `end_turn`、`tool_calls` は `tool_call`、`length` は `max_tokens`、`content_filter` は `refusal` です。それ以外は `other` です。function の tool 呼び出しがあれば finish_reason が `length` 以外なら `tool_call` として扱います(`stop` と返すサーバーがあります)。function 以外の tool 呼び出し(custom など)は opaque に残して送り返さず、それしかなければ `other` です。`refusal` の文は text として残します
- content: assistant の content は text(text の parts の配列で返すサーバーはつなぎます)、tool_calls は `tool_call` です。arguments は JSON として読み、読めなければ文字列のまま渡して schema の検証に報告させます。assistant message の content と tool_calls 以外の項目(reasoning_content など)は `opaque`(provider: openai-compatible)として保存し、次の request の assistant message に戻します
- messages: system は先頭の system message です。Tool の結果は 1 つずつ `tool` message(tool_call_id 付き)にします。chat completions の tool message にはエラーの印がないので、失敗した結果も本文だけで伝わります。text がない assistant message は `content: null` です。user のターン内の text は Tool の結果の後ろにまとめます(投影はその並びを作りません)。opaque は assistant message に浅く合流し、`annotations` は opaque に含めません
- usage: prompt_tokens、completion_tokens、prompt_tokens_details.cached_tokens(cachedInputTokens)、completion_tokens_details.reasoning_tokens(reasoningTokens)を写します。usage を返さないサーバーでは 0 です
- エラー: Anthropic provider と同じ対応です(401 と 403 は `auth`、429 は `rate_limit`、400 と 404 は `config`、接続の失敗と中断と 5xx は `network`、読めない応答は `invalid_response`)
- request: 上限は `max_completion_tokens` で送ります。`providerOptions` に `max_tokens` があれば古い名前で送りますが、値は Runtime の上限のままです(古いサーバー向けの印です)。`providerOptions` の残りは body にそのまま載ります(`reasoning_effort`、`temperature` など)。`n` を増やしても最初の choice だけを使います。model、messages、tools、stream(常に false)、上限は Runtime のもので上書きできません
- `options: { tools: false }` は tool 呼び出しに対応しないサーバーの宣言です。`capabilities.tools` が false になり、起動時に `config` エラーで止まります
- prompt cache は接頭辞の自動一致に任せ、`stableMessages` は使いません。prompt_tokens はキャッシュ分を含むので inputTokens にそのまま入ります
- `base_url` は `/v1` までを含む root です(例: `http://localhost:11434/v1`)。省略時は `https://api.openai.com/v1` です。API キーは `api_key_env` の環境変数から読み(前後の空白は取り除きます)、`Authorization: Bearer` で送ります
- 応答が completion の形でない(message がない、JSON でない)ときは `invalid_response` です。相手 provider の opaque だけでできた assistant のターンは送る前に `invalid_response` にします。`retry-after` を秒で返すサーバーでは SDK がその秒数を実時間で待ちます

### 標準 Tool(`packages/tools`)

Tool の結果は観測であって転送ではありません。ファイルを丸ごと model の context に載せると、数百行の CSV でも入力トークンの大半をそれが占め、しかも足し算を model にやらせることになります。観測する Tool は件数と先頭の一部を返し、続きは `offset` と `limit` で取りに行かせます。数える、合計する、探すは Tool がやります。

| name | effect | 入力 | 返すもの |
|---|---|---|---|
| `fs_list` | observe | `path`(既定 `.`)、`pattern`(名前の wildcard。`*` と `?`)、`limit`(既定 200) | 項目の名前、種類、サイズ。全件数と、切ったかどうか。再帰しません |
| `fs_search` | observe | `pattern`(`*` と `?` だけが wildcard。他の文字はそのまま)、`path`(既定 `.`。ディレクトリかファイル)、`limit`(既定 100) | 一致した行の path、行番号、本文。隠し項目、symlink、バイナリ、1 MiB 超のファイルは飛ばします。正規表現は受け取りません |
| `fs_read` | observe | `path`、`offset`(行)、`limit`(既定 200 行) | 範囲の本文と、全行数、バイト数、続きがあるか |
| `fs_write` | mutate | `path`、`content` | 書いた path と sha256(`after`) |
| `csv_read` | observe | `path`、`offset`(行)、`limit`(既定 50 行) | 列名、全行数、範囲の行(1 行 1 オブジェクト)、続きがあるか |
| `csv_aggregate` | observe | `path`、`group_by`(列)、`sum`(数値の列)、`filter`(列 = 値)、`limit`(既定 100 グループ) | グループごとの行数と、`sum` に挙げた列の sum、min、max、数値だった件数、数値でなく飛ばした件数。`overall` に、条件に合った全行の同じ値。`1,200` や `¥300` は数値として読みます |
| `csv_write` | mutate | `path`、`rows`、`columns` | 書いた path と sha256(`after`) |
| `markdown_read` | observe | `path`、`section`(見出しの文字列)、`limit`(既定 100 行) | 見出しの一覧(level、text、行番号)と先頭の本文。`section` があれば、その見出しから、同じか上の level の次の見出しの手前までを返します |

- 観測する Tool は結果の先頭に JSON で範囲の情報(path、offset、returned、全体の件数、truncated)を置き、本文はその後に text で続けます。model はこの 1 行を確認して、続きを読むか集計に切り替えるかを決めます。
- 既定の範囲は小さくしてあります。広げたいときは `limit` を上げます(上限は Tool ごとに schema に書きます)。それでも 50,000 文字の上限は残ります。範囲の制限は context を守るためのもの、上限は事故を止めるためのものです。
- 1 MiB を超えるファイルは開きません(`fs_read`、`csv_read`、`csv_aggregate`、`markdown_read` はエラー、`fs_search` は飛ばします)。書き込みも同じ 1 MiB で止めます。Tool が書いたものは Tool が開けます。
- `csv_aggregate` は列の存在を先に確かめ、無い列を挙げられたら列名の一覧を `isError` で返します。グループはグループの値の順に並べ、同じ入力には同じ出力を返します。
- すべてのパスは workspace root からの相対パスです。root の外を指すパス(`..`、絶対パス、symlink の先)と予約パス(`openshain.yaml`、`work/`、先頭が `.` の項目)は拒否します。予約パスの判定は大文字小文字を区別しません。symlink は 1 段ずつ読んで行き先で判定します。行き先がまだ存在しなくても行き先で判定します。判定と実際のファイル操作の間で差し替えられる余地は残るので、書き込む Tool は可能な環境では O_NOFOLLOW で開きます。
- Runtime 自身が 1 つ Tool を追加します。`ask_user`(effect: observe)です。名前は予約で、Tool provider が同じ名前を登録しようとすると `invalid_tool` で弾きます(MCP Server の `work_create`、`work_select`、`work_get`、`work_list`、`work_complete`、`work_fail` と、セッションの `work_run`、`work_show` も同じく予約です)。呼び出しは provider `runtime` として `tool.called` に記録し、入力は他の Tool と同じく schema で検証して、外れたら `tool.rejected`(schema_mismatch)にします。model がこれを呼ぶと、同じターンの他の Tool 呼び出しを先に実行してから質問を記録し、Work は `waiting_input` になります。同じターンの質問が複数でも待つのは 1 回で、再開時は古い順にすべて答えます。CLI では利用者に質問を表示して答えを受け取り、続行します。MCP では外部エージェント側が利用者に聞くので登録しません。

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

- 停止条件: 完了、`ask_user`、上限到達、model の refusal、回復できないエラーです。
- 再開: `in_progress` のまま止まった Work(Tool 実行中の中断など)を再び動かすときは、直前のターンで結果のない Tool 呼び出しに「途中で止まった」という失敗の結果を記録してから続けます。答えのない質問が残っていれば `waiting_input` として扱います。
- 上限は設定ファイルで持ちます。初期値は `max_model_calls: 30`、`max_tool_calls: 100`、`max_output_tokens: 16000` です。計測して直します。超えたら `work.failed`(reason: `limit_reached`)です。
- Tool の失敗は model に `isError` で返し、Work は続きます。Tool 呼び出しの回数には数えます。
- model の API エラーは SDK の再試行に任せ、それでもだめなら `model.failed` を残して `work.failed`(reason: `model_error`)にします。
- 判定の差し込み口: Tool を実行する直前に Runtime の `authorize(call)` を通します。この段階の判定は許可リストだけで、それ以外は常に許可です。将来の Authority engine はここに差し込みます。
- Tool 呼び出しの回数はイベントで数えます。`tool.called` の件数と、`tool.called` を伴わない `tool.rejected` の件数の和です。拒否された呼び出しも数えます。同じターン内で call id が重複したら `work.failed`(model_error)です。前のターンの id を使い回すサーバーはあるので、ターンをまたぐ重複は許します。中断の後始末と質問の突き合わせは直前の model のターン以降のイベントだけを確認します。
- 中断された呼び出しには `the run stopped before this tool call finished; call it again if it is still needed` という文言で `isError: true` の `tool.completed` を残します。
- 同じパスに複数回書き込んだときは、最後の書き込みだけが `outcome.artifacts` に残ります。
- Tool の結果が JSON で 50,000 文字を超えたときは、JSON 文字列に変換してから切り、text として返します。
- `ask_user` の入力が schema に合わないときは `tool.rejected`(schema_mismatch)を同じターンで返し、`waiting_input` にはなりません。
- lock: `work/<id>/lock` に pid と開始時刻を書きます。すでにあり、その pid が生きていればエラーです。死んでいれば引き継ぎます。
- 書き込みは `WorkStore.open(id)` が返す handle を通します。handle が lock を持ち、閉じるまで他の書き手は `lock_held` で止まります。読み取りに lock は要りません。

## 入口

### CLI(`packages/cli`、コマンド名 `openshain`)

| コマンド | 動き |
|---|---|
| `openshain` | 引数なしで端末があれば、社員エージェントと話す画面を開きます(spec は interactive-cli.md)。端末がなければ使い方を表示します |
| `openshain init` | カレントディレクトリに `openshain.yaml`、`.mcp.json`、`AGENTS.md`、`CLAUDE.md` のひな型を書きます。`openshain.yaml` があれば受け付けません。`.mcp.json` が既にあれば他のサーバーを残して openshain の項目だけ追加し、`AGENTS.md` と `CLAUDE.md` は無いときだけ書きます |
| `openshain run "<依頼>"` | Work を作って完了か停止まで進めます。Tool 呼び出しごとに 1 行表示します。最後に状態、結果、使用量の合計、次に動くのが誰か(利用者、model、なし)を表示します |
| `openshain work list` | Work の一覧(id、status、objective、created_at)です。読めない Work は別枠で示します |
| `openshain work show <id>` | 状態、イベントの要約、使用量の合計、次に動くのが誰かを表示します |
| `openshain work resume <id>` | 途中で止まった Work を続けます。`waiting_input` なら端末で質問に答えて続け、`in_progress` なら中断した呼び出しを閉じてから続け、`queued` なら最初から進めます。終わった Work は受け付けません。端末がなければ質問せず、待機のまま質問文を表示して終わります |
| `openshain tools list` | 登録された Tool の一覧(name、provider、effect、許可の有無)です |
| `openshain mcp` | MCP Server を stdio で起動します |

`--workspace <dir>` で起点を指定できます。`init` はそこに書き、他のコマンドはそこから上に向かって `openshain.yaml` を探します。省略時はカレントディレクトリです。

- `run` と `work resume` の進捗行は `tool.called`(名前と、path があればその値)、`tool.rejected`(拒否の理由)、`isError` の `tool.completed`(失敗)だけです。model の呼び出しと質問の記録は表示せず、最後の報告(結果、使用量の合計、次に動く人)にまとめます。
- exit code は 0 が完了、1 が完了しなかった Work か実行時のエラー、2 が引数の誤りです。

### MCP Server(`packages/mcp`)

外部エージェントが思考し、Runtime は Work の状態と Tool と記録を提供します。

MCP tool:

| name | 内容 |
|---|---|
| `work_create` | objective と type を受けて Work を作り、そのセッションの現在の Work にします。type に `session` は使えません |
| `work_select` | 既存の Work を現在の Work にします |
| `work_get`、`work_list` | 参照します |
| `work_complete` | summary と artifacts を受けます。artifacts は Runtime がファイルの存在と sha256 を検証し、Runtime の Tool で書いたファイルと合わせて `evidence.recorded` と `work.completed` を残します |
| `work_fail` | reason を受けて `work.failed` を残します |
| 登録された全 Tool | CLI と同じ名前、同じ schema です。呼び出しは現在の Work に記録されます |

現在の Work がない状態で Tool を呼ぶと、Work を作るよう促すエラーを返します。外部エージェントの model 使用量は Runtime から見えないので、この経路では `usage.recorded` は Tool 実行の分だけになります。

- `work_create` は Work を作って `in_progress` にします(理由は「an agent took the work over MCP」)。`work_select` は終わった Work を受け付けません。`work_get` は id を省くと現在の Work です
- `work_complete` の artifacts は任意です。Tool が書いたファイル(`after` 付きの `tool.completed`)にエージェントの申告を合わせ、パスごとに Runtime がハッシュを計算します。読めなければ `missing: true` で申告値を残し、Tool が書いていないパスには `claimed: true` を付けます。`refs` は `after` 付きの `tool.completed` の id です
- `work_fail` の reason はエージェントの自由な短い語です。CLI の見出し表にない語はそのまま表示されます
- Tool 呼び出しの call id は Runtime が `call_` で始まる id を振ります。結果の content は text にし、json は JSON 文字列にします。`isError` はそのままです
- MCP tool の説明とエラー文はエージェントが読むので英語です
- 呼び出しは接続ごとに 1 つずつ処理します。エージェントが並列に呼んでも lock を奪い合いません
- `work_*` の入力も他の Tool と同じく schema で検証し、外れたら schema_mismatch の文で返します。`work_complete` の artifacts のパスは path guard を通し、workspace の外なら何も記録せずに受け付けません
- 終わった Work への呼び出しは受け付けず、接続の現在の Work を空にします。未完了の現在の Work があるときの `work_create` は断り、先に work_complete か work_fail を求めます

### SDK(`@openshain/core`、`@openshain/agent`)

```ts
import { createRuntime } from "@openshain/core";
import { runWork } from "@openshain/agent";

const runtime = await createRuntime({
  workspaceRoot: ".",
  providers: {
    models: { /* provider の id → ModelProvider を作る関数 */ },
    tools: { standard: () => standardTools() },
  },
});
const work = await runtime.works.create({ objective: "…", principal: "alice", profession: "generic" });
await runWork(runtime, work.id, { onInput: async (question) => "…" });
```

`runtime.works`(create、get、list、open、events)、`runtime.tools`(list、hidden、call)、`runtime.model`、`runtime.config` を公開します。`hidden` は allow list が外した Tool の name、provider、effect を返します。`createToolRegistry` は model なしで Tool の登録だけを行います。イベントの読み取りは `works.events`、追記は `works.open` が返す handle を通します。CLI と MCP はこの SDK の上に載ります。

## 設定ファイル `openshain.yaml`

```yaml
version: 1
company:
  name: サンプル株式会社
  language: ja                   # ja | en。社員エージェントの名前の言語
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
    allow: [fs_list, fs_search, fs_read, csv_read, csv_aggregate, markdown_read, fs_write, csv_write]  # 省略時は全部
  - module: ./tools/my-tool.ts   # ToolProvider を default export するモジュール
limits:
  max_model_calls: 30
  max_tool_calls: 100
  max_output_tokens: 16000
# debug:
#   persist_raw: true
```

- 設定の検証は起動時に行い、不備は行番号つきで報告します。
- `model` を書き換えるだけで provider が切り替わります。コードは変えません。
- `allow` に書かれていない Tool は model に定義を渡しません。呼ばれたら `tool.rejected`(code: `not_allowed`)です。
- `company.language` は `ja` か `en` で、省略時は `ja` です。`openshain init` が OS の locale から初期値を埋めます。値の出どころは設定で、OS ではありません。
- `principal.id`、`profession.id`、`model.provider` は `^[a-z][a-z0-9_-]*$` です。`profession.instructions` は 100,000 文字までです。`base_url` に資格情報(`user:pass@`)は書けません。`base_url` は https か、この機械を指す http(localhost、127.0.0.0/8、::1)だけです。`tools` を省略すると `[{ provider: standard }]` になります。
- `api_key_env`、`base_url`、`options`、`debug` は環境の節です。それ以外は会社の manifest です(「openshain.yaml の責務」を参照してください)。

## 構成

| パス | この spec で置くもの |
|---|---|
| `packages/core/src/model/` | ModelProvider のインターフェースと message 型 |
| `packages/core/src/tool/` | ToolProvider のインターフェース、JSON Schema 検証、名前の登録と許可リスト |
| `packages/core/src/work/` | Work、Event、投影、`work/<id>/` の読み書きと lock |
| `packages/core/src/config/` | `openshain.yaml` の読み込みと検証 |
| `packages/core/src/errors.ts` | `OpenshainError` |
| `packages/core/src/runtime.ts` | `createRuntime` |
| `packages/agent/src/` | loop、`ask_user`、Anthropic と OpenAI 互換の ModelProvider |
| `packages/tools/src/` | 標準 Tool |
| `packages/mcp/src/` | MCP Server |
| `packages/cli/src/` | コマンド |
| `examples/tools/echo/` | 第三者 Tool の例です。インターフェースと設定だけで組み込めることの証明に使います |

## コードの書き方

インターフェースは TypeScript の `interface`、データは `type` と zod の schema で書きます。zod の schema から JSON Schema を生成して `spec/` に置きます。

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

状態遷移、上限の判定、パスの検査は普通の関数で書き、model の出力に頼りません。

## テスト

- `bun test` です。ネットワークなしで全部通ります。
- loop は台本どおりに応答する `FakeModelProvider` で試します。
- Anthropic と OpenAI 互換の provider は、記録した HTTP 応答を fetch の差し替えで返して試します。実 API への smoke test は `OPENSHAIN_LIVE_TESTS=1` のときだけ動きます。
- MCP Server は MCP SDK の in-memory transport で、client から `work_create` → Tool 呼び出し → `work_complete` を通します。
- 第三者 Tool は、一時 workspace の `openshain.yaml` に `examples/tools/echo` を書いて読み込みます。
- テストで確認すること: workspace 外、予約パス(先頭が `.` の項目を含む)、行き先が外を向く symlink は拒否されること、schema 不一致と許可リスト外は実行前に止まること、上限で止まること、同じ Work の使用量が合計できること、同値のイベント列から同じバイト列の投影が作られること、2 つ目の書き手は lock と `concurrent_write` の両方で止まること、書いたイベントは必ず読めること、Tool に対応しない model は起動時に止まることです。

## 完了の条件

1. 同じ依頼を、`openshain.yaml` の `model` を書き換えるだけで Anthropic と OpenAI 互換 API の両方で完走します。コードは変えません。
2. Claude Code か Codex を MCP client として接続し、`work_create` → Tool 呼び出し → `work_complete` で同じ依頼を完走します。Runtime 側のコードは変えません。
3. `examples/tools/echo` の Tool を設定ファイルに書くだけで、`openshain tools list`、`openshain run`、MCP の 3 つから呼べます。
4. すべての model 呼び出しが `usage.recorded` として残り、`openshain work show <id>` が Work ごとの合計を表示します。
5. 1 から 4 を `bun test` で再現できます。
6. workspace 外と予約パスへの読み書きは拒否され、`tool.rejected` として残ります。
7. schema に合わない Tool 入力と許可リスト外の Tool は実行前に止まり、`tool.rejected` として残ります。
8. 上限に達した Work は `failed`(reason: `limit_reached`)で止まり、途中までのイベントが残ります。
9. 完了した Work の `outcome.artifacts` は Runtime が計算したハッシュを持ち、model の申告と食い違っても Runtime の値が残ります。読めなかった成果物は `missing` で区別し、Runtime が検証した値としては扱いません。
10. 同じ `events.jsonl` から投影を 2 回作ると byte 単位で一致します。

### 条件とテストの対応

すべて `bun test` で実行され、CI が push ごとに実行します。live のテストは `OPENSHAIN_LIVE_TESTS=1` のときだけ動きます。

| 条件 | テスト |
|---|---|
| 1 | `packages/agent/src/swap.test.ts` "completes with the same events and the same artifact when only the config's model changes"、"hands each provider the tool results in its own wire format"。本物の API は `live.test.ts` |
| 2 | `packages/mcp/src/server.test.ts` "drives a work from creation to completion, recording the calls and the evidence"。stdio 経由は `packages/cli/src/commands/mcp.test.ts` "is offered and callable over MCP through openshain mcp on stdio"。Claude Code との実接続は plan の Checkpoint 4 |
| 3 | `packages/cli/src/commands/mcp.test.ts` の "appears in tools list"、"is called by the model in run"、"is offered and callable over MCP …"。読み込み側は `packages/core/src/runtime.test.ts` "loads a third-party tool provider from a module path in the config" |
| 4 | `packages/agent/src/loop.test.ts` "passes the remaining budget to the model and records model usage"、`packages/cli/src/commands/work.test.ts` "shows the state, the outcome, the usage totals and who acts next"、`packages/cli/src/usage.test.ts` |
| 5 | 上の各テストそのもの。`.github/workflows/ci.yml` |
| 6 | `packages/core/src/tool/paths.test.ts`(symlink、予約名、ループ)、`packages/tools/src/standard.test.ts` "every tool refuses %s with the path guard's own error"、`packages/core/src/runtime.test.ts` "records a path rejection thrown by the tool as tool.rejected"、`packages/mcp/src/server.test.ts` "refuses artifacts outside the workspace and records nothing" |
| 7 | `packages/core/src/runtime.test.ts` "rejects input that does not match the schema before running anything"、"rejects a tool the allow list hides as not_allowed, and one nobody has as unknown_tool"、`packages/core/src/tool/registry.test.ts` "an allow list hides the other tools of that provider"、`packages/agent/src/loop.test.ts` "keeps going when a tool call is rejected, showing the model the reason" |
| 8 | `packages/agent/src/loop.test.ts` "stops with limit_reached when the model calls run out"、"stops with limit_reached when the tool calls run out"、"records a truncated answer and fails with limit_reached" |
| 9 | `packages/agent/src/loop.test.ts` "reads a CSV, writes a summary and completes with artifacts hashed by the runtime"、"marks an artifact the tool reported but never wrote as missing"、"evidence refs point at the events that wrote the artifacts"、`packages/mcp/src/server.test.ts` "keeps the runtime's hash when the agent misreports an artifact, and marks one it never wrote"、"marks a file the agent names but no tool of the work wrote as claimed, with the runtime's hash" |
| 10 | `packages/core/src/work/projection.test.ts` "builds byte-identical output from the same events"、"builds the same bytes when only the key order inside tool input differs"、`packages/core/src/work/events.test.ts` "sorts object keys inside data so equal events are equal bytes" |

## 未決

- MCP の elicitation を `ask_user` の代わりに使うか。この段階では使いません。
- 設定ファイルの `allow` を、後の Authority policy とどう統合するか。ChangeSet の spec で決めます。
