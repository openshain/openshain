# `@openshain/core` の設計

core はインターフェース(ModelProvider、ToolProvider)、基本オブジェクト(Work、Event)、Work Runtime(記録、投影、path guard、Tool の登録と呼び出し)を持ちます。model も Tool も持ちません。CLI、MCP Server、第三者のプログラムはこの上に載ります。

## インターフェースを切る場所は 3 つ

決めたこと。インターフェースにするのは ModelProvider、ToolProvider、入口(CLI と MCP)の 3 つです。Knowledge、検索、認証、秘密の管理は、2 つ目の実装が現れたときに切ります。

理由。実装が 1 つしかない抽象は、その 1 つの形をなぞるだけで、2 つ目が来たときに合いません。model は vendor が複数あり、Tool は標準と第三者があり、入口は CLI と MCP があります。この 3 つは今から複数の実装が要ります。

捨てた案。将来の provider の interface を最初から並べる案。使われない抽象は保守されず、実装が来たときに壊して作り直すことになります。

## イベントログが原本

決めたこと。Work に起きたことは `work/<id>/events.jsonl` に追記します。Work の状態は `reduceWork` がイベントから作ります。会話履歴も進捗も使用量の合計も、そこから導きます。

envelope(v、id、work_id、seq、type、occurred_at、recorded_at)は厳密に検証し、payload は知らない項目を保持して通します。項目を追加しても古い Runtime がログを拒否しないためです。envelope を変えるときは `v` を上げます。書き込みは正規形です。キーを再帰的にソートし、自由形式の値の中の undefined は null にします。同じイベントは同じバイト列になります。追記は自分の行を読み返してから書き、末尾が改行で終わっていないファイルには書きません。

理由。原本が 1 つなら、再開、再生、監査、集計が同じ道を通ります。テキストのまま読めることも要ります。壊れた記録を人が修正できるからです。

捨てた案。

- 会話履歴を JSON で別に保存する案。原本が 2 つになり、食い違ったときにどちらを信じるかが決まりません。
- 最初から SQLite に入れる案。1 つの Work の記録は小さく、grep で読めることのほうが今は価値があります。複数の Work をまたぐ検索や集計が要るようになったら、WorkStore の裏で差し替えます。

## 投影は毎回組み立てる

決めたこと。model に渡す内容(system、messages、tools、末尾の残り回数の行)は、そのつどイベントから組み立てます。同じイベント列からは byte 単位で同じ messages ができます。provider 固有の内容(thinking など)は `opaque` として保存し、同じ provider にだけ無変更で返します。残り回数の通知は独立した user message として末尾に追加します。

理由。model を交換できる条件は、model 固有の状態を原本にしないことです。thinking は捨てられる最適化として扱います。byte 一致は prompt cache の前提でもあります。残り回数の行を独立した message にしたのは、前の message の byte をターンをまたいで変えないためです。

## 会話も Work の記録に載せる

決めたこと。人の発言は `human.message`、Work を始めた Work は `work.created` の `parent` に残します。セッションは `type: session` の Work で、投影はその objective を model に見せません。

理由。envelope、追記の規則、lock、一覧、JSON Schema を会話のためにもう 1 組作らず、type で区別します。Work は本来「終わりのある仕事」なので概念としてははみ出しますが、記録の道具を 1 つに保つ価値のほうが大きいです。

## 判断はコードが持つ

状態遷移の表、呼び出し回数の上限、path guard、入力の schema 検証、Tool の許可判定は、普通の関数で書きます。model に「してはいけない」と教えても強制になりません。`authorize()` は今は許可リストだけですが、Tool を実行する直前の 1 か所に置いてあり、後の権限の判定はそこに差し込みます。

Tool 定義の schema は登録時に検証します。`pattern` と `patternProperties` にバックトラックが爆発する正規表現(ReDoS)があれば登録を拒否します。入力の値を渡すのは model なので、検証自体を止められる schema を受け付けません。

## 予約する名前とパス

Tool の名前 `ask_user` と `work_*` は Runtime のもので、provider が同じ名前を登録すると起動時に止まります。パス `openshain.yaml` と `work/` と隠し項目には Tool からアクセスできません。第三者の Tool が Runtime の名前を装えないようにするためです。

## ID、時刻、項目名

ID は UUIDv7 に接頭辞(`work_`、`evt_`)を付け、コードでは branded type にして取り違えを型で防ぎます。時刻は ISO 8601 の UTC で、出来事の時刻と記録した時刻を分けます。ファイルの項目名は snake_case、コードは camelCase で、変換は読み書きの境界で 1 回だけ行います。

## エラーは code で分岐する

provider と Runtime の失敗は `OpenshainError`(code と message)で表します。code は機械が読む語の閉じた一覧で、Runtime はそれで分岐し、利用者向けの文言は入口が持ちます。provider の独自の理由は message に書きます。Tool の業務上の失敗(ファイルがない、列がない)は `isError` の結果として返し、Work は続きます。

## 公開 API

`index.ts` から export したものが SDK です。SDK という package は作りません。内部と公開 API を分けるのは、外部の利用者から互換性の要求が来たときでよいと考えています。build はせず、TypeScript のソースをそのまま export しています。今はインターフェースを壊して直す時期で、固定した公開 API はまだ嘘になります。

`jsonSchemas()` は、ファイルを検証する zod の schema から JSON Schema(draft 2020-12)を作ります。`spec/schemas/` はその出力で、`bun run schemas` が書き、CI が最新かを確認します。原本は zod で、JSON Schema は他の言語や道具のための写しです。refine で書いた条件はそこに出ません。

捨てた案。公開 API を型定義ファイルで固定して semver を守る案。守れない約束を先にしません。

## 変える条件

- 2 つ目の実装が現れたインターフェースは切ります(Knowledge、検索、認証)。
- Work をまたぐ検索や集計が要るようになったら、WorkStore の裏に SQLite を入れます。イベントログの形は変えません。
- 外部から互換性の要求が来たら、内部と公開 API を分けて semver を始めます。
