# openshain.yaml

会社のフォルダ(Company Workspace)の設定。`openshain init` がひな型を書く。項目名は snake_case。機械で読む形は [spec/schemas/config.v1.json](../spec/schemas/config.v1.json)。

## 置き場所と探し方

`openshain` のコマンドはカレントディレクトリから上に向かって `openshain.yaml` を探し、見つかったディレクトリを workspace の root にする。`--workspace <dir>` で起点を変えられる。Tool が触れるのは root の中だけで、`openshain.yaml`、`work/`、先頭が `.` の項目には触れない。

## 項目

| 項目 | 必須 | 意味 |
|---|---|---|
| `version` | 必須 | `1` |
| `company.name` | 必須 | 会社名。model に伝わる。1 から 200 文字 |
| `principal.id` | 必須 | 依頼する人の id。小文字の英字で始まり、英数字と `_` と `-`。記録に残る |
| `principal.name` | 必須 | 表示名。1 から 200 文字 |
| `profession.id` | 必須 | 職種の id。今は `generic` だけ。形式は `principal.id` と同じ |
| `profession.instructions` | 必須 | model への指示。system prompt の先頭に入る。100,000 文字まで |
| `model.provider` | 必須 | `anthropic` か `openai-compatible`。SDK から使うときは登録した provider の id |
| `model.model` | 必須 | model の名前。provider にそのまま渡す |
| `model.api_key_env` | 必須 | API キーを入れる環境変数の名前。大文字の英字で始まり、英数字と `_`。値はここに書かない |
| `model.base_url` | 任意 | API の root。openai-compatible では `/v1` まで含める(例 `http://localhost:11434/v1`)。省略時は各 provider の既定。`user:pass@` は書けない。https か、localhost のようにこの機械を指す http だけ。遠隔のホストに http を書くとキーが平文で流れるので拒む |
| `model.options` | 任意 | provider にそのまま渡す指定。Anthropic なら `effort` や `thinking`、OpenAI 互換なら `reasoning_effort` や `temperature`。model、messages、tools、出力の上限は上書きできない |
| `tools` | 任意 | Tool provider の並び。省略時は `[{ provider: standard }]`。各項目は `provider`(組み込みの id)か `module`(ToolProvider を default export するファイルのパス)のどちらか 1 つ。`allow` を書くと、その名前の Tool だけを model に渡す。`module` はそのファイルを読み込んで実行するので、信用できないフォルダでは動かさない |
| `limits.max_model_calls` | 任意 | 1 つの Work での model 呼び出しの上限。既定 30。超えると Work は失敗(上限到達)で止まる |
| `limits.max_tool_calls` | 任意 | Tool 呼び出しの上限。拒否された呼び出しも数える。既定 100 |
| `limits.max_output_tokens` | 任意 | model の 1 回の出力の上限。既定 16000 |
| `debug.persist_raw` | 任意 | provider の生の応答を記録に残す。既定 false |

設定の不備は起動時に行番号つきで報告する。`model` を書き換えるだけで provider が切り替わる。

## 標準 Tool

`tools` に `provider: standard` があると、fs_list、fs_search、fs_read、fs_write、csv_read、csv_aggregate、csv_write、markdown_read の 8 つが使える。`openshain tools list` が、登録された Tool と許可の有無を出す。自分の Tool を足すには、ToolProvider を default export するファイルを `module` で指すか、別の provider を作る。例は `examples/tools/echo`。

## 記録

Work ごとに `work/<id>/events.jsonl`(正本)と `work.json`(状態の投影)が残る。`openshain` の画面での会話も `type: session` の Work として残り、そこから頼んだ Work は `parent` で会話を指す。形式は [spec/schemas/events.v1.json](../spec/schemas/events.v1.json) と [spec/schemas/work.v1.json](../spec/schemas/work.v1.json)。`openshain work list` と `openshain work show <id>` で読める。

## Claude Code から使うためのファイル

`openshain init` は設定のほかに 3 つのファイルを書く。既にあるものは触らない。

| ファイル | 内容 |
|---|---|
| `.mcp.json` | Claude Code のプロジェクト設定。`openshain mcp` を stdio の MCP server として登録する。`openshain` が PATH にあることが前提。Claude Code をアプリから起動して PATH が通らないときは、command に絶対パスを書く |
| `AGENTS.md` | MCP 経由で入る外部 Agent への指示。会社のファイルは openshain の Tool で扱い、`work_create` から始めて `work_complete` で終える。`openshain run` の Runtime には当てはまらないと冒頭に書いてある |
| `CLAUDE.md` | `@AGENTS.md` の 1 行。Claude Code に同じ指示を読ませる |

Claude Code はフォルダを信頼するまで `.mcp.json` を読まない。起動時の確認で信頼を選んでから `/mcp` を見る。
