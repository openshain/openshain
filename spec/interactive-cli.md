# Spec: 対話型 CLI(セッション)

Status: v0.2(実装済み。v0.2 は Runtime からモデルを外し、対話型 CLI を Runtime の client の 1 つにする改訂です。差分は「v0.2 で変わること」の節にまとめています)

## 目的

`openshain` と実行すると、会社の社員エージェントと話せます。話の中で作業が生じたら、社員エージェントは Work を作って進め、結果を返します。人は同じ画面で Work の進捗を確認して、質問に答え、続きを依頼します。

証明したいこと。会話と作業を分けたまま、1 つの画面で回せることです。会話はセッションの記録に、作業は Work の記録に残り、どちらも後から読めます。

v0.2 で加わる証明。対話型 CLI は Runtime の client の 1 つで、Claude Code や Codex と同じ Runtime Tool を同じ規則で使います。Runtime はモデルを呼びません。モデルを持つのは client です。

## v0.2 で変わること

- 社員エージェントは自分で `work_create` し、Runtime Tool(`fs_*`、`csv_*`、`markdown_read`)を呼び、`work_complete` します。子 Work を別の loop に回す `work_run` は無くなります。作業の隔離が要るときは、client 側のサブエージェント(Claude Code などが持つ機能)で行い、Runtime には持ち込みません
- 対話型 CLI のモデルの loop は、MCP の in-memory transport で自分の MCP server に接続し、MCP client として Runtime を使います。Runtime の Tool の面は MCP の 1 つだけで、CLI だけが使う経路はありません
- `openshain run` と `openshain work resume` は無くなります。止まった Work は会話の中で `/work resume <id>` で名指しして続けます
- `openshain.yaml` の `model` は任意になります。無ければ対話型 CLI は「モデルが要ります」と止まり、`openshain mcp`、`work list`、`work show`、`tools list` は動きます。Claude Code や Codex から使う人は、モデルも API キーも設定しません
- 端末なしで Work を進める手段(cron、CI)はこの版にありません。Observation から作られた Work を進める worker は、client の 1 つとして後の版で足します

### やらないこと

- 閉じたセッションの再開。記録は残りますが、続きは新しいセッションで話します
- Work の外でファイルを読む、書くこと。Runtime は現在の Work がない Tool 呼び出しを受け付けません
- 承認、権限、複数人
- MCP 経由のセッション。外部のエージェントは自分の会話を持ちます
- 端末の外への通知
- 端末なしの実行(cron、CI、Observation からの Work を進める worker)

## 用語

- セッション: 人と社員エージェントの 1 回の会話です。`type: session` の Work として記録します。objective は `会話` です
- 社員エージェント: セッションで人と話す model です。profession の指示を持ちます
- 作業の Work: 社員エージェントが `work_create` で作る Work です。`work.created` の `parent` にセッションの Work id を持ちます。作業の Tool 呼び出しはこの Work に記録されます
- client: Runtime を MCP の Tool で使うプログラムです。Claude Code、Codex、そして対話型 CLI です。モデルを持つのは client で、Runtime は持ちません
- 名前: 社員エージェントがそのセッションで名乗る名前です。セッションを開くときに、製品が同梱する名前の一覧(`company.language` の言語。日本語と英語に 30 ずつ。自然の語からきた名で、特定の人を指しません)から選び、開いているセッションが使っている名前は避けます。`work.created` の `agent_name` に残り、子 Work も同じ値を持ちます。セッションを再開したときは記録の名前をそのまま使います(再開は未実装)。職種や設定に紐づく名前ではありません。同じ職種のセッションを並行して開けるからです

## 記録

- セッションは `work/<id>/events.jsonl` に、Work と同じ envelope で残ります。client が `work_create` に `type: session` を渡して開きます
- イベント `human.message`(payload は `text`)は人の発言で、投影では user message になります
- `work.created` の payload の任意の `parent`(親 Work の id)は、`work_create` の `parent` から入ります
- 社員エージェントの返答(`model.requested`、`model.completed`)、使用量(`usage.recorded`、kind は `model_inference`)、人の発言(`human.message`)、prompt コマンドの展開(`prompt.expanded`)は、client が Runtime Tool `work_record` でセッションの Work に書きます。Runtime は envelope(id、seq、時刻)を付け、payload を schema で検証します。作業の Work にもモデルの呼び出しと使用量を同じ Tool で書き、Work ごとの費用が合計できます。Claude Code のように書かない client もあり、その Work の使用量は Tool 実行の分だけになります
- 作業の Tool 呼び出し(`tool.called`、`tool.completed`、`tool.rejected`)は、client がどれであっても Runtime が作業の Work に記録します
- セッションの終了は `work.completed`(summary は `会話を終了`)です。端末が閉じたとき(SIGHUP)と停止の信号(SIGTERM、SIGINT)では、動いている Work を止めてから閉じて終わります。それ以外でプロセスが落ちたセッションは `in_progress` のまま残ります

## 社員エージェントの道具

