# `@openshain/mcp` の設計

MCP Server は、外部の Agent(Claude Code、Codex)が考え、Runtime が Work の状態と Tool と記録を提供する形の入口。CLI と同格で、agent の loop は使わない。

## 接続が現在の Work を持つ

決めたこと。`work_create`、`work_select`、`work_get`、`work_list`、`work_complete`、`work_fail` を Runtime の Tool として出す。名前は予約。接続(Session)が現在の Work を 1 つ持ち、他の Tool 呼び出しはその Work に記録される。現在の Work がなければ、Work を作るよう促すエラーを返す。

理由。MCP の Tool 呼び出しには Work の id を運ぶ場所がない。接続が Work を覚えているのが、Agent にとって最も間違えにくい。

捨てた案。

- すべての Tool の入力に `work_id` を足す。Agent が毎回書き、書き忘れや取り違えがそのまま記録の誤りになる。
- 未完了の Work があるまま `work_create` を許す。Agent が Work を放置して次を作り、`in_progress` の Work が溜まる。先に完了か失敗を求める。

## CLI と同じ名前、同じ schema

登録された Tool を CLI と同じ名前、同じ schema で出す。呼び出しは同じ検証、同じ許可判定、同じ記録を通る。結果の JSON は文字列にして text で返す。MCP の content の型に合わせるため。

理由。設定ファイルに Tool を書けば、CLI からも MCP からも同じように呼べることが、この入口の存在理由。

## 呼び出しは接続ごとに 1 つずつ

Agent は Tool を並列に呼ぶ。Runtime の Work は書き込みに lock を持つので、並列に来た呼び出しを接続ごとに直列にする。並列に呼んだ Agent は、結果が順に返るだけで、lock の奪い合いを見ない。

## 記録と検証

- 呼び出しは現在の Work の `tool.called` と `tool.completed` になる。call id は Runtime が振る。
- 外部 Agent の model の使用量は Runtime から見えない。この入口では `usage.recorded` は Tool の実行分だけになる。見えないものを推定して記録しない。
- `work_complete` の artifacts は任意。Tool が書いたファイルと Agent の申告を合わせ、パスごとに Runtime が path guard を通してハッシュを計算する。workspace の外を指す申告は何も記録せずに断る。
- 終わった Work への呼び出しは断り、接続の現在の Work を空にする。

## 文言は英語

Tool の説明とエラー文は Agent が読むので英語。利用者向けの日本語は CLI にある。

## transport は stdio、配布は CLI に同梱

`openshain mcp` が stdio で起動する。インストールが 1 回で済むように、別のバイナリにしない。HTTP の transport は足さない。ローカルの Agent から使う形しか今はない。

捨てた案。

- 質問に MCP の elicitation を使う。client の対応が揃っていない。外部 Agent が自分の方法で利用者に聞くほうが確実。
- 1 接続で複数の Work を同時に進める。Agent がどの Work を進めているかが混ざる。Work を切り替えるなら `work_select` で明示する。

## 公開面

`createMcpServer`、`Session`。
