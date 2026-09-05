# `openshain` CLI の設計

CLI は Runtime の参照実装のクライアント。汎用の Agent 製品ではない。MCP Server と同格の入口で、model は利用者の API キーで呼ぶ。

## 見せるのは進捗と結果だけ

決めたこと。`run` と `work resume` の進捗行は、Tool の呼び出し(名前と、path があればその値)、拒否(理由)、失敗の 3 種類だけ。model の呼び出しと質問の記録は出さない。最後に、状態、結果の要約、使用量の合計、次に動くのが誰か(利用者、model、なし)を出す。

理由。利用者が知りたいのは、何をしているか、何が終わったか、誰を待っているか。model の思考の垂れ流しは、読む時間を取るわりに判断に使えない。

捨てた案。streaming で model の出力を流す。進捗の代わりにはなるが、記録の単純さ(agent のノート)を優先した。

## 文言は表で持つ

状態、失敗の理由、拒否の理由、エラーの code の日本語は `labels.ts` の名詞句の表にある。code は英語のまま裏に残り、表にない語はそのまま表示する。文言の変更がロジックに触れないため。表示幅は文字幅で揃える。日本語は 1 文字が 2 桁分あり、`padEnd` では列が崩れる。

## exit code は 3 つ

0 は完了。1 は完了しなかった Work か実行時のエラー。2 は引数の誤り。シェルから成否を判定できるように。

## 端末がなければ質問しない

TTY がなければ `ask_user` に答えず、`waiting_input` のまま質問文を出して終わる。cron や CI から呼ばれた `run` が永遠に待たないため。答えは端末のあるところで `work resume` する。

## `--workspace` と探索

`init` は指定したディレクトリに `openshain.yaml` のひな型を書く。他のコマンドはそこから上に向かって `openshain.yaml` を探す。会社のフォルダのどこにいても同じ Work が見えるため。

## `init` は 4 つのファイルを書く

決めたこと。`openshain init` は `openshain.yaml` のほかに、Claude Code 用の `.mcp.json`、外部 Agent への指示の `AGENTS.md`、それを読ませる `CLAUDE.md` を書く。`openshain.yaml` があれば断り、他の 3 つは無いものだけ書く。

理由。Claude Code からの接続テストで詰まったのは、`.mcp.json` を手で書くことと、依頼文で自前の Tool を使わないよう言わないと Runtime を通らないことの 2 つだった。どちらも会社フォルダにファイルを 1 つ置けば済む。`.mcp.json` の command が `openshain` で済むのは、配布をバイナリにして PATH に置く形にしたから。

捨てた案。指示を `openshain.yaml` の `profession.instructions` に入れる。あれは Runtime が model に渡す文で、外部 Agent は読まない。

## `openshain mcp` を同梱する

MCP Server は別 package だが、起動は CLI のサブコマンド。インストールを 1 回で済ませるため。

## 捨てた案

- REPL(`openshain` と打つと会話が始まる)。Work は 1 つの依頼から始まり、状態は記録に残る。会話の継続はまだ要らない。
- 色付け。端末によって崩れ、テストが読みにくくなる。
- 使用量の金額換算。単価表を持つと保守が要り、vendor ごとに変わる。トークン数だけを出す。

## 公開 API

配布物は `openshain` コマンドだけ。コマンドの関数は bin とテストのために export しているが、import して使うインターフェースではない。予告なく変える。プログラムから使うなら core と agent を使う。
