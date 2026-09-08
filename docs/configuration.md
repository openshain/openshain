# openshain.yaml

会社のフォルダ(Company Workspace)の設定です。`openshain init` がひな型を書きます。項目名は snake_case です。機械で読む形は [spec/schemas/config.v1.json](../spec/schemas/config.v1.json) にあります。

## 置き場所と探し方

`openshain` のコマンドはカレントディレクトリから上に向かって `openshain.yaml` を探し、見つかったディレクトリを workspace の root にします。`--workspace <dir>` で起点を指定します。Tool がアクセスできるのは root の中だけで、`openshain.yaml`、`work/`、先頭が `.` の項目にはアクセスできません。

## 項目

| 項目 | 必須 | 意味 |
|---|---|---|
| `version` | 必須 | `1` |
| `company.name` | 必須 | 会社名です。model に伝わります。1 から 200 文字 |
| `company.language` | 任意 | 会社の言語です。`ja` か `en`。社員エージェントの名前をこの言語の一覧から選びます。省略時は `ja`。`openshain init` が OS の locale を見て埋めます |
| `principal.id` | 必須 | 依頼する人の id です。小文字の英字で始まり、英数字と `_` と `-` で構成します。記録に残ります |
| `principal.name` | 必須 | 表示名です。1 から 200 文字 |
| `profession.id` | 必須 | 職種の id です。今は `generic` だけです。形式は `principal.id` と同じ規則です |
| `profession.instructions` | 必須 | model への指示です。system prompt の先頭に入ります。100,000 文字まで |
| `model` | 任意 | 対話型 CLI(`openshain`)が使うモデルの節です。Claude Code や Codex から MCP で使うだけなら書きません。無いときに `openshain` を実行すると、モデルが要る旨で止まります |
| `model.provider` | model があれば必須 | `anthropic` か `openai-compatible` です。SDK から使うときは登録した provider の id です |
| `model.model` | model があれば必須 | model の名前です。provider にそのまま渡します |
| `model.api_key_env` | model があれば必須 | API キーを入れる環境変数の名前です。大文字の英字で始まり、英数字と `_` で構成します。値はここに書きません |
| `model.base_url` | 任意 | API の root です。openai-compatible では `/v1` まで含めます(例 `http://localhost:11434/v1`)。省略時は各 provider の既定です。`user:pass@` は受け付けません。https か、localhost のようにこの機械を指す http だけを受け付けます。遠隔のホストに http を書くとキーが平文で流れるので拒みます |
| `model.options` | 任意 | provider にそのまま渡す指定です。Anthropic なら `effort` や `thinking`、OpenAI 互換なら `reasoning_effort` や `temperature` です。model、messages、tools、出力の上限は上書きできません |
| `tools` | 任意 | Tool provider の並びです。省略時は `[{ provider: standard }]` です。各項目は `provider`(組み込みの id)か `module`(ToolProvider を default export するファイルのパス)のどちらか 1 つです。`allow` を書くと、その名前の Tool だけを model に渡します。`module` はそのファイルを読み込んで実行するので、信用できないフォルダでは動かさないでください |
| `limits.max_model_calls` | 任意 | 1 つの Work での model 呼び出しの上限です。既定 30。超えると Work は失敗(上限到達)で止まります |
| `limits.max_tool_calls` | 任意 | Tool 呼び出しの上限です。拒否された呼び出しも数えます。既定 100 |
| `limits.max_output_tokens` | 任意 | model の 1 回の出力の上限です。既定 16000 |
| `debug.persist_raw` | 任意 | provider の生の応答を記録に残します。既定 false |

設定の不備は起動時に行番号つきで報告します。`model` を書き換えるだけで provider が切り替わります。

## 標準 Tool

`tools` に `provider: standard` があると、fs_list、fs_search、fs_read、fs_write、csv_read、csv_aggregate、csv_write、markdown_read の 8 つが有効になります。`openshain tools list` が、登録された Tool と許可の有無を表示します。自分の Tool を追加するには、ToolProvider を default export するファイルを `module` で指すか、別の provider を作ります。例は `examples/tools/echo` にあります。

## 権限と承認(`authority/`)

会社フォルダに `authority/` を置くと、Tool の呼び出しごとに判定が入ります。置かなければ、これまでどおりすべて許可です。`principals/` と `authority/` は Runtime の予約パスで、Tool からは読み書きできません。機械で読む形は [spec/schemas/authority-policy.v1.json](../spec/schemas/authority-policy.v1.json) と [authority-delegations.v1.json](../spec/schemas/authority-delegations.v1.json) にあります。

```
authority/
├── policy.yaml          どの呼び出しに何が要るか
├── delegations.yaml     誰の代理で、どの職種として働いてよいか
└── decisions/           資格者の判断。Runtime が書きます
```

### `delegations.yaml`

```yaml
version: 1
delegations:
  - principal: alice        # 誰の代理で
    profession: generic     # どの職種として
    valid_from: 2026-09-01  # 任意
    valid_until: null       # 任意。null は期限なし
```

