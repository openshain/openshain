# `@openshain/core` の設計

core は契約(ModelProvider、ToolProvider)、基本オブジェクト(Work、Event)、Work Runtime(記録、投影、path guard、Tool の登録と呼び出し)を持つ。model も Tool も持たない。CLI、MCP Server、第三者のプログラムはこの上に載る。

## 契約を切る場所は 3 つ

決めたこと。契約にするのは ModelProvider、ToolProvider、入口(CLI と MCP)の 3 つ。Knowledge、検索、認証、秘密の管理は、2 つ目の実装が現れたときに切る。

理由。実装が 1 つしかない抽象は、その 1 つの形をなぞるだけで、2 つ目が来たときに合わない。model は vendor が複数あり、Tool は標準と第三者があり、入口は CLI と MCP がある。この 3 つは今から複数の実装が要る。

捨てた案。将来の provider の interface を最初から並べる。使われない抽象は保守されず、実装が来たときに壊して作り直すことになる。

## イベントログが正本

決めたこと。Work に起きたことは `work/<id>/events.jsonl` に追記する。Work の状態は `reduceWork` がイベントから作る。会話履歴も進捗も使用量の合計も、そこから導く。

envelope(v、id、work_id、seq、type、occurred_at、recorded_at)は厳密に検証し、payload は知らない項目を保持して通す。項目を足しても古い Runtime がログを拒否しないため。envelope を変えるときは `v` を上げる。書き込みは正規形。キーを再帰的にソートし、自由形式の値の中の undefined は null にする。同じイベントは同じバイト列になる。追記は自分の行を読み返してから書き、末尾が改行で終わっていないファイルには書かない。

理由。正本が 1 つなら、再開、再生、監査、集計が同じ道を通る。テキストのまま読めることも要る。壊れた記録を人が直せるからだ。

捨てた案。

- 会話履歴を JSON で別に保存する。正本が 2 つになり、食い違ったときにどちらを信じるかが決まらない。
- 最初から SQLite に入れる。1 つの Work の記録は小さく、grep で読めることのほうが今は価値がある。複数の Work をまたぐ検索や集計が要るようになったら、WorkStore の裏で差し替える。

## 投影は毎回組み立てる

決めたこと。model に渡す内容(system、messages、tools、末尾の予算行)は、そのつどイベントから組み立てる。同じイベント列からは byte 単位で同じ messages ができる。provider 固有の内容(thinking など)は `opaque` として保存し、同じ provider にだけ無変更で返す。予算の通知は独立した user message として末尾に足す。

理由。model を交換できる条件は、model 固有の状態を正本にしないこと。thinking は捨てられる最適化として扱う。byte 一致は prompt cache の前提でもある。予算行を独立した message にしたのは、前の message の byte をターンをまたいで変えないため。

## 判断はコードが持つ

状態遷移の表、呼び出し回数の上限、path guard、入力の schema 検証、Tool の許可判定は、普通の関数で書く。model に「してはいけない」と教えても強制にならない。`authorize()` は今は許可リストだけだが、Tool を実行する直前の 1 か所に置いてあり、後の権限の判定はそこに差し込む。

Tool 定義の schema は登録時に検証する。`pattern` と `patternProperties` に破局的な後退を起こす正規表現があれば登録を拒否する。入力の値を渡すのは model なので、検証自体を止められる schema を受け付けない。

## 予約する名前とパス

Tool の名前 `ask_user` と `work_*` は Runtime のもので、provider が同じ名前を登録すると起動時に止まる。パス `openshain.yaml` と `work/` と隠し項目は Tool から触れない。第三者の Tool が Runtime の名前を装えないようにするため。

## ID、時刻、項目名

ID は UUIDv7 に接頭辞(`work_`、`evt_`)を付け、コードでは branded type にして取り違えを型で防ぐ。時刻は ISO 8601 の UTC で、出来事の時刻と記録した時刻を分ける。ファイルの項目名は snake_case、コードは camelCase で、変換は読み書きの境界で 1 回だけ行う。

## エラーは code で分岐する

provider と Runtime の失敗は `OpenshainError`(code と message)で表す。code は機械が読む語の閉じた一覧で、Runtime はそれで分岐し、利用者向けの文言は入口が持つ。provider の独自の理由は message に書く。Tool の業務上の失敗(ファイルがない、列がない)は例外ではなく `isError` の結果で、Work は続く。

## 公開面

`index.ts` から export したものが SDK。SDK という package は作らない。内部と公開面を分けるのは、外部の利用者から互換性の要求が来たときでよい。build はせず、TypeScript のソースをそのまま export している。今は契約を壊して直す時期で、固定した公開 API はまだ嘘になる。

`jsonSchemas()` は、ファイルを検証する zod の schema から JSON Schema(draft 2020-12)を作る。`spec/schemas/` はその出力で、`bun run schemas` が書き、CI が最新かを見る。正本は zod で、JSON Schema は他の言語や道具のための写し。refine で書いた条件はそこに出ない。

捨てた案。公開 API を型定義ファイルで固定して semver を守る。守れない約束を先にしない。

## 変える条件

- 2 つ目の実装が現れた契約は切る(Knowledge、検索、認証)。
- Work をまたぐ検索や集計が要るようになったら、WorkStore の裏に SQLite を入れる。イベントログの形は変えない。
- 外部から互換性の要求が来たら、内部と公開面を分けて semver を始める。
