# `@openshain/mcp` の設計

MCP Server は、外部のエージェント(Claude Code、Codex)が考え、Runtime が Work の状態と Tool と記録を提供する形の入口です。CLI と同格で、agent の loop は使いません。

## 接続が現在の Work を持つ

決めたこと。`work_create`、`work_select`、`work_get`、`work_list`、`work_complete`、`work_fail` を Runtime の Tool として公開します。名前は予約です。接続(Session)が現在の Work を 1 つ持ち、他の Tool 呼び出しはその Work に記録されます。現在の Work がなければ、Work を作るよう促すエラーを返します。

理由。MCP の Tool 呼び出しには Work の id を運ぶ場所がありません。接続が Work を覚えているのが、エージェントにとって最も間違えにくいです。

捨てた案。

- すべての Tool の入力に `work_id` を追加する案。エージェントが毎回書き、書き忘れや取り違えがそのまま記録の誤りになります。
- 未完了の Work があるまま `work_create` を許す案。エージェントが Work を放置して次を作り、`in_progress` の Work が溜まります。先に完了か失敗を求めます。

## client のための Tool(`ask_user`、`work_answer`、`work_record`、`history`)

決めたこと。Runtime はモデルを呼ばないので、質問と記録の片側を client に開きます。`ask_user` は質問を記録して Work を `waiting_input` にし、`pending: true` と call_id を返します。人に聞くのは client で、答えは `work_answer` が `human.input_provided` と同じ call_id の `tool.completed` に記録して `in_progress` に戻します。`work_record` は client 自身のイベント(人の発言、prompt の展開、モデルの呼び出しと使用量)を指定した Work に書きます。受け付ける type を 6 つに限り、書ける Work をその接続で作ったか選んだものに限り、payload は spec/schemas/events.v1.json の形で検証します。Tool の呼び出しは Runtime だけが記録します。未回答の質問は記録全体から探します。client が `model.completed` を書いても、質問は隠れません。`work_get` の `history` は、これまでの Tool 呼び出し、結果のない呼び出し、未回答の質問を返し、client が止まった Work を続けるための材料です。

理由。対話型 CLI を MCP client にすると、会話の記録と自分のモデルの使用量を `work/` に残す経路が要ります。Runtime に「client のための書き込み」を 1 つだけ開き、type を限ることで、client が Tool の記録を偽る経路は作りません。Claude Code のように `work_record` を呼ばない client も成り立ちます。

捨てた案。CLI だけがプロセス内で `WorkStore` に直接書く案。Tool の面が 2 つになり、Authority を置く場所も 2 つになります。

## 選べるのは自分の Work だけ

決めたこと。`work_select` は、その Work の principal が設定の principal と違うとき受け付けません。`work_record` は「その接続で作ったか選んだ Work」にしか書けないので、選ぶところを塞げば、client が別の人の会話にイベントを書く経路はなくなります。読み取り(`work_get`、`work_list`)は変えません。会社フォルダのどの Work も読めます。

理由。会話の記録は、その人が何を頼み、何を了承したかの原本です。`work/` は予約パスなので Tool からは書けず、`work_record` が client にとって唯一の書き込み口です。ここに人の検査が無いと、同じ会社フォルダに接続した別の client が、他人の会話に発言や要約を書けます。会社フォルダに書ける人は記録を直接編集できるので、これは権限の壁ではなく、openshain を通る経路の筋を通すものです。読み取りを閉じないのは、この版の Work の一覧と記録が会社の共有物で、絞り込みは複数人を扱うときに入れると決めているからです(spec/knowledge.md)。

## 承認は Runtime が実行する

決めたこと。規則が `approval_required` と判定した呼び出しは、Runtime が `approval.requested` を記録して Work を `waiting_approval` にし、呼び出し元には `pending: "approval"` を返します。`approval_decide` の `approve` で Runtime がその場で Tool を実行し、結果を返します。model にもう一度呼ばせません。`reject` は `tool.rejected`(`rejected_by_person`)です。承認する人は、この版では接続が代理する principal で、規則の `approvers` に居なければ決められません。

理由。承認された呼び出しを model が呼び直す形にすると、承認したものと実行されたものが同じである保証がなくなります。Runtime が承認の記録にある入力をそのまま実行するので、承認と実行が 1 対 1 で記録に残ります。

## Review は資格者だけが決める

決めたこと。`review_required` で止まった呼び出しは `review_decide` でしか決められません。`approval_decide` で決めようとすると受け付けません。逆も同じです。`approve` と `modify` は Decision を `authority/decisions/` に書き、Runtime がその場で呼び出しを実行し、書いた Decision をすぐ読み直します。次の呼び出しが `decision_backed` でそれを引けるようにするためです。

理由。会社の人の承認と、資格者の判断は別のものです(professional-boundary.md)。同じ Tool で決められると、人が資格者の代わりを務められます。Reviewer の資格は会社の申告として記録し、openshain は検証しません。`modify` で変更する先を変えることはできません。承認したものと実行するものがずれるからです。入力を受け付けないときは、記録に何も書く前に返します。受け付けなかった呼び出しは保留のまま残ります。

