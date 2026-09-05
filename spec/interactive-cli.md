# Spec: 対話型 CLI(セッション)

Status: v0.1(実装済み。完了の条件 1 から 7 を満たす)

## 目的

`openshain` と打つと、会社の事務担当と話せる。話の中で作業が出てきたら、担当は Work を作って進め、結果を返す。人は同じ画面で Work の進捗を見て、質問に答え、続きを頼む。

証明したいこと。会話と作業を分けたまま、1 つの画面で回せること。会話はセッションの記録に、作業は Work の記録に残り、どちらも後から読める。

### やらないこと

- 閉じたセッションの再開。記録は残るが、続きは新しいセッションで話す
- 担当が会社のファイルを直接読む、書く。すべて Work の中の Tool で行う
- 承認、権限、複数人
- MCP 経由のセッション。外部の Agent は自分の会話を持つ
- 端末の外への通知

## 用語

- セッション: 人と担当の 1 回の会話。`type: session` の Work として記録する。objective は `会話`
- 担当: セッションで人と話す model。profession の指示を持つ
- 子 Work: 担当が `work_run` で作る Work。`work.created` の `parent` にセッションの Work id を持つ

## 記録

- セッションは `work/<id>/events.jsonl` に、Work と同じ envelope で残る
- 新しいイベント `human.message`。payload は `text`。人の発言で、投影では user message になる
- `work.created` の payload に任意の `parent`(親 Work の id)を足す。無ければ今までどおり
- 担当の返答は `model.completed`、担当の道具の呼び出しは `tool.called` と `tool.completed`(provider `runtime`)、使用量は `usage.recorded`。すべて既存の形
- セッションの終了は `work.completed`(summary は `会話を終了`)。端末が閉じたとき(SIGHUP)と停止の信号(SIGTERM)でも閉じてから終わる。それ以外でプロセスが落ちたセッションは `in_progress` のまま残る

## 担当の道具

Runtime が提供する。名前は予約で、Tool provider は同じ名前を登録できない。

| name | effect | 内容 |
|---|---|---|
| `work_run` | mutate | objective(人の言葉で書き、会話で分かった前提を添える)と type を受け、Work を作って完了か停止まで進める。返すのは status、summary、artifacts、使用量、失敗の理由、質問待ちならその質問と Work id |
| `work_list` | observe | 最近の Work の id、status、objective、作成時刻。セッションは除く |
| `work_show` | observe | id を受けて、要約、成果物、使用量、次に動くのが誰か |

担当はファイルの Tool を持たない。記録のない操作を作らないため。子 Work の中では担当の道具は出ない。

## 担当の振る舞い

- system prompt は Work の投影と同じ system prompt(職種の指示、会社、principal)に、担当の役割の段落を足す。人と話す。作業は `work_run` に出す。objective は人の言葉で書き、前提を添える。ファイルは自分で触らない。結果は要約して伝える
- 1 ターン(人の発言から次の返答まで)の上限は model 呼び出し 5 回、道具の呼び出し 10 回。投影の末尾の残り回数の行はこの値を出す。超えたらそのターンを打ち切り、人に知らせ、セッションは続く。セッション全体には回数の上限を置かない。人が居るので止められる
- 子 Work の質問(`ask_user`)は人に直接出し、答えは子 Work の記録に入る。担当は関与しない
- 子 Work の上限は設定の `limits` どおり。子 Work の進捗は画面に流す
- 担当の model は設定の `model`。使用量はセッションの Work に記録され、`work show` で合計が出る

## 画面

- `openshain`(引数なし)で、stdin と stdout が端末なら対話を始める。端末でなければ今までどおり使い方を出す
- Ink で描く。上から、会話(人の発言、担当の返答、子 Work の進捗行と結果、質問)、状態行(会社名、model、進行中の Work、セッションの使用量)、入力欄
- スラッシュコマンド。`/work list`、`/work show <id>`、`/resume <id>`(止まった Work を続ける。質問は画面で答える)、`/tools`、`/help`、`/quit`
- Ctrl-C。子 Work が動いていれば中断する(Work は `in_progress` で残り、`/resume` で続く)。動いていなければセッションを閉じる
- 文言は日本語。CLI の既存の表を使う。注意の行と質問には色を付ける

## 設定

追加しない。`limits` は子 Work に効く。

## 配布

`bun run build` は `scripts/build.ts` になる。Ink が開発時にだけ読む `react-devtools-core` を空のモジュールに差し替えてから compile する。npm から入れるときはその差し替えは要らない。

## 完了の条件

1. `openshain` で対話が始まり、「receipt/2026-07.csv を category ごとに集計して」と打つと子 Work ができ、進捗が出て、結果が返る。子 Work の `parent` がセッションを指す
2. 子 Work の質問に画面で答えられ、答えが子 Work の記録に入る
3. Ctrl-C で子 Work が中断され、`/resume <id>` で続く
4. `work show <セッションの id>` で会話の使用量の合計が出て、記録から会話を並べ直せる
5. 担当がファイルの Tool を持たないことをテストで確かめる
6. 1 から 5 を `bun test` で再現する。model は fake、画面は ink-testing-library
7. `bun run build` の単体バイナリで対話が動く。擬似端末で確かめる

## 未決

- セッションの再開と、複数のセッションを並べる形
- 質問待ちや完了を端末の外へ知らせる形
