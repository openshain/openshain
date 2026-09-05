# `@openshain/mcp` の設計

MCP Server は、外部のエージェント(Claude Code、Codex)が考え、Runtime が Work の状態と Tool と記録を提供する形の入口です。CLI と同格で、agent の loop は使いません。

## 接続が現在の Work を持つ

決めたこと。`work_create`、`work_select`、`work_get`、`work_list`、`work_complete`、`work_fail` を Runtime の Tool として出します。名前は予約です。接続(Session)が現在の Work を 1 つ持ち、他の Tool 呼び出しはその Work に記録されます。現在の Work がなければ、Work を作るよう促すエラーを返します。

理由。MCP の Tool 呼び出しには Work の id を運ぶ場所がありません。接続が Work を覚えているのが、エージェントにとって最も間違えにくいです。

捨てた案。

- すべての Tool の入力に `work_id` を足す案。エージェントが毎回書き、書き忘れや取り違えがそのまま記録の誤りになります。
- 未完了の Work があるまま `work_create` を許す案。エージェントが Work を放置して次を作り、`in_progress` の Work が溜まります。先に完了か失敗を求めます。

## CLI と同じ名前、同じ schema

登録された Tool を CLI と同じ名前、同じ schema で出します。呼び出しは同じ検証、同じ許可判定、同じ記録を通ります。結果の JSON は文字列にして text で返します。MCP の content の型に合わせるためです。

理由。設定ファイルに Tool を書けば、CLI からも MCP からも同じように呼べることが、この入口の存在理由です。

## 呼び出しは接続ごとに 1 つずつ

エージェントは Tool を並列に呼びます。Runtime の Work は書き込みに lock を持つので、並列に来た呼び出しを接続ごとに直列にします。並列に呼んだエージェントは、結果が順に返るだけで、lock の奪い合いを見ません。接続が 2 つあれば同じ Work を両方から進められます。lock は呼び出しの間だけ持ち、接続をまたぐ排他はしません。1 人で使う前提で、複数人は後の版で考えます。

## 記録と検証

- 呼び出しは現在の Work の `tool.called` と `tool.completed` になります。call id は Runtime が振ります。
- 外部エージェントの model の使用量は Runtime から見えません。この入口では `usage.recorded` は Tool の実行分だけになります。見えないものを推定して記録しません。
- `work_complete` の artifacts は任意です。Tool が書いたファイルとエージェントの申告を合わせ、パスごとに Runtime が path guard を通してハッシュを計算します。workspace の外を指す申告は何も記録せずに断ります。
- 終わった Work への呼び出しは断り、接続の現在の Work を空にします。
- エージェントが挙げただけで、この Work の Tool が書いていないファイルは `claimed: true` を付けて残します。ハッシュは Runtime が計算しますが、その Work の作業の結果だという裏付けは記録にないので、読む人が見分けられるようにします。

## 文言は英語

Tool の説明とエラー文はエージェントが読むので英語です。利用者向けの日本語は CLI にあります。

## transport は stdio、配布は CLI に同梱

`openshain mcp` が stdio で起動します。インストールが 1 回で済むように、別のバイナリにしません。HTTP の transport は足しません。ローカルのエージェントから使う形しか今はありません。

捨てた案。

- 質問に MCP の elicitation を使う案。client の対応が揃っていません。外部エージェントが自分の方法で利用者に聞くほうが確実です。
- 1 接続で複数の Work を同時に進める案。エージェントがどの Work を進めているかが混ざります。Work を切り替えるなら `work_select` で明示します。

## 外部エージェントの自前の Tool は塞がない

決めたこと。Claude Code や Codex が持つ Read、Write、Bash を openshain が奪うことはしません。会社のファイルを Runtime の Tool で扱わせるのは、Tool の説明文、会社フォルダに置く指示、host 側の権限設定で行います。

理由。外部エージェントが自前の Tool でフォルダを触る経路は、Runtime からは見えないし塞げません。塞げるのは host だけで、Claude Code なら会社フォルダの設定で Write や Bash を deny できます。判断が LLM の外にある、という決まりと同じ形で、Runtime が host の Tool を上書きする形ではありません。接続テストでは、自前の Tool を使わないよう依頼文で言わないと Runtime を通りませんでした。言えば csv_aggregate を自分で選び、合計を足し算しませんでした。

Runtime を通らなかった操作は記録に残りません。それが差で、外部の SaaS への変更は後の版で Runtime の Tool が唯一の経路になります。ローカルのファイルは最後まで host の Tool でも触れます。

変える条件。会社フォルダに置く指示のひな型を `openshain init` が書くかは、quickstart を書くときに決めます。

## 公開 API

`createMcpServer`、`Session` です。
