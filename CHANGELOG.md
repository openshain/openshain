# Changelog

形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/)、版は [Semantic Versioning](https://semver.org/lang/ja/) に従います。

## [Unreleased]

### Added

- 資格者の Review。規則が `review_required` と判定した呼び出しは、Review Package(呼び出し、そこまでの Tool 呼び出し、社員エージェントの提案、問い)を記録して止まります。`review_decide`(画面では `/review <id> approve`)で資格者の判断を記録すると、`authority/decisions/` に判断が書かれ、Runtime が呼び出しを実行します。`decision_backed` の規則はその判断を引き、有効日と適用範囲を確かめてから実行します。イベントは `review.requested`、`review.decided`、`decision.applied` です。Review Package の写しは `work/<id>/review/` に置きます。資格は会社の申告として記録し、openshain は検証しません。承認と判断の Tool は対話型 CLI のモデルには渡しません。規則が求める役(`reviewer.role`)と違う役の名では判断を記録できません
- 承認の流れ。規則が `approval_required` と判定した Tool 呼び出しは `waiting_approval` で止まります。対話型 CLI では入力欄が承認の選択画面に変わり、何が変わるか(書き込みなら差分)を確認して、実行する、この会話では常に承認する、実行しない、から選びます。選ぶとターンはそのまま続きます。MCP では `approval_list` と `approval_decide`、画面では `/approvals` と `/approve <id>` と `/reject <id>` も使えます。承認すると Runtime がその場で実行します。イベントは `approval.requested` と `approval.decided`、拒否の code は `rejected_by_person` です
- `authority/policy.yaml` と `authority/delegations.yaml`。Tool 呼び出しを規則の表で判定し(最初の一致、`*` と `**` の glob)、委任の無い代理と規則で拒否した呼び出しを `tool.rejected`(`denied`)として記録します。Review が要る規則は、その仕組みが入るまで拒否として動きます。`principals/` と `authority/` は予約パスです。JSON Schema は `spec/schemas/authority-*.v1.json` にあります
- Runtime の Tool `context`。現在時刻、タイムゾーン、今日の業務日、会社フォルダ、依頼する人、現在の Work を返します。対話型 CLI は会話の開始時に 1 回呼んで記録し、社員エージェントは日付が要るときに呼び直します

### Changed

- CodeQL(`security-and-quality`)を CI に追加しました。変更のたびと毎週動きます
- 社員エージェントの返答をマークダウンとして描きます。見出し、太字、斜体、打ち消し、インラインコード、箇条書きと番号(入れ子を含む)、コードブロック、引用、罫線、リンクを書式で表示します。表は書かれたとおりの行で表示し、描き分けない記法も記号ごと表示します
- 単体バイナリの Release に `THIRD-PARTY-NOTICES.txt` を添付します。同梱するソフトウェアの著作権表示とライセンス文をまとめたもので、ビルドのたびに依存関係から生成します。npm のパッケージには LICENSE と NOTICE を同梱します
- 承認の選択肢に「いいえ。理由を伝えて実行しない」を追加しました。書いた理由は決定の記録に残り、社員エージェントにも渡ります
- 社員エージェントが動いている間に打った行は、断らずに順番待ちにします。ターンが終わると古い順に送ります
- README の先頭にキャッチコピー「Small team. Professional operations.」を置きました

## [0.3.1] - 2026-09-07

### Added

- 専門職の責務境界の spec(`spec/professional-boundary.md`)と設計原則の 1 行。処理の 5 区分、Authority の判定の種類、Expert Review の流れ、core と Profession Pack の境界を決めます。実装はまだです
- npm への publish を Release workflow に載せました。trusted publishing(OIDC)で、token を置かず、`npm` environment の承認で走ります

### Fixed

- `spec/schemas/config.v1.json` が `model` を必須のままにしていました(0.3.0 の tag に含まれます)

### Note

- 0.3.0 は npm に publish していません。0.3.1 が npm に出る最初の版です

## [0.3.0] - 2026-09-07

### Changed

- ランタイム(core、tools、mcp)はモデルを呼びません。対話型 CLI は自分のモデルを持ち、Claude Code と同じ MCP の Tool でランタイムを使います。`@openshain/agent` はランタイムの内部を import しません
- `openshain.yaml` の `model` は任意です。Claude Code や Codex から使うだけなら、モデルの設定も API キーも要りません
- 社員エージェントは `work_create` で Work を作り、その中で Tool を呼び、`work_complete` で閉じます。作業の Work を閉じたら、会話には summary だけが残ります
- `/work resume <id>` は止まった Work を候補にします。次の依頼がその Work に沿えば社員エージェントが続け、沿わなければ続けません
- 1 ターンの上限はモデル呼び出し 25 回、Tool 呼び出し 40 回です

### Added

- MCP の Tool: `work_create` の `type: session`、`parent`、`agent_name`。`work_get` の `history`。`ask_user`(質問を記録して `waiting_input` にし、`pending` を返します)と `work_answer`。`work_record`(client の発言、モデルの呼び出し、使用量を記録します)
- イベント `prompt.expanded`。`tool.rejected` の code `limit_reached`(`max_tool_calls` をランタイムが数えます)
- MCP の Tool に read-only の annotation

### Removed

- `openshain run` と `openshain work resume`。端末なしで Work を進める手段は後の版で client の 1 つとして戻します
- 社員エージェントの `work_run`、`@openshain/agent` の `runWork`

## [0.2.0] - 2026-09-07

### Added

- `npm install -g openshain` と `npx openshain`。package は Node.js 22 以上で動く JavaScript(`dist/`)を持ち、Bun では従来どおりソースのまま動きます

### Changed

- CLI の `bin` は `dist/bin.js`、各 package の `exports` は Bun ではソース、Node.js では `dist/` を指します
- ID の生成が Bun 固有の API を使わなくなりました。形式(UUID v7)は変わりません

### Fixed

- MCP サーバーが名乗る版が 0.0.0 でした。package の版を名乗ります
- 0.1.1 の `openshain` は部品の package を 0.1.0 で参照していました。publish のときに lockfile の版を使うためで、検査を追加しました

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
- MCP server。Claude Code や Codex から同じ Runtime を使います(`@openshain/mcp`)
- `openshain` CLI: init、run、work list、work show、work resume、tools list、mcp
- `openshain` の画面。社員エージェントと話し、作業は Work にして進めます。全画面で、会話はマウスホイールと PageUp で遡り、入力欄はカーソルで編集し、上下の矢印で前の入力を呼び戻します。会話は `type: session` の Work として残ります
- 社員エージェントはセッションごとに名前を持ちます。名前は `company.language`(`ja` か `en`)の一覧から選び、Work の記録に残ります
- openshain.yaml、events.jsonl、work.json の JSON Schema(`spec/schemas/`)
- 各 package の設計ノート(`docs/design/`)
- 公式サイトが読む path の一覧と変更の規則(`docs/website-integration.md`)。Release workflow は stable の tag(`vX.Y.Z`)のときだけサイトの repo へ `repository_dispatch`(`openshain-release`)を送り、印付きの tag は prerelease にします

[Unreleased]: https://github.com/openshain/openshain/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/openshain/openshain/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/openshain/openshain/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/openshain/openshain/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/openshain/openshain/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/openshain/openshain/releases/tag/v0.1.0
