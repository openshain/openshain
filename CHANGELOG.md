# Changelog

形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/)、版は [Semantic Versioning](https://semver.org/lang/ja/) に従います。

## [Unreleased]

### Added

- `npm install -g openshain` と `npx openshain`。package は Node.js 22 以上で動く JavaScript(`dist/`)を持ち、Bun では従来どおりソースのまま動きます

### Changed

- CLI の `bin` は `dist/bin.js`、各 package の `exports` は Bun ではソース、Node.js では `dist/` を指します
- ID の生成が Bun 固有の API を使わなくなりました。形式(UUID v7)は変わりません

### Fixed

- MCP サーバーが名乗る版が 0.0.0 でした。package の版を名乗ります
- 0.1.1 の `openshain` は部品の package を 0.1.0 で参照していました。publish のときに lockfile の版を使うためで、検査を足しました

## [0.1.1] - 2026-09-06

### Changed

- package の `homepage` と README の案内が公式サイト `https://openshain.jp` を指します
- アイコンのファイル名が変わりました。サイト用は `assets/web_icon-*.png` と `assets/web_apple-touch-icon.png`、アプリ用は `assets/app_icon-*.png` と `assets/app_apple-touch-icon.png` です。`assets/icon-*.png` と `assets/apple-touch-icon.png` はありません(サイトが読む path の変更)

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
- 公式サイトが読む path の一覧と変更の規則(`docs/website-integration.md`)。Release workflow は stable の tag(`vX.Y.Z`)のときだけサイトの repo へ `repository_dispatch`(`openshain-release`)を送り、印付きの tag は prerelease にします

[Unreleased]: https://github.com/openshain/openshain/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/openshain/openshain/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/openshain/openshain/releases/tag/v0.1.0