Runtime の MCP Tool そのものです(open-runtime.md の MCP Server の節)。社員エージェントに固有の道具はありません。

| name | 使い方 |
|---|---|
| `work_create` | 依頼を Work にします。objective は人の言葉で書き、会話で分かった前提を添えます。`parent` にセッションの id を渡します |
| `work_select` | 止まっている Work を現在の Work にして続けます |
| `work_get`、`work_list` | 過去の作業に答えます。`work_get` は `history: true` でこれまでの Tool 呼び出しと未回答の質問を返します |
| 登録された Tool | 現在の Work の中で、ファイルを読み書きし、集計します。現在の Work がなければ Runtime が受け付けません |
| `ask_user` | 人に聞かないと進めないとき。Runtime が質問を記録して Work を `waiting_input` にし、client が人に聞きます。答えは `work_answer` で記録されます |
| `work_complete`、`work_fail` | 作業を閉じます。summary は人の言葉で書きます |
| `work_record` | 会話と自分のモデルの呼び出しをセッションと作業の Work に記録します。CLI の loop が呼び、モデルには見せません |

ファイルの Tool を会話の Work(`type: session`)の中で呼ぶことはできません。Runtime が「セッションでは Tool を呼べない。`work_create` で作業の Work を作る」と拒否します。記録のない操作を作らないためです。

## 社員エージェントの振る舞い

- system prompt は投影と同じ system prompt(職種の指示、会社、principal、名前)に、社員エージェントの役割の段落を追加したものです。名乗るときは名前と、社員エージェントであることを言います。人と話します。作業が要るときは `work_create` で Work を作り、その中で Tool を呼び、終わったら `work_complete` します。objective と summary は人の言葉で書きます。件数、合計、検索の結果は Tool が返した値のまま書き、計算し直しません。返答は端末に表示されるので Markdown の記法と絵文字は使いません
- 会話の投影は client(CLI の loop)が組み立てます。セッションの Work の記録から作り、作業の Work の中で得た Tool の結果は、その Work を閉じた後は要約(`work_complete` の summary)だけを会話に残します。長い会話でファイルの中身が context に溜まらないためです
- 1 ターン(人の発言から次の返答まで)の上限は model 呼び出し 25 回、Tool 呼び出し 40 回です。作業の Tool 呼び出しもこのターンの中で起きるので、v0.1 より大きい値です。投影の末尾の残り回数の行はこの値を表示します。超えたらそのターンを打ち切り、人に知らせ、セッションは続きます。作業の Work には `limits` の `max_tool_calls` を Runtime が数えます。`max_model_calls` は client が Work ごとに数え、超えたら `work_fail`(limit_reached)します
- `ask_user` の結果が pending なら、client は人に質問を表示し、答えを `work_answer` で記録してから続けます。Ctrl-C で質問を取り下げると Work は `waiting_input` のまま残ります
- `/work resume <id>` で名指しされた Work は、人の次の依頼がその Work の objective に沿うときだけ `work_select` して続けます。沿わなければ、その旨を伝えたうえで新しい Work を作るか、`work_list` で探し直します。名指しは候補であって命令ではなく、次の 1 ターンだけ有効です
- モデルが `work_record` と `work_answer` を呼ぶこと、作業の Work が無いのに `work_complete` や `work_fail` を呼ぶことは、loop が Runtime に渡さずに拒否します。会話の Work を閉じたり偽の記録を書いたりする経路をモデルに与えません
- 社員エージェントの model は設定の `model` です。使用量はセッションと作業の Work に `work_record` で記録され、`work show` で合計が表示されます

## 画面

- `openshain`(引数なし)で、stdin と stdout が端末なら対話を始めます。端末でなければ今までどおり使い方を表示します
- Ink で端末の全画面(alternate screen)に描きます。上から、見出し行(openshain、会社名、社員エージェントの名前、model)、会話、入力欄(枠つき)、状態行(進行中の Work、セッションの使用量。作業中は回る印)です
- 開いたとき、会話の先頭に openshain のロゴ(`oh-my-logo` の chrome 書体と grad-blue の配色を埋め込んだもの)、`openshain <version>`、会社フォルダの path を表示します。会話が進むと上に流れます
- 会話は、人の発言(`> `)、社員エージェントの返答(`⏺ `)、作業の Work の進捗行と締めの行(`⎿ `。Tool 呼び出し、状態、書いたファイル、使用量。要約は社員エージェントが伝えます)、注意(`! `)、質問(`? `)を、画面の幅で折り返して並べます。塊の間に空行を 1 つ置きます。新しい行が下に追加され、収まらない分は上に消えます
- 会話は画面の中でスクロールします。マウスホイールで 3 行、PageUp と PageDown で 1 画面です。端末にマウスの報告(SGR)を求めるので、ホイールが矢印と区別できます。その代わり文字の選択は多くの端末で Shift を押しながらになります。上を見ている間は状態行にその旨を表示し、発言を送ると最新に戻ります
- 上下の矢印は入力履歴です。前に送った行を新しい順に入力欄へ呼び戻し、いちばん下に戻ると打ちかけの文(なければ空)に戻ります。履歴はそのセッションの間だけ持ちます
- 入力欄は 1 行で、その場で編集できます。左右の矢印と Home と End(Ctrl-A と Ctrl-E も)でカーソルが動き、文字はカーソルの位置に入ります。Backspace はカーソルの前、Delete はカーソルの位置、Ctrl-U はカーソルの前すべて、Ctrl-K は後ろすべてを削除します。貼り付けた文に改行が含まれていれば、最初の改行までを送り、残りは入力欄に残します
- 終了すると元の画面に戻り、会話は端末に残りません。記録の読み方(`openshain work show <セッションの id>`)を 1 行表示します
- スラッシュコマンドは次の節のとおりです
- Ctrl-C は、社員エージェントのターンが動いていれば中断します。作業の Work があれば `in_progress` で残り、`/work resume` で続けます。質問を待っていれば質問を取り下げます(Work は `waiting_input` で残ります)。動いていなければセッションを閉じます
- 文言は日本語です。CLI の既存の表を使います。注意の行と質問には色を付けます

