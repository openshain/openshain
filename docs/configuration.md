# openshain.yaml

会社のフォルダ(Company Workspace)の設定です。`openshain init` がひな型を書きます。項目名は snake_case です。機械で読む形は [spec/schemas/config.v1.json](../spec/schemas/config.v1.json) にあります。

## 置き場所と探し方

`openshain` のコマンドはカレントディレクトリから上に向かって `openshain.yaml` を探し、見つかったディレクトリを workspace の root にします。`--workspace <dir>` で起点を変えられます。Tool が触れるのは root の中だけで、`openshain.yaml`、`work/`、先頭が `.` の項目には触れません。

## 項目

| 項目 | 必須 | 意味 |
|---|---|---|
| `version` | 必須 | `1` |
| `company.name` | 必須 | 会社名です。model に伝わります。1 から 200 文字 |
| `principal.id` | 必須 | 依頼する人の id です。小文字の英字で始まり、英数字と `_` と `-` が使えます。記録に残ります |
| `principal.name` | 必須 | 表示名です。1 から 200 文字 |
| `profession.id` | 必須 | 職種の id です。今は `generic` だけです。形式は `principal.id` と同じです |
| `profession.instructions` | 必須 | model への指示です。system prompt の先頭に入ります。100,000 文字まで |
| `model.provider` | 必須 | `anthropic` か `openai-compatible` です。SDK から使うときは登録した provider の id です |
| `model.model` | 必須 | model の名前です。provider にそのまま渡します |
| `model.api_key_env` | 必須 | API キーを入れる環境変数の名前です。大文字の英字で始まり、英数字と `_` が使えます。値はここに書きません |
| `model.base_url` | 任意 | API の root です。openai-compatible では `/v1` まで含めます(例 `http://localhost:11434/v1`)。省略時は各 provider の既定です。`user:pass@` は書けません。https か、localhost のようにこの機械を指す http だけを受け付けます。遠隔のホストに http を書くとキーが平文で流れるので拒みます |
| `model.options` | 任意 | provider にそのまま渡す指定です。Anthropic なら `effort` や `thinking`、OpenAI 互換なら `reasoning_effort` や `temperature` です。model、messages、tools、出力の上限は上書きできません |
| `tools` | 任意 | Tool provider の並びです。省略時は `[{ provider: standard }]` です。各項目は `provider`(組み込みの id)か `module`(ToolProvider を default export するファイルのパス)のどちらか 1 つです。`allow` を書くと、その名前の Tool だけを model に渡します。`module` はそのファイルを読み込んで実行するので、信用できないフォルダでは動かさないでください |
| `limits.max_model_calls` | 任意 | 1 つの Work での model 呼び出しの上限です。既定 30。超えると Work は失敗(上限到達)で止まります |
| `limits.max_tool_calls` | 任意 | Tool 呼び出しの上限です。拒否された呼び出しも数えます。既定 100 |
| `limits.max_output_tokens` | 任意 | model の 1 回の出力の上限です。既定 16000 |
| `debug.persist_raw` | 任意 | provider の生の応答を記録に残します。既定 false |

設定の不備は起動時に行番号つきで報告します。`model` を書き換えるだけで provider が切り替わります。

## 標準 Tool

`tools` に `provider: standard` があると、fs_list、fs_search、fs_read、fs_write、csv_read、csv_aggregate、csv_write、markdown_read の 8 つが使えます。`openshain tools list` が、登録された Tool と許可の有無を出します。自分の Tool を足すには、ToolProvider を default export するファイルを `module` で指すか、別の provider を作ります。例は `examples/tools/echo` にあります。

## 記録

Work ごとに `work/<id>/events.jsonl`(原本)と `work.json`(状態の投影)が残ります。`openshain` の画面での会話も `type: session` の Work として残り、そこから頼んだ Work は `parent` で会話を指します。形式は [spec/schemas/events.v1.json](../spec/schemas/events.v1.json) と [spec/schemas/work.v1.json](../spec/schemas/work.v1.json) です。`openshain work list` と `openshain work show <id>` で読めます。

## Claude Code から使うためのファイル

`openshain init` は設定のほかに 3 つのファイルを書きます。既にあるものは触りません。

| ファイル | 内容 |
|---|---|
| `.mcp.json` | Claude Code のプロジェクト設定です。`openshain mcp` を stdio の MCP server として登録します。`openshain` が PATH にあることが前提です。Claude Code をアプリから起動して PATH が通らないときは、command に絶対パスを書いてください |
| `AGENTS.md` | MCP 経由で入る外部エージェントへの指示です。会社のファイルは openshain の Tool で扱い、`work_create` から始めて `work_complete` で終えます。`openshain run` の Runtime には当てはまらないと冒頭に書いてあります |
| `CLAUDE.md` | `@AGENTS.md` の 1 行です。Claude Code に同じ指示を読ませます |

Claude Code はフォルダを信頼するまで `.mcp.json` を読みません。起動時の確認で信頼を選んでから `/mcp` を見てください。
