# `@openshain/agent` の設計

agent は tool loop と、model provider の実装 2 つ(Anthropic、OpenAI 互換)を持ちます。core の上に載り、CLI が使います。MCP Server は外部のエージェントが考えるので、この loop を使いません。

## loop はイベントログの上の状態機械

決めたこと。投影を組み立てる、model を呼ぶ、記録する、Tool を実行する、記録する、先頭へ戻る、の繰り返しです。どの一歩も、記録してから次へ進みます。メモリ上に会話の配列を持ちません。

理由。途中で落ちても、記録がどこまで起きたかを語ります。再開は記録から始まり、会話の配列を復元する手順が要りません。

捨てた案。メモリ上の配列を回して最後にまとめて保存する案。落ちた瞬間に Work が消えます。

## 1 ターンの規則

- 1 つの応答に複数の tool_call があれば順に実行し、結果はまとめて 1 つの user message で返します。分けて返すと model が並列に呼ばなくなります。
- 同じターンの中で call id が重複したら model の誤りとして止めます。前のターンの id を使い回すサーバーはあるので、ターンをまたぐ重複は許します。
- `ask_user` は同じターンの他の Tool を先に実行してから記録し、Work は `waiting_input` になります。質問が複数あっても待つのは 1 回で、再開時に古い順に答えます。

## 止まる条件と上限

Work が止まるのは、完了、質問、上限到達、model の refusal、回復できないエラーの 5 つです。上限(model の呼び出し回数、Tool の呼び出し回数、1 回の出力)は設定が持ち、回数はイベントで数えます。拒否された呼び出しも数えます。

毎ターンの末尾に残りの回数を 1 行で見せます。model が残量を知って畳めるようにするためです。system prompt にはこの行が通知で返事は要らないと書いてあります。書かないと model が返事をしました。

捨てた案。上限に達したら黙って切る案。model は畳む機会を失い、利用者は途中の出力しか受け取れません。

## 再開は記録の整合から

`in_progress` のまま止まった Work を続けるときは、直前の model のターンで結果のない Tool 呼び出しに「途中で止まった」という失敗の結果を先に記録します。答えのない質問が残っていれば `waiting_input` として扱います。前のターンより古いイベントは見ません。

理由。投影の規則(tool_call は次の message までに結果を持つ)を満たさないログは model に渡せません。満たさないまま続けるより、閉じてから続けるほうが、model にも人にも何が起きたかが見えます。記録そのものが矛盾していれば `corrupt_log` で止め、勝手に修正しません。

## provider はインターフェースに揃える

決めたこと。provider は各社の公式 SDK を使い、message、stop reason、usage、エラーの code をインターフェースの形に揃えます。provider 固有の指定(thinking、effort、temperature)は `providerOptions` に入れてそのまま渡し、インターフェース側で共通化しません。model、messages、tools、出力の上限、stream しないことは Runtime が決め、`providerOptions` で上書きできません。

usage の `inputTokens` は入力の全部で、prompt cache から読んだ分と書いた分を含みます。provider によって生の値の意味が違うので、揃えるのは provider の仕事です。Runtime は `stableMessages`(次のターンも変わらない message の数)を渡します。Anthropic の provider はそこに cache の切れ目を置き、OpenAI 互換の provider は接頭辞の自動一致に任せて使いません。

エラーは code に写します。認証は `auth`、上限超過は `rate_limit`、設定の誤り(model 名、URL)は `config`、接続と 5xx は `network`、形が読めない応答は `invalid_response` です。Runtime は code で分岐し、利用者向けの文言は CLI が持ちます。

理由。インターフェースは 1 つで、差は provider の中に閉じ込めます。差をインターフェースに吸い上げると、provider を足すたびにインターフェースが変わります。

捨てた案。

- vendor 横断の SDK を adapter として挟む案。インターフェースが二重になり、差分の吸収先がどちらか分からなくなります。
- streaming。Work の進捗は Tool の行で足ります。途中の文字列を見せる価値より、記録の単純さを取りました。
- provider ごとに会話の形式を保存する案。model を替えたときに読めなくなります。

## loop は Runtime の client(v0.2)

決めたこと。対話型 CLI の loop(`createSession`)は Runtime を MCP の client として使います。`connectInMemory` が同じプロセスの MCP server に SDK の in-memory transport で接続し、Work の作成、Tool の呼び出し、質問、完了はすべて MCP の Tool(`work_create`、登録された Tool、`ask_user` と `work_answer`、`work_complete`)で行います。会話の記録と自分のモデルの呼び出しは `work_record` で書きます。agent は `WorkStore` と `ToolRegistry` を import しません。テストが見張ります。

