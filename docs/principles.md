# 設計原則

openshain が判断に迷ったときに立ち返るもの。README には利用者が選ぶ判断に要る 4 つだけを載せ、全文はここに置く。

| 項目 | 意味 |
|---|---|
| Work, not answers | 業務の完了まで進める |
| Profession, not prompts | 専門職は職務、手順、権限、知識の束として定義する |
| Existing SaaS remains the system of record | 既存の SaaS をそのまま使う |
| Progressive automation | API がなくても働ける。API があればもっと働ける |
| Need-to-Know before retrieval | 知らなくてよい情報は LLM に渡さない |
| Agent acts on behalf of a principal | Agent は誰かの代理として、委任された権限の範囲で動く |
| Know when not to act | 止まれることは能力 |
| Knowledge is authored, compiled, executed | Knowledge は人が書き、build し、Runtime が使う |
| Open by default | Model、Knowledge、Expert、Profession、Tool を交換できる |
| Official has no hidden privilege | 公式実装と第三者実装は同じインターフェースを使う |
| Paid means easiest | 有償版が引き受けるのは運用。機能の解禁ではない |
