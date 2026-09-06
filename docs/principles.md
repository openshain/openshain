# 設計原則

openshain が判断に迷ったときに立ち返るものです。README には利用者が選ぶ判断に要る 4 つだけを載せ、全文はここに置きます。

文中の語の意味です。公式実装は openshain 自身が作る Tool、model provider、入口(CLI、MCP)で、第三者実装は他の人が同じインターフェースで作るものです。有償版は、openshain を会社に代わって動かし続ける有償のサービスを指します。まだ提供していませんが、原則は先に決めてあります。

| 項目 | 意味 |
|---|---|
| Work, not answers | 業務の完了まで進めます |
| Profession, not prompts | 専門職は職務、手順、権限、知識の束として定義します |
| Existing SaaS remains the system of record | 会社の記録の原本は、いま使っている会計ソフトや SaaS、台帳のままです。openshain はそれを読み書きする側で、記録の置き場を新しく作りません。自分で持つのは作業の記録(`work/`)だけです |
| Progressive automation | API がなくても働けます。API があればもっと働けます |
| Need-to-Know before retrieval | 知らなくてよい情報は LLM に渡しません |
| Agent acts on behalf of a principal | エージェントは誰かの代理として、委任された権限の範囲で動きます |
| Know when not to act | 止まれることは能力です |
| Knowledge is authored, compiled, executed | Knowledge は人が書き、build し、Runtime が使います |
| Open by default | Model、Knowledge、Expert、Profession、Tool を交換できます |
| Official has no hidden privilege | openshain 自身が作る Tool、model provider、入口も、第三者が作るものと同じインターフェースを通ります。core に自分たち向けの裏口を作りません |
| Paid means easiest | OSS だけで主要な用途を完了できます。有償で提供するものがあるなら、それは運用の肩代わりで、機能の解禁ではありません |

## 会社の日常運営へ広げる原則

人に指示されてから働くだけでなく、会社で起きたことを観測して自分から仕事を始め、必要なときだけ人を呼ぶ形へ広げるときの原則です。いまの版にはまだ実装がありませんが、方針として先に置きます。

| 項目 | 意味 |
|---|---|
| Ambient, not always thinking | 常時 LLM を動かすのではなく、常時観測できる Runtime にします |
| Event to Work | 依頼されたときだけでなく、観測した出来事から仕事が始まります |
| Attention is a cost | 人の時間と注意力も、エージェントが消費するコストとして数えます |
| Notify only by exception | 対応の要らない進捗を大量に通知しません。知らせるのは判断、承認、失敗、期限の危険です |
| Mobile is for supervision | スマートフォンではエージェントそのものを操作するのではなく、会社の Work を監督し、例外を処理します |
| Control Work, not sessions | 止める、続ける、承認する対象はエージェントのセッションではなく Work です |
| Authority on device | 重要な権限の行使には、本人の端末を信頼できる場として使います |
| Open control plane | 遠隔から統制するための protocol も、有償サービスに閉じ込めません |
| Bring your own capability | ブラウザ操作などの実装は利用者が自由に選べます |
| Own governance, not browser engines | 手足そのものより、手足をいつ、誰が、何のために使えるかを管理します |
| Progressive capability fallback | API がなければブラウザ、ブラウザがなければ Office や CSV、それでも無理なら人に渡します |
