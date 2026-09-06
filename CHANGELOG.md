# Changelog

形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/)、版は [Semantic Versioning](https://semver.org/lang/ja/) に従います。

## [0.1.0] - 2026-09-06

最初の公開版です。Model、Tool、入口を交換できるエージェントハーネスの中核(spec の Open Runtime)です。

### Added

- Runtime のインターフェース(ModelProvider、ToolProvider)、Work のイベントログ、投影、path guard(`@openshain/core`)
- Anthropic と OpenAI 互換 API の ModelProvider。API キーは利用者のものを使います(`@openshain/agent`)
- 標準 Tool: fs_list、fs_search、fs_read、fs_write、csv_read、csv_aggregate(グループ別と全行の総計)、csv_write、markdown_read(`@openshain/tools`)
- MCP server。Claude Code や Codex から同じ Runtime を使えます(`@openshain/mcp`)
- `openshain` CLI: init、run、work list、work show、work resume、tools list、mcp
- `openshain` の画面。社員エージェントと話し、作業は Work にして進めます。全画面で、会話はマウスホイールと PageUp で遡れ、入力欄はカーソルで編集でき、上下の矢印で前の入力を呼び戻せます。会話は `type: session` の Work として残ります
- 社員エージェントはセッションごとに名前を持ちます。名前は `company.language`(`ja` か `en`)の一覧から選び、Work の記録に残ります
- openshain.yaml、events.jsonl、work.json の JSON Schema(`spec/schemas/`)
- 各 package の設計ノート(`docs/design/`)

[0.1.0]: https://github.com/openshain/openshain/releases/tag/v0.1.0
