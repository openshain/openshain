# 設計原則

openshain が判断に迷ったときに立ち返るものです。README には利用者が選ぶ判断に要る 4 つだけを載せ、全文はここに置きます。

| 項目 | 意味 |
|---|---|
| Work, not answers | 業務の完了まで進めます |
| Profession, not prompts | 専門職は職務、手順、権限、知識の束として定義します |
| Existing SaaS remains the system of record | 既存の SaaS をそのまま使います |
| Progressive automation | API がなくても働けます。API があればもっと働けます |
| Need-to-Know before retrieval | 知らなくてよい情報は LLM に渡しません |
| Agent acts on behalf of a principal | エージェントは誰かの代理として、委任された権限の範囲で動きます |
| Know when not to act | 止まれることは能力です |
| Knowledge is authored, compiled, executed | Knowledge は人が書き、build し、Runtime が使います |
| Open by default | Model、Knowledge、Expert、Profession、Tool を交換できます |
| Official has no hidden privilege | 公式実装と第三者実装は同じインターフェースを使います |
| Paid means easiest | 有償版が引き受けるのは運用です。機能の解禁ではありません |