## スラッシュコマンド

2 種類あります。

- 組み込みコマンド。CLI が解釈し、model を通しません。記録の状態を変えるものは引数を正確に取ります。`/work list`、`/work show <id>`、`/work resume <id>`(止まった Work を候補として社員エージェントに渡します。次の依頼がその Work に沿えば `work_select` して続き、質問は画面で答えます)、`/tools`、`/help`、`/quit` です。`/resume <セッションの id>` はセッションの再開のために空けてあり、今はその旨を返します
- prompt コマンド(未実装)。`/{名前} {文}` の形で、`{文}` は自由な文です。CLI は `{名前}` に対応する prompt の本文と `{文}` を社員エージェントに渡し、何をするかは model が決めます。Claude Code の custom command や Agent Skills と同じ形です

prompt コマンドの出どころは 3 つです。

| 出どころ | 名前 | `{文}` の渡し方 |
|---|---|---|
| 職種 Pack のスキル | Pack が決めた名前 | 本文の `$ARGUMENTS` に入れます |
| workspace の `skills/<名前>/SKILL.md`(Agent Skills の形式) | ディレクトリ名 | 本文の `$ARGUMENTS` に入れます |
| MCP server の prompt | `{server}:{prompt}` | 宣言された引数に語順で当て、server が展開した文を渡します |

- 組み込みと同じ名前の prompt コマンドは読み込まず、起動時に注意を表示します。出どころをまたいで同じ名前があれば、上の表の順で先のものを使います
- `/help` は組み込みの後に prompt コマンドを出どころつきで並べます
- 記録には、人が打った行を `human.message` で残し、展開して model に渡した文を新しいイベント `prompt.expanded`(payload は name、source、text)で残します。投影は `prompt.expanded` の text を user message にします
- `skills/` は Runtime の予約パスにし、Tool からは読み書きできません。model が自分のスキルを書き換える経路を作らないためです

## 設定

`model` が任意になります。無いときは `openshain` が「対話にはモデルが要ります」と止まり、他のコマンドは動きます。`limits` の `max_tool_calls` は Runtime が作業の Work ごとに数え、`max_model_calls` は client が数えます。

## 配布

`bun run build` は `scripts/build.ts` になります。Ink が開発時にだけ読む `react-devtools-core` を空のモジュールに差し替えてから compile します。npm から入れるときはその差し替えは要りません。

## 完了の条件

v0.1 の条件 1 から 7 は満たしています。v0.2 の条件です。

1. `openshain` で対話が始まり、「receipt/2026-07.csv を category ごとに集計して」と実行すると作業の Work ができ、Tool 呼び出しが進捗として表示され、結果が返ります。Work の `parent` がセッションを指し、Tool 呼び出しはその Work に記録されます
2. `ask_user` の質問に画面で答え、答えが `work_answer` で Work の記録に入ります
3. Ctrl-C で作業が中断され、`/work resume <id>` の後の依頼で `work_select` されて続きます。objective に沿わない依頼では続けず、新しい Work を作るか探し直します(fake model で両方を再現します)
4. `work show <セッションの id>` で会話の使用量の合計が表示され、記録から会話を並べ直せます。作業の Work にもモデルの使用量が記録されます
5. 対話型 CLI の loop が Runtime を呼ぶ経路が MCP client だけであることをテストで確かめます。`@openshain/agent` が `WorkStore` と `ToolRegistry` を import しません
6. `model` の無い `openshain.yaml` で `openshain mcp`、`work list`、`work show`、`tools list` が動き、`openshain` はモデルが要る旨で止まります
7. `openshain run` と `openshain work resume` は無く、`bun test` の全体と単体バイナリでの対話(擬似端末)が通ります

## 未決

- セッションの再開(`/resume <セッションの id>` を予定)と、複数のセッションを並べる形
- 質問待ちや完了を端末の外へ知らせる形
- 端末なしで Work を進める worker(client の 1 つ)。Observation から作られた Work を進めるために後の版で足します
