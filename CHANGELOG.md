# Changelog

形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/)、版は [Semantic Versioning](https://semver.org/lang/ja/) に従います。

## [Unreleased]

### Added

- `pdf_read`。会社フォルダの PDF から文字を取り出します。ページ単位の窓(既定 5 ページ)で、総ページ数と続きの有無を返します。取引先から届く請求書のほとんどが PDF だからです。文字が取り出せないときは理由を分けて伝えます。紙を撮った PDF で文字が 1 つも無いのか、文字はあるがフォントを読めないのか。表は読み順のテキストになるので、金額を数えるときは CSV に書いてから `csv_aggregate` を通してください。OCR はしません

### Fixed

- 銀行やカード会社の CSV のように Shift_JIS で書かれたファイルを、その文字のまま読みます。これまでは UTF-8 として読んでいたため、文字化けした文字列が例外にもならずに返り、社員エージェントには取引先の名前に見えていました。`fs_read`、`csv_read`、`markdown_read`、`fs_search` のすべてに効きます
- 画像や PDF のように文字ではないファイルを読もうとしたときは、置換文字の列を返さずに拒否します
- 返答が長さの上限で切れたとき、途中まで進んでいた Work のことを画面で伝えます。これまでは切れたとだけ表示していたため、作りかけの Work が残っていることも、続け方も分かりませんでした

## [0.7.0] - 2026-09-12

会社フォルダで 2 人目から働けるようにする版です。会社の人を `principals/` に書き、その人の社員エージェントが働く範囲を `reads` で決めます。止めているのは社員エージェントであって、人ではありません。会社フォルダを開ける人は、どのファイルもそのまま読めます。`principals/` を置かない会社フォルダは、これまでとまったく同じに動きます。`packages/core` の `ToolRejectionCode` に値が 1 つ増え、`ToolContext` に項目が 2 つ増えるので、第三者の Tool は追加が要ります。

### Added

- 会社の人を `principals/<id>.yaml` に 1 人 1 ファイルで書きます。`id`、`name`、`roles`(担当)、`status`、`reads`(その人の社員エージェントが働く範囲)です。`principals/` を置かない会社フォルダは、これまでとまったく同じに動きます
- `openshain --principal <id>` と環境変数 `OPENSHAIN_PRINCIPAL` で、その端末が誰として働くかを選びます。共有された `openshain.yaml` は書き換えません。`reads` を書いた人が 2 人以上いるのに指定が無いときは起動しません。本人確認はしていません
- `reads` を書いた人の社員エージェントは、範囲の外を一覧にも検索にも件数にも出しません。名指しで読もうとしたときは、そこに何かがあるかどうかに関わらず同じ返事をします。書き込みも届きません。記録には本当の理由(`out_of_range`)が残ります。止めているのは社員エージェントで、人ではありません(会社フォルダを直接読める人は、どのファイルも読めます)
- `authority/policy.yaml` の `match` に `role` を追加しました。依頼した人が `principals/` で持つ役割に一致します
- `knowledge` の `scope: { roles: [...] }` が解決できるようになりました。これまでは誰にも見えませんでした。`knowledge build` は、`scope` に書いた人と役割が `principals/` に実在するかを確かめます
- `openshain principal check <id>`。`reads` に実際に一致するファイルとフォルダ、委任の有無、役割で一致する規則、範囲の外を `allow` している規則を表示します
- `inactive` にした人は、代理も承認もできません。判定のたびに読み直すので、開いたままの会話にも効きます
- `reads` を書いた人の社員エージェントは、自分の Work だけを読みます(`work_list`、`work_get`、`openshain work list`、`openshain work show`)。ほかの人の Work は、id を名指ししても、無いときと同じ返事になります。`work/` は予約パスで、この 2 つが記録への唯一の経路だからです。`approval_list` は絞りません。承認は他の人の Work に対して行うものです

### Fixed

- `openshain --principal <id>` と `OPENSHAIN_PRINCIPAL` が、対話型 CLI の中の Runtime に届いていませんでした。Work が `openshain.yaml` の principal の名前で記録され、指定した人の `reads` も効いていませんでした
- 会話を要約した後に、そのターンが「壊れた Work の記録」で止まることがありました。要約が呼び出しを覆い、その結果だけが要約の後に残ったときです(社員エージェントが質問し、人が答えたのが要約をまたいだ場合)。要約が覆った呼び出しの結果は、要約の後には残しません

### Changed

- **`ToolRejectionCode` に `out_of_range` が増えました。** その人の社員エージェントが働く範囲の外だったために実行しなかった呼び出しを表します
- **`ToolContext` に `roles` と `covers` が増えました。** 一覧や検索を返す第三者の Tool は、`covers` で絞ってください。`path` を持つ呼び出しは Runtime が入口で判定します
- `knowledge` の `scope` に書く人と役割の文字種を、`principals/` と `authority/` に揃えました
- `openshain work list` と `openshain work show` が `openshain.yaml` と `principals/` を読みます。誰として表示するかが決まらないと、表示する記録も決まらないためです

## [0.6.0] - 2026-09-11

規則が、書いたとおりに効くようにする修正です。1 人で使っている会社フォルダにも効きます。`packages/core` の `ToolRejectionCode` に値が 1 つ増えるので、網羅している実装は追加が要ります。

### Fixed

- 規則の `path` を、実際に読み書きする場所に対して照合します。これまでは Tool に渡された文字列に対して判定していたため、会社フォルダの中の link(`ledger/shortcut` が `hr/salaries.csv` を指す)や、大文字小文字の違う綴り(`HR/...`)で `deny` の規則を素通りできました。照合は大文字小文字を区別せず、Unicode を NFC に揃えます。記録に残る path は、これまでどおり呼び出しが名指しした文字列です
- 承認した呼び出しは、承認したときの場所に書きます。承認は会話をまたぐので、決まるまでの間にその path が別の場所を指すようになることがあります。実行の直前に確かめ、違えば実行せず `tool.rejected`(`path_changed`)を残します
- `authority/` を書き換えると、開いたままの会話にもその場で効きます。これまでは起動時に 1 回だけ読んでいたため、規則を厳しくしてもその日動いているセッションには効きませんでした。`authority/` が読めないときは、その呼び出しを拒否として記録します

### Changed

- **`ToolRejectionCode` に `path_changed` が増えました。** 承認したときと書き込み先が変わったために実行しなかった呼び出しを表します。`Record<ToolRejectionCode, ...>` を書いている実装は追加してください

## [0.5.0] - 2026-09-10

会社の決まりを索引から引く仕組みと、長い会話の要約が入りました。`packages/core` のインターフェースに互換性のない変更があります。自作の Tool provider や SDK を書いている場合は、下の「変更」を確認してください。

### Added

- 会社の決まりと、その根拠の資料を索引から引きます。決まりを `knowledge/rules/*.yaml`、資料を `knowledge/sources/*.md` に書き、`openshain knowledge build` が検証して `knowledge/build/` に索引を作ります。出典と有効日の無い決まりは受け付けません。社員エージェントは名指しされなくても `knowledge_search` と `knowledge_read` で自分で引き、答えに決まりの id と有効日を添えます。検索も読み取りも、依頼する人が読んでよい範囲と、その日に有効な期間で絞ってから返し、読めない資料は件数にも現れません。索引が入力と食い違うときは内容を返さず、`openshain knowledge build` を実行するよう伝えます。`knowledge/` は予約パスで、ファイルの Tool からは読めません
- 決まりを引いたターンの返答がどの id も含まないときは、「参照した会社の決まり」として id と有効日を返答の末尾に追加します。どの決まりを引いたかは記録に残っている事実なので、社員エージェントの書きぶりに任せません
- `openshain knowledge add`。質問に答えると決まりを 1 件書きます。検証に落ちたときは何も書かず、それまでの決まりはそのままです
- `openshain knowledge check`。索引を書かずに検証だけ実行します。CI 向けです。`--stale` を付けると、`retrieved_at` が 1 年より古い資料を警告します
- 架空の会社の例に `knowledge/` のひな型を追加しました([examples/sample-company](examples/sample-company/README.md))
- 長い会話を要約して続けます。1 回の呼び出しの入力が閾値を超えると、次のターンの前に、それまでの会話を要約 1 件(`conversation.compacted`)にまとめます。直近 5 件の発言はそのまま残り、元のやり取りは記録に残ります。短くなるのはモデルが読む分だけです。閾値は `limits.compact_at_input_tokens`、書かないときは `model.context_tokens` の 70%、それも無ければ 150000 です。`0` で要約しません。要約したことは画面に 1 行表示し、引き継いだ前提を載せます。`/compact` で自分でも実行します。「入力が大きすぎる」で呼び出しが失敗したときは、要約して 1 回やり直します
- 古い Tool の結果を、モデルに渡す分だけ省略します。直近 5 件の発言より前が対象です。実行できなかった呼び出しは、どれだけ古くても理由を残します
- `openshain.yaml` に `model.context_tokens` と `limits.compact_at_input_tokens` を追加しました

### Changed

- **`ToolResult.observation` が配列になりました。** 1 回の呼び出しが複数の資料を引くためです。単数の `{ source, retrievedAt }` を返している Tool provider は配列に変更してください。記録に残っている単数の形はそのまま読めます
- **`ModelConfig` に `contextTokens`、`Config.limits` に `compactAtInputTokens` が増えました。** これらの型を自分で組み立てているコードは、値(`undefined` でも)を書く必要があります
- **`ErrorCode` に `too_large` が増えました。** モデルが入力の大きさを理由に受け付けなかったことを表します。`ErrorCode` を網羅している実装は追加してください
- **`work_select` は、設定の principal と違う人の Work を受け付けません。** `work_record` は選んだ Work にしか書けないので、client が別の人の会話に記録を書く経路が無くなります。読み取り(`work_get`、`work_list`)は変わりません
- 古い Tool の結果はモデルに渡りません(上記)。同じ会話でも、モデルが読む内容がこれまでと変わります

## [0.4.1] - 2026-09-09

### Fixed

- 業務日を会社の時刻で決めるようにしました。これまでは openshain を動かしている機械の時刻をそのまま使っていたため、UTC のサーバーで動かすと、判断や委任の有効日が日本時間より 9 時間遅れて有効になっていました。`openshain.yaml` に `company.timezone`(`Asia/Tokyo` のような IANA の名前)を追加します。省略したときはこれまでどおり機械の設定を使い、`openshain init` はその値を書きます。`context` Tool が返す時刻と業務日も会社の時刻になります

## [0.4.0] - 2026-09-09

### Added

- 資格者の Review。規則が `review_required` と判定した呼び出しは、Review Package(呼び出し、そこまでの Tool 呼び出し、社員エージェントの提案、問い)を記録して止まります。`review_decide`(画面では `/review <id> approve`)で資格者の判断を記録すると、`authority/decisions/` に判断が書かれ、Runtime が呼び出しを実行します。`decision_backed` の規則はその判断を引き、有効日と適用範囲を確かめてから実行します。イベントは `review.requested`、`review.decided`、`decision.applied` です。Review Package の写しは `work/<id>/review/` に置きます。資格は会社の申告として記録し、openshain は検証しません。承認と判断の Tool は対話型 CLI のモデルには渡しません。規則が求める役(`reviewer.role`)と違う役の名では判断を記録できません
- 承認の流れ。規則が `approval_required` と判定した Tool 呼び出しは `waiting_approval` で止まります。対話型 CLI では入力欄が承認の選択画面に変わり、何が変わるか(書き込みなら差分)を確認して、実行する、この会話では常に承認する、実行しない、から選びます。選ぶとターンはそのまま続きます。MCP では `approval_list` と `approval_decide`、画面では `/approvals` と `/approve <id>` と `/reject <id>` も使えます。承認すると Runtime がその場で実行します。イベントは `approval.requested` と `approval.decided`、拒否の code は `rejected_by_person` です
- `authority/policy.yaml` と `authority/delegations.yaml`。Tool 呼び出しを規則の表で判定し(最初の一致、`*` と `**` の glob)、委任の無い代理と規則で拒否した呼び出しを `tool.rejected`(`denied`)として記録します。Review が要る規則は、その仕組みが入るまで拒否として動きます。`principals/` と `authority/` は予約パスです。JSON Schema は `spec/schemas/authority-*.v1.json` にあります
- Runtime の Tool `context`。現在時刻、タイムゾーン、今日の業務日、会社フォルダ、依頼する人、現在の Work を返します。対話型 CLI は会話の開始時に 1 回呼んで記録し、社員エージェントは日付が要るときに呼び直します

### Changed

- 社員エージェントへの指示を節に分けて書き直しました。画面に何が映るか(返答と Tool 呼び出しの 1 行だけで、Tool の結果と Work の要約は映りません)を明示し、返答に結果の数字を書くこと、書式を使えることを指示します。作業の Work を閉じた直後にも同じことを会話に伝えます。それでも社員エージェントが何も書かずにターンが終わったときは、画面が Work の要約を返答として表示します
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

[Unreleased]: https://github.com/openshain/openshain/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/openshain/openshain/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/openshain/openshain/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/openshain/openshain/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/openshain/openshain/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/openshain/openshain/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/openshain/openshain/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/openshain/openshain/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/openshain/openshain/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/openshain/openshain/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/openshain/openshain/releases/tag/v0.1.0
