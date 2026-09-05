# Changelog

形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/)、版は [Semantic Versioning](https://semver.org/lang/ja/) に従う。

## [0.1.0] - 2026-09-05

最初の公開版。Model、Tool、入口を交換できるエージェントハーネスの土台(spec の Open Runtime)。

### Added

- Runtime の契約(ModelProvider、ToolProvider)、Work のイベントログ、投影、path guard(`@openshain/core`)
- Anthropic と OpenAI 互換 API の ModelProvider。API キーは利用者のもの(`@openshain/agent`)
- 標準 Tool: fs_list、fs_search、fs_read、fs_write、csv_read、csv_aggregate、csv_write、markdown_read(`@openshain/tools`)
- MCP server。Claude Code や Codex から同じ Runtime を使う(`@openshain/mcp`)
- `openshain` CLI: init、run、work list、work show、work resume、tools list、mcp
- `openshain` の画面。担当と話し、作業は Work にして進める。会話は `type: session` の Work として残る
- openshain.yaml、events.jsonl、work.json の JSON Schema(`spec/schemas/`)
- 各 package の設計ノート(`docs/design/`)

[0.1.0]: https://github.com/openshain/openshain/releases/tag/v0.1.0
