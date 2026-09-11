# sample-company

架空の会社の会社フォルダです。決まりと資料の書き方を、そのまま写して使えるように置いています。実在の会社のデータは入っていません。

```
openshain knowledge check --workspace examples/sample-company    # 決まりと資料を検証する
openshain knowledge build --workspace examples/sample-company    # 索引を作る
openshain principal check bob --workspace examples/sample-company  # bob の範囲を確かめる
```

- `policies/expenses.md` は会社が持っている規程そのものです。openshain はこれを原本として扱い、書き換えません
- `knowledge/sources/expense-policy.md` はその規程を、出典と有効日を付けて引用したものです
- `knowledge/rules/expenses.yaml` は規程から起こした会社の決まりです。1 つの規程から複数の決まりを書けます
- `knowledge/build/` は `openshain knowledge build` が作ります。人は編集しません
- `principals/` は会社の人です。bob には `reads` を書いてあるので、bob の社員エージェントは `ledger/`、`receipts/`、`policies/` の中だけで働きます。alice には書いていないので、会社フォルダ全体です

自分の会社で始めるときは、`policies/` を自社の規程に置き換え、`knowledge/sources/` の front matter を書き換え、決まりは `openshain knowledge add` で 1 件ずつ追加します。