`authority/` があるのに委任が無い組み合わせでは、その Work の呼び出しはすべて拒否されます。書き忘れたときに開かず閉じるためです。

### `policy.yaml`

```yaml
version: 1
default: allow              # どの規則にも一致しないときの判定
rules:
  - id: receipts-are-read-only
    match: { effect: mutate, path: "receipt/**" }
    decision: deny
    reason: 領収書は変更しません
  - id: ledger-needs-approval
    match: { tool: [fs_write, csv_write], path: "ledger/**" }
    decision: approval_required
    approvers: [alice]
  - id: tax-needs-review
    match: { action: tax-treatment }
    decision: review_required
    reviewer: { role: tax-accountant }
  - id: tax-decided
    match: { action: tax-treatment }
    decision: decision_backed
    decision_id: dec_01a0…
```

| 項目 | 必須 | 内容 |
|---|---|---|
| `default` | 任意 | どの規則にも一致しないときの判定です。省略時は `allow` です |
| `rules[].id` | 必須 | 規則の名前です。小文字で始まり、英数字と `_` と `-` で構成します。記録と画面に出ます |
| `rules[].match` | 必須 | 一致の条件です。書いた項目はすべて満たす必要があります |
| `rules[].match.tool` | 任意 | Tool の名前、または名前の並びです |
| `rules[].match.effect` | 任意 | `observe` か `mutate` です |
| `rules[].match.path` | 任意 | 会社フォルダからの相対パスの形です。`*` は 1 つの区切りの中、`**` は区切りをまたぎます。`path` を持たない呼び出しには一致しません |
| `rules[].match.principal` | 任意 | 代理する人の id です |
| `rules[].match.work_type` | 任意 | Work の type です |
| `rules[].match.action` | 任意 | 呼び出しに付いた行為の名前です。いまは Tool の名前と同じ扱いです |
| `rules[].decision` | 必須 | `allow`、`deny`、`approval_required`、`review_required`、`decision_backed` のどれかです |
| `rules[].reason` | 任意 | `deny` の理由、または Reviewer への問いです。画面と記録に出ます |
| `rules[].approvers` | 任意 | `approval_required` で承認できる人の id です。省略時は `openshain.yaml` の principal です |
| `rules[].reviewer` | 任意 | `review_required` で判断できる役です(`{ role: tax-accountant }`)。判断はこの役の名で記録しなければ受け付けません |
| `rules[].decision_id` | `decision_backed` で必須 | 根拠にする判断の id です |

規則は上から順に見て、最初に一致したものが決めます。判定は普通のコードが行い、model の出力では変わりません。

### 判定ごとの動き

| 判定 | 起きること |
|---|---|
| `allow` | そのまま実行します |
| `deny` | 実行せず、`tool.rejected`(`denied`)として記録します |
| `approval_required` | Work が `waiting_approval` で止まります。画面が選択の形になり、書き込みなら差分が出ます。`/approve <id>` と `/reject <id>` でも決められます |
| `review_required` | Review Package を `work/<id>/review/` に置いて止まります。`/review <id> approve` で判断を記録すると、`authority/decisions/` に書かれて実行します |
| `decision_backed` | `decision_id` の判断が有効日の中にあり、その呼び出しを覆うときだけ実行し、`decision.applied` として記録します。満たさなければ `review_required` として扱います |

### `decisions/`

Runtime が書きます。手で消さないでください。`applies_to` に `action` と `path` を書くと、その判断が効く範囲を狭められます。Reviewer の資格は会社の申告として記録するもので、openshain は検証しません。

## 記録

Work ごとに `work/<id>/events.jsonl`(原本)と `work.json`(状態の投影)が残ります。`openshain` の画面での会話も `type: session` の Work として残り、そこから依頼した Work は `parent` で会話を指します。形式は [spec/schemas/events.v1.json](../spec/schemas/events.v1.json) と [spec/schemas/work.v1.json](../spec/schemas/work.v1.json) です。`openshain work list` と `openshain work show <id>` で参照します。

## Claude Code から使うためのファイル

`openshain init` は設定のほかに 3 つのファイルを書きます。既にあるものは上書きしません。`.mcp.json` が既にあれば、他のサーバーの項目を残したまま openshain の項目だけを追加します(JSON として読めないときは変更せず、その旨を表示します)。`AGENTS.md` と `CLAUDE.md` は既にあれば変更しません。

| ファイル | 内容 |
|---|---|
| `.mcp.json` | Claude Code のプロジェクト設定です。`openshain mcp` を stdio の MCP server として登録します。`openshain` が PATH にあることが前提です。Claude Code をアプリから起動して PATH が通らないときは、command に絶対パスを書いてください |
| `AGENTS.md` | MCP 経由で入る外部エージェントへの指示です。会社のファイルは openshain の Tool で扱い、`work_create` から始めて `work_complete` で終えます。|
| `CLAUDE.md` | `@AGENTS.md` の 1 行です。Claude Code に同じ指示を読ませます |

Claude Code はフォルダを信頼するまで `.mcp.json` を読みません。起動時の確認で信頼を選んでから `/mcp` を見てください。
