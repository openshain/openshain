# `@openshain/agent` の設計

agent は tool loop と、model provider の実装 2 つ(Anthropic、OpenAI 互換)を持つ。core の上に載り、CLI が使う。MCP Server は外部のエージェントが考えるので、この loop を使わない。

## loop はイベントログの上の状態機械

決めたこと。投影を組み立てる、model を呼ぶ、記録する、Tool を実行する、記録する、先頭へ戻る。どの一歩も、記録してから次へ進む。メモリ上に会話の配列を持たない。

理由。途中で落ちても、記録がどこまで起きたかを語る。再開は記録から始まり、会話の配列を復元する手順が要らない。

捨てた案。メモリ上の配列を回して最後にまとめて保存する。落ちた瞬間に Work が消える。

## 1 ターンの規則

- 1 つの応答に複数の tool_call があれば順に実行し、結果はまとめて 1 つの user message で返す。分けて返すと model が並列に呼ばなくなる。
- 同じターンの中で call id が重複したら model の誤りとして止める。前のターンの id を使い回すサーバーはあるので、ターンをまたぐ重複は許す。
- `ask_user` は同じターンの他の Tool を先に実行してから記録し、Work は `waiting_input` になる。質問が複数あっても待つのは 1 回で、再開時に古い順に答える。

## 止まる条件と上限

Work が止まるのは、完了、質問、上限到達、model の refusal、回復できないエラーの 5 つ。上限(model の呼び出し回数、Tool の呼び出し回数、1 回の出力)は設定が持ち、回数はイベントで数える。拒否された呼び出しも数える。

毎ターンの末尾に残りの回数を 1 行で見せる。model が残量を知って畳めるようにするため。system prompt にはこの行が通知で返事は要らないと書いてある。書かないと model が返事をした。

捨てた案。上限に達したら黙って切る。model は畳む機会を失い、利用者は途中の出力しか受け取れない。

## 再開は記録の整合から

`in_progress` のまま止まった Work を続けるときは、直前の model のターンで結果のない Tool 呼び出しに「途中で止まった」という失敗の結果を先に記録する。答えのない質問が残っていれば `waiting_input` として扱う。前のターンより古いイベントは見ない。

理由。投影の規則(tool_call は次の message までに結果を持つ)を満たさないログは model に渡せない。満たさないまま続けるより、閉じてから続けるほうが、model にも人にも何が起きたかが見える。記録そのものが矛盾していれば `corrupt_log` で止め、勝手に直さない。

## provider はインターフェースに揃える

決めたこと。provider は各社の公式 SDK を使い、message、stop reason、usage、エラーの code をインターフェースの形に揃える。provider 固有の指定(thinking、effort、temperature)は `providerOptions` に入れてそのまま渡し、インターフェース側で共通化しない。model、messages、tools、出力の上限、stream しないことは Runtime が決め、`providerOptions` で上書きできない。

usage の `inputTokens` は入力の全部で、prompt cache から読んだ分と書いた分を含む。provider によって生の値の意味が違うので、揃えるのは provider の仕事。Runtime は `stableMessages`(次のターンも変わらない message の数)を渡す。Anthropic の provider はそこに cache の切れ目を置き、OpenAI 互換の provider は接頭辞の自動一致に任せて使わない。

エラーは code に写す。認証は `auth`、上限超過は `rate_limit`、設定の誤り(model 名、URL)は `config`、接続と 5xx は `network`、形が読めない応答は `invalid_response`。Runtime は code で分岐し、利用者向けの文言は CLI が持つ。

理由。インターフェースは 1 つで、差は provider の中に閉じ込める。差をインターフェースに吸い上げると、provider を足すたびにインターフェースが変わる。

捨てた案。

- vendor 横断の SDK を adapter として挟む。インターフェースが二重になり、差分の吸収先がどちらか分からなくなる。
- streaming。Work の進捗は Tool の行で足りる。途中の文字列を見せる価値より、記録の単純さを取った。
- provider ごとに会話の形式を保存する。model を替えたときに読めなくなる。

## セッションは Work の上に載る

決めたこと。`createSession` は `type: session` の Work を開き、`turn(text)` ごとに人の発言(`human.message`)を記録して担当の model を回す。担当の道具は `work_run`、`work_list`、`work_show` で、`work_run` は子 Work を作って `runWork` で進める。1 ターンの上限は model 5 回、道具 10 回で、超えたらターンを打ち切って人に返す。Ctrl-C は子 Work を `in_progress` のまま止め、後で `resume` できる。`session` は予約した type で、`work_run`、MCP の `work_create`、`runWork` は受け付けない。投影は type で振る舞いを変える(objective を入れない)ので、model や外のエージェントが選べる値に置かない。

理由。担当の loop と Work の loop を分けると、作業の記録は Work に閉じ、担当は会話だけを持つ。上限をターン単位にしたのは、会話全体に上限を置くと長い会話が途中で死ぬから。人が居るので止められる。

## `ask_user` は Runtime の Tool

質問は Work の状態(`waiting_input`)に直結するので、Tool provider に任せず Runtime が持つ。provider は `runtime`、名前は予約。入力は他の Tool と同じく schema で検証し、外れたら同じターンで拒否を返し、待たない。MCP では登録しない。外部エージェントが利用者に聞くから。

## 公開 API

`runWork`、`ASK_USER`、`pendingQuestions`、`countToolCalls`、`FailureReason`、provider の factory と class。loop の内部の関数は出さない。
