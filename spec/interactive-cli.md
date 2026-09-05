# Spec: 対話型 CLI(セッション)

Status: v0.1(実装済み。完了の条件 1 から 7 を満たしています)

## 目的

`openshain` と打つと、会社の社員エージェントと話せます。話の中で作業が出てきたら、社員エージェントは Work を作って進め、結果を返します。人は同じ画面で Work の進捗を見て、質問に答え、続きを頼みます。

証明したいこと。会話と作業を分けたまま、1 つの画面で回せることです。会話はセッションの記録に、作業は Work の記録に残り、どちらも後から読めます。

### やらないこと

- 閉じたセッションの再開。記録は残りますが、続きは新しいセッションで話します
- 社員エージェントが会社のファイルを直接読む、書くこと。すべて Work の中の Tool で行います
- 承認、権限、複数人
- MCP 経由のセッション。外部のエージェントは自分の会話を持ちます
- 端末の外への通知

## 用語

- セッション: 人と社員エージェントの 1 回の会話です。`type: session` の Work として記録します。objective は `会話` です
- 社員エージェント: セッションで人と話す model です。profession の指示を持ちます
- 子 Work: 社員エージェントが `work_run` で作る Work です。`work.created` の `parent` にセッションの Work id を持ちます

## 記録

- セッションは `work/<id>/events.jsonl` に、Work と同じ envelope で残ります
- 新しいイベント `human.message` を足します。payload は `text` です。人の発言で、投影では user message になります
- `work.created` の payload に任意の `parent`(親 Work の id)を足します。無ければ今までどおりです
- 社員エージェントの返答は `model.completed`、社員エージェントの道具の呼び出しは `tool.called` と `tool.completed`(provider `runtime`)、使用量は `usage.recorded` です。すべて既存の形です
- セッションの終了は `work.completed`(summary は `会話を終了`)です。端末が閉じたとき(SIGHUP)と停止の信号(SIGTERM、SIGINT)では、動いている Work を止めてから閉じて終わります。それ以外でプロセスが落ちたセッションは `in_progress` のまま残ります

## 社員エージェントの道具

Runtime が提供します。名前は予約で、Tool provider は同じ名前を登録できません。

| name | effect | 内容 |
|---|---|---|
| `work_run` | mutate | objective(人の言葉で書き、会話で分かった前提を添える)と type(`session` 以外)を受け、Work を作って完了か停止まで進めます。返すのは status、summary、artifacts、使用量、失敗の理由、質問待ちならその質問と Work id です |
| `work_list` | observe | 最近の Work の id、status、objective、作成時刻を返します。セッションは除きます |
| `work_show` | observe | id を受けて、要約、成果物、使用量、次に動くのが誰かを返します |

社員エージェントはファイルの Tool を持ちません。記録のない操作を作らないためです。子 Work の中では社員エージェントの道具は出ません。

## 社員エージェントの振る舞い

- system prompt は Work の投影と同じ system prompt(職種の指示、会社、principal)に、社員エージェントの役割の段落を足したものです。人と話します。作業は `work_run` に出します。objective は人の言葉で書き、前提を添えます。ファイルは自分で触りません。ファイルの中身を見ないと答えられない質問も Work にして調べます。結果は要約して伝えます。件数や金額は Work の結果の数字のまま書き、計算し直しません。返答は端末に出るので Markdown の記法と絵文字は使いません
- 1 ターン(人の発言から次の返答まで)の上限は model 呼び出し 5 回、道具の呼び出し 10 回です。投影の末尾の残り回数の行はこの値を出します。超えたらそのターンを打ち切り、人に知らせ、セッションは続きます。セッション全体には回数の上限を置きません。人が居るので止められます
- 子 Work の質問(`ask_user`)は人に直接出し、答えは子 Work の記録に入ります。社員エージェントは関与しません
- 子 Work の上限は設定の `limits` どおりです。子 Work の進捗は画面に流します
- 社員エージェントの model は設定の `model` です。使用量はセッションの Work に記録され、`work show` で合計が出ます

## 画面

- `openshain`(引数なし)で、stdin と stdout が端末なら対話を始めます。端末でなければ今までどおり使い方を出します
- Ink で描きます。上から、会話(人の発言、社員エージェントの返答、子 Work の進捗行と締めの行(状態、書いたファイル、使用量。要約は社員エージェントが伝えます)、質問)、状態行(会社名、model、進行中の Work、セッションの使用量)、入力欄です
- スラッシュコマンドは `/work list`、`/work show <id>`、`/resume <id>`(止まった Work を続けます。質問は画面で答えます)、`/tools`、`/help`、`/quit` です
- Ctrl-C は、子 Work が動いていれば中断します(Work は `in_progress` で残り、`/resume` で続きます)。子 Work が質問を待っていれば質問を取り下げます(Work は `waiting_input` で残り、`/resume` でもう一度聞きます)。`/resume` で動かしている Work も同じです。動いていなければセッションを閉じます
- 文言は日本語です。CLI の既存の表を使います。注意の行と質問には色を付けます

## 設定

追加しません。`limits` は子 Work に効きます。

## 配布

`bun run build` は `scripts/build.ts` になります。Ink が開発時にだけ読む `react-devtools-core` を空のモジュールに差し替えてから compile します。npm から入れるときはその差し替えは要りません。

## 完了の条件

1. `openshain` で対話が始まり、「receipt/2026-07.csv を category ごとに集計して」と打つと子 Work ができ、進捗が出て、結果が返ります。子 Work の `parent` がセッションを指します
2. 子 Work の質問に画面で答えられ、答えが子 Work の記録に入ります
3. Ctrl-C で子 Work が中断され、`/resume <id>` で続きます
4. `work show <セッションの id>` で会話の使用量の合計が出て、記録から会話を並べ直せます
5. 社員エージェントがファイルの Tool を持たないことをテストで確かめます
6. 1 から 5 を `bun test` で再現します。model は fake、画面は ink-testing-library です
7. `bun run build` の単体バイナリで対話が動きます。擬似端末で確かめます

## 未決

- セッションの再開と、複数のセッションを並べる形
- 質問待ちや完了を端末の外へ知らせる形