## `context` は session でも呼べる

決めたこと。`context` は現在時刻(オフセット付き)、タイムゾーン、今日の業務日、会社フォルダ、会社、依頼する人、職種、現在の Work を返す Runtime の Tool です。現在の Work があれば session でも記録します。client は会話を開くときに 1 回呼び、結果を `prompt.expanded` として記録します。

理由。投影は記録から同じ結果になる規則なので、時刻を system prompt に直接入れると再現できなくなります。Tool の結果か記録されたイベントとして渡せば、後から同じ投影が作れます。ファイルには触れないので、session の中の Tool 禁止の例外にしても記録のない操作は生まれません。

## `type: session` の Work では Tool を呼べない

決めたこと。`work_create` は `type: session` と `parent` を受けます。session の Work を現在の Work にはできますが、その中で Tool を呼ぶと拒否し、`parent` に session を指定して作業の Work を作るよう促します。

理由。会話の記録と作業の記録を分ける規則を、client の善意ではなく Runtime が守ります。

## `max_tool_calls` は Runtime が数える

決めたこと。Tool 呼び出しの前に、その Work の `tool.called` と単独の `tool.rejected` を数え、設定の `max_tool_calls` に達していれば `tool.rejected`(limit_reached)を記録して `isError` で返します。Work は閉じません。閉じるかどうかは client が決めます。モデルの呼び出し回数は Runtime に見えないので、client が数えます。

## CLI と同じ名前、同じ schema

登録された Tool を CLI と同じ名前、同じ schema で公開します。呼び出しは同じ検証、同じ許可判定、同じ記録を通ります。結果の JSON は文字列にして text で返します。MCP の content の型に合わせるためです。

理由。設定ファイルに Tool を書けば、CLI からも MCP からも同じように呼べることが、この入口の存在理由です。

## 呼び出しは接続ごとに 1 つずつ

エージェントは Tool を並列に呼びます。Runtime の Work は書き込みに lock を持つので、並列に来た呼び出しを接続ごとに直列にします。並列に呼んだエージェントは、結果が順に返るだけで、lock の奪い合いを意識しません。接続が 2 つあれば同じ Work を両方から進められます。lock は呼び出しの間だけ持ち、接続をまたぐ排他はしません。1 人で使う前提で、複数人は後の版で考えます。

## 記録と検証

- 呼び出しは現在の Work の `tool.called` と `tool.completed` になります。call id は Runtime が振ります。
- 外部エージェントの model の使用量は Runtime から見えません。この入口では `usage.recorded` は Tool の実行分だけになります。見えないものを推定して記録しません。
- `work_complete` の artifacts は任意です。Tool が書いたファイルとエージェントの申告を合わせ、パスごとに Runtime が path guard を通してハッシュを計算します。workspace の外を指す申告は何も記録せずに受け付けません。
- 終わった Work への呼び出しは受け付けず、接続の現在の Work を空にします。
- エージェントが挙げただけで、この Work の Tool が書いていないファイルは `claimed: true` を付けて残します。ハッシュは Runtime が計算しますが、その Work の作業の結果だという裏付けは記録にないので、読む人が見分けられるようにします。

## 文言は英語

Tool の説明とエラー文はエージェントが読むので英語です。利用者向けの日本語は CLI にあります。

## transport は stdio、配布は CLI に同梱

`openshain mcp` が stdio で起動します。インストールが 1 回で済むように、別のバイナリにしません。HTTP の transport は追加しません。ローカルのエージェントから使う形しか今はありません。

捨てた案。

- 質問に MCP の elicitation を使う案。client の対応が揃っていません。外部エージェントが自分の方法で利用者に聞くほうが確実です。
- 1 接続で複数の Work を同時に進める案。エージェントがどの Work を進めているかが混ざります。Work を切り替えるなら `work_select` で明示します。

## 外部エージェントの自前の Tool は塞がない

決めたこと。Claude Code や Codex が持つ Read、Write、Bash を openshain が奪うことはしません。会社のファイルを Runtime の Tool で扱わせるのは、Tool の説明文、会社フォルダに置く指示、host 側の権限設定で行います。

理由。外部エージェントが自前の Tool でフォルダを変更する経路は、Runtime からは見えないし塞げません。塞げるのは host だけで、Claude Code なら会社フォルダの設定で Write や Bash を deny できます。判断が LLM の外にある、という決まりと同じ形で、Runtime が host の Tool を上書きする形ではありません。接続テストでは、自前の Tool を使わないよう依頼文で言わないと Runtime を通りませんでした。言えば csv_aggregate を自分で選び、合計を足し算しませんでした。

Runtime を通らなかった操作は記録に残りません。それが差で、外部の SaaS への変更は後の版で Runtime の Tool が唯一の経路になります。ローカルのファイルは最後まで host の Tool でも触れます。

変える条件。会社フォルダに置く指示のひな型を `openshain init` が書くかは、quickstart を書くときに決めます。

## 公開 API

`createMcpServer`、`Session` です。