投影は client が組み立てます。session の中にイベントの配列を持ち、記録した順に並べて `buildProjection` に渡します。Runtime にある記録が原本で、メモリ上の配列はその写しです。作業の Work を閉じたら、その Work の中で得た Tool の結果は「省略」の 1 行に畳み、summary だけを会話に残します。長い会話でファイルの中身が context に溜まらないためです。

`work_create` の `parent` と `agent_name` は loop が必ず付けます。モデルに会話の id を覚えさせません。ターンが Work の中で止まったとき(中断、質問の取り下げ、上限)は、Work をそのままにして接続の現在の Work を会話に戻し、止まった Work の id を `TurnResult.work` で返します。次に続けるかは `/work resume` の候補として人とモデルが決めます。候補は `prompt.expanded` として記録し、投影では user message になります。`work_select` した Work が質問を待っていれば、loop が古い順に人に聞いて `work_answer` します。候補は次の 1 ターンだけ有効で、ターンが終われば(続けても続けなくても)消えます。モデルが loop の道具(`work_record`、`work_answer`)や、作業の Work が無いのに `work_complete` を呼んだときは、Runtime に渡さず拒否の結果を返します。会話の Work を閉じる経路をモデルに与えないためです。Work ごとのモデル呼び出しの上限は呼ぶ前に確かめ、`work_select` のときは `history` の件数から数え直します。

理由。Runtime の Tool の面を MCP の 1 つにすると、Authority と ChangeSet を置く場所が 1 か所になり、CLI だけが使う経路が構造上できません。Claude Code と対話型 CLI は同じ規則で同じ Tool を使います。

捨てた案。CLI だけがプロセス内で `WorkStore` に書く案(面が 2 つになる)。子 Work を別の loop に回す `work_run`(Runtime にモデルが要る)。作業の隔離は client 側のサブエージェントに任せます。

## セッションは Work の上に載る

決めたこと。`createSession` は `work_create` で `type: session` の Work を開き、`turn(text)` ごとに人の発言(`human.message`)を `work_record` で記録して社員エージェントの model を回します。社員エージェントの道具は Runtime の MCP Tool そのものです。1 ターンの上限は model 25 回、Tool 40 回で、超えたらターンを打ち切って人に返します。作業の Tool 呼び出しもターンの中で起きるので、v0.1 の 5 回と 10 回より大きい値です。Ctrl-C は作業の Work を `in_progress` のまま止め、後で `/work resume` の候補にできます。`session` の Work の中では Tool を呼べません。投影は type で振る舞いを変える(objective を入れない)ので、model や外のエージェントが選べる値に置きません。

理由。会話の記録と作業の記録を分けたまま、1 つの loop で回します。上限をターン単位にしたのは、会話全体に上限を置くと長い会話が途中で死ぬからです。人が居るので止められます。

名前。セッションを開くたびに、設定の `company.language` に合わせた一覧(日本語はかなの名、英語は英語の名、30 ずつ。どちらも自然の語からきた名で、特定の人を指しません)から 1 つ選び、`work.created` の `agent_name` に残します。言語を OS ではなく設定から取るのは、会社の記録が機械をまたいで同じであるためで、`openshain init` が OS の locale を初期値の参考にするだけです。子 Work にも同じ名前を渡すので、質問のときも同じ名で話します。開いているセッションが使っている名前は避けます。設定や職種に名前を置かないのは、同じ職種のセッションを並行して開けるからで、model に選ばせないのは、呼び出しが 1 回増えるうえ、投影は記録から組み立てるので結局記録に残す必要があり、実在の人名を選ぶ危険も避けにくいからです。記録にあるので、セッションの再開(未実装)でも同じ名前で続けられます。

## `ask_user` は Runtime の Tool

質問は Work の状態(`waiting_input`)に直結するので、Tool provider に任せず Runtime が持ちます(mcp のノート)。loop は `pending` の結果を受け取ると人に聞き、答えを `work_answer` で記録してから model に渡します。Claude Code のように自分で人に聞く client は `ask_user` を呼ばなくてよく、どちらでも Runtime の記録の形は同じです。

## 公開 API

`connectInMemory`、`wrap`、`createSession`、`TURN_LIMITS`、`AGENT_NAMES`、`pickAgentName`、provider の factory と class です。loop の内部の関数は公開しません。Runtime の側の助け(`ASK_USER`、`pendingQuestions`、`countToolCalls`、`workHistory`)は core にあります。
