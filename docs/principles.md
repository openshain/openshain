# 設計原則

openshain が判断に迷ったときに立ち返るものです。README には利用者が選ぶ判断に要る 4 つだけを載せ、全文はここに置きます。

文中の語について。公式実装は openshain 自身が作る Tool、model provider、入口(CLI、MCP)で、第三者実装は他の人が同じインターフェースで作るものです。有償版は、openshain を会社に代わって動かし続ける有償のサービスを指します。まだ提供していませんが、原則は先に決めてあります。

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
