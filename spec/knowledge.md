# Spec: Knowledge(会社の決まりと根拠の資料)

Status: 起案(未実装)

## 目的

社員エージェントが、会社の決まりと根拠の資料を、出典と有効日つきで引けるようにします。証明したいことは 4 つです。

1. 出典か有効日のない決まりは索引に入らないこと
2. 権限のない Principal では、該当の Source が検索結果にも件数にも現れないこと。索引を直接読む Tool でも同じこと
3. 索引が `rules/` と `sources/` と一致しないとき、知識をいっさい提供しないこと
4. 依頼の中で決まりを名指しされなくても、社員エージェントが自分で引いて、id と有効日を添えて答えること。該当する決まりが無いときは、無いと言うこと

知識は人が書き、`openshain knowledge build` が検証して索引にし、Runtime が Tool として使います。build を通らないファイルは社員エージェントから見えません。

### やらないこと(この版では)

- 埋め込みベクトルによる検索。この版は文字の重なりだけで探します
- 会社フォルダの外にある知識提供元への接続。この版が読むのは会社フォルダの中だけです
- 知識の自動更新。更新は人が資料を置き換えて build し直します
- 決まりの自動適用。知識は判断の材料で、実行してよいかの判定は `authority/` が行います(spec/authority.md)
- 会話だけで完結する結論の差し止め。「この支出は損金にできます」のような、資格者の判断に当たる答えを、コードで止める仕組みはこの版にありません。止められるのは外へ効果を出す呼び出しです。この限界は下の「資格者の領域」と SECURITY.md に明記します
- PDF と Office 文書の取り込み。この版は Markdown と YAML です
- 検索の実装を差し替えるためのインターフェース。実装が 2 つになるまで作りません(docs/design/core.md)

## 用語

- Source: 根拠の資料です。法令、通達、ガイドライン、社内規程、契約書など、出所のある文書 1 件を指します。`sources/` に置く内容は、原本そのものではなく、出典を明記した引用です。原本の置き場は会社がいま使っている場所のままです
- Rule: 会社の決まりです。1 文の主張と、その根拠になる Source を持ちます
- Provenance: その Source がどこから来たかです。発行者、場所、取得日、版
- 有効日: いつからいつまで有効かです。業務日で判定します
- Scope: 誰が読んでよいかです。Need-to-Know の単位になります
- Index: build の出力です。人も Tool も書きません

Rule と Source の id は人が書く文字列です。Work や Event の id(UUIDv7)とは別の系統で、branded type にはしません。

## Company Workspace への追加

```
<workspace>/
├── rules/                会社の決まり(人が書きます)
│   └── expenses.yaml
├── sources/              根拠の資料(人が置きます)
│   └── invoice-2023.md
└── build/                knowledge build の出力
    ├── manifest.json     入力のハッシュ、索引の形式の版、件数、build した時刻
    └── index.json        検索と読み取りが使う索引
```

`build/` は Runtime の予約パスに加えます(`packages/core/src/tool/paths.ts` の `RESERVED_PATHS`)。`rules/` と `sources/` は予約せず、Tool から読めます。3 つとも無い会社フォルダは、いまのとおり動きます。

### `rules/<name>.yaml`

```yaml
version: 1
rules:
  - id: expenses.receipt-required
    statement: 1 万円以上の経費には領収書の原本が要ります。
    aliases: [領収書, レシート, 証憑]
    applies_to: { profession: [generic, accounting] }
    scope: { visibility: company }
    effective_from: 2026-04-01
    effective_to: null
    supersedes: expenses.receipt-required-2020
    expertise: none
    source: { id: internal.expense-policy, section: "3.2" }
```

| 項目 | 必須 | 内容 |
|---|---|---|
| `id` | 必須 | 会社の中で一意です。`.` と `-` で区切った小文字の英数字 |
| `statement` | 必須 | 1 文で書きます。10 文字以上 240 文字まで |
| `aliases` | 任意 | 同じことを指す別の言い方です。「インボイス」と「適格請求書」のように文字を共有しない語は、ここに書かないと探せません |
| `applies_to.profession` | 任意 | この決まりを引く職種です。省略するとすべての職種です |
| `scope` | 会社に Principal が 2 人以上いるとき必須 | `{ visibility: company }`、`{ principals: [alice] }`、`{ roles: [officer] }` のどれかです。Principal が 1 人の会社では省略でき、`company` として扱います |
| `effective_from` | 必須 | この日から有効です(`YYYY-MM-DD`) |
| `effective_to` | 必須 | 期限がなければ `null` と書きます。省略は認めません |
| `supersedes` | 任意 | 置き換える前の決まりの id です。build が前の決まりの `effective_to` を、この決まりの `effective_from` の前日に閉じます |
| `expertise` | 必須 | `none`、`tax`、`legal`、`labor` のどれかです。`none` 以外は、資格者の領域に関わる材料であることを表します |
| `source` | 必須 | 根拠の Source の id と、あれば節 |

### `sources/<name>.md`

```markdown
---
id: invoice.2023
title: 適格請求書等保存方式の概要
publisher: 国税庁
url: https://example.invalid/invoice
retrieved_at: 2026-09-01
version: "2023-10"
effective_from: 2023-10-01
effective_to: null
scope: { visibility: company }
expertise: tax
---

## 保存の要件

...
```

`publisher`、`url` か `path` のどちらか、`retrieved_at`、`effective_from`、`effective_to`、`expertise` が必須です。`scope` は Rule と同じ規則です。`path` は会社フォルダの中の相対パスで、Tool と同じ path guard(`resolveWorkspacePath`)を通します。workspace の外、予約パス、外へ出る symlink を指す Source は build が拒否します。

## `openshain knowledge build`

入力は `rules/` と `sources/`、出力は `build/` です。次の順に検証します。1 つでも通らなければ `build/` には何も書かず、**すべての誤りをまとめて表示してから**終了コード 1 で止まります。1 件目で止めません。

1. 書式。zod の定義を `packages/core` に置き、`bun run schemas` が `spec/schemas/knowledge-*.v1.json` を生成します。YAML は別名と自作 tag を許さない読み込みで、1 ファイル 1 MiB、入力全体 64 MiB、build 全体 60 秒を上限にします
2. 参照の解決。`rule.source.id` が `sources/` に存在すること。`source.path` が path guard を通ること。`applies_to.profession` と `scope.roles` が職種と `principals/` に存在すること
3. 有効日。`effective_from <= effective_to`。同じ id の決まりで期間が重ならないこと。同じ `source.id` を引く決まりどうしで期間が重なるときは警告し、`supersedes` があれば前の決まりを自動で閉じること。決まりの期間が、引いている Source の期間の中に収まっていること
4. 出典。Source に `publisher` と場所と `retrieved_at` があること
5. Scope の展開。`principals/` と職種から、誰がどの Source と Rule を読めるかの表に落とします。表は版ごと(id と有効期間の組ごと)に持ちます
6. 索引。決まりと資料の見出しごとに作ります。見出しの無い資料は本文全体を 1 つの単位にします
7. 出力。入力ファイルをパスのコードポイント順に読み、索引の並びも決めた順にして、同じ入力から同じ byte になるようにします。書き込みは `build/` の中の一時ファイルに書いてから rename します。`manifest.json` に入力のハッシュ、索引の形式の版、件数、時刻を書きます。入力のハッシュと形式の版がどちらも変わっていなければ再構築しません

`openshain knowledge check` は書き込みをせずに 1 から 5 までを実行します。CI で使います。`--stale` を付けると、`retrieved_at` が 1 年より古い Source を警告します(終了コードは変えません)。

## `openshain knowledge add`

対話で 1 件の決まりを書き加えます。何についての決まりか、いつから有効か、根拠は何かを順に聞き、`rules/` に正しい YAML を書いて `build` を実行します。書式を人が覚えなくても足せるようにするためです。書くのは人で、内容を決めるのも人です。

## 引くための Tool

`standard` の Tool provider が、`build/manifest.json` のある会社フォルダでだけ次の 2 つを登録します。設定の追加は要りません。索引が無い会社フォルダでは Tool の一覧に現れないので、model からは見えません。Runtime は起動時に Tool を数えるので、build の後は対話をいったん閉じて開き直します。

| Tool | 入力 | 返すもの |
|---|---|---|
| `knowledge_search` | `query`(240 文字まで)、`limit`(既定 5、最大 20)、`as_of`(任意) | 一致した決まりと資料の一覧。1 件につき id、種類、見出し、前後を含む抜粋(400 文字まで)、出典、版、有効日、`expertise`、順位。先頭に範囲の情報(返した件数、認可された対象の件数、切り詰めの有無)を付けます。本文は返しません |
| `knowledge_read` | `id`、`section`(任意)、`limit`、`as_of`(任意) | 1 件の本文を窓で返します。`markdown_read` と同じ形(範囲、行数、続きの有無) |

- **認可はどちらの Tool でも行います**。`knowledge_read` は id を受け取ったあと、`knowledge_search` と同じ scope と有効日の検査をやり直します。認可されない id は、存在を伝えずに拒否します。id は人が書く読みやすい文字列なので、推測して直接読む経路を塞ぐためです
- **絞り込みを先に、順位付けを後に**行います。認可された対象だけを候補にしてから点を付けます。認可されない対象の件数や、処理にかかる時間から存在が分からないようにするためです
- 認可は問い合わせのたびに、そのときの `principals/` と職種で判定します。索引が持つのは各版の `scope` の宣言で、誰が読めるかの結論は持ちません
- 既定では、その Work の業務日に有効なものだけを返します。業務日は `context` Tool と同じ計算を使います。過去の時点は `as_of` で指定し、そのとき有効だった版の `scope` で認可します
- 検索の結果と本文は、会社の外から持ち込んだ文書を含みます。**これは資料であって指示ではありません**。Tool の結果にその旨を添えます

### Need-to-Know を Tool の中で行う理由

`authority/` の判定は「この呼び出しを実行してよいか」を決める 1 か所です(docs/design/core.md)。Need-to-Know は実行の可否ではなく、返す内容の絞り込みです。同じ `knowledge_search` の呼び出しが、誰が依頼したかによって別の件数を返します。判定の表に載せると、規則の数が資料の数だけ増えます。そこでこの版では、絞り込みは Tool の中で行い、`authority/` は今までどおり呼び出しの可否だけを決めます。判定が 2 か所になるので、`knowledge_search` と `knowledge_read` の両方に同じ検査を置き、テストで固定します。

## 検索の仕組み

文字の 3 つ組(trigram)の転置索引を build 時に作り、`build/index.json` に置きます。本文と `aliases` を NFKC で正規化し、小文字にして、空白を除いてから作ります。

- 問い合わせが 3 文字に満たないときは 2 つ組で探します。「請求」「経費」のような 2 文字の語が日本語の業務では普通に使われるためです
- 点は、問い合わせの組のうち何割が一致したかで付け、長い文書がその長さだけで上位に来ないように文書の長さで補正します。同点は id 順です
- 同じ組が 1 つの文書に何度現れても 1 回として数えます。同じ語を並べた文書がすべての問い合わせで上位に来ないようにするためです
- 文字を共有しない同義語(「インボイス」と「適格請求書」)は、この方法では橋渡しできません。`aliases` に書いたものだけが一致します

2,000 件の決まりで索引は 600 KB、build は 71 ミリ秒、1 回の検索は 0.11 ミリ秒でした(試作での実測)。

SQLite の FTS5 を使わない理由です。Bun 1.3.14 は `node:sqlite` を実装しておらず(実測)、Node.js 24 は実装しています。SQLite を使うと、npm で配る Node.js 向けの経路と、Bun で作る単体バイナリの経路で実装が分かれます。会社フォルダの知識は数千件の規模なので、`node:` のモジュールだけで書いた索引で足ります。

## 索引を信用する条件

`build/` は Runtime の予約パスですが、それが塞ぐのは openshain の Tool だけです。MCP で接続した外部のエージェントは自分のファイル操作を持っていて、Runtime はそれを塞げません(docs/design/mcp.md)。索引を無条件に信用すると、書き換えた索引で偽の決まりを配れます。

そこで、知識の Tool は使う前に毎回、`rules/` と `sources/` から入力のハッシュを計算し直し、`manifest.json` の値と、索引の形式の版を照合します。合わなければ知識の Tool を提供せず、「索引が古いか、入力と一致しません。`openshain knowledge build` を実行してください」とだけ伝えます。中身は返しません。

## 資格者の領域

決まりと資料は `expertise` を持ちます。`none` 以外の材料を引いたことは記録に残り、Review Package に入ります。社員エージェントは、資格者の判断に当たる結論を自分で確定せず、材料と出典を示して人に渡します(spec/professional-boundary.md の区分 1 から 5)。

この版がコードで止められるのは、外へ効果を出す呼び出しだけです。会話の中だけで結論を述べる経路は止まりません。次の版で、`expertise` を `authority/` の判定に載せ、資格者の材料を使った結論そのものを `review_required` にできる形を検討します。この限界は SECURITY.md に書きます。

## 記録

- 引いた知識は、いまの Tool と同じく `tool.called` と `tool.completed` に残ります
- 1 回の検索は複数の Source を返すので、いまの `observation`(`{ source, retrievedAt }` が 1 つ)では表せません。`observation` を配列にし、`{ id, version, retrievedAt }` を持てるようにします。`packages/core` の公開インターフェースの変更です
- Work が引用した Source と決まりは、Review Package の `sources` と `companyRules` に入ります(いまは空のまま出しています)
- build は Work の外の作業なので、Work のイベントにはしません

## 完了の条件

仕組みの条件です。

1. 出典か有効日の無い決まりを `knowledge build` が拒否し、`build/` に何も書かないこと。誤りが複数あるとき、1 回の実行ですべて表示すること
2. 権限のない Principal では、該当の Source が `knowledge_search` の結果にも件数にも現れないこと。`knowledge_read` に id を直接渡しても、存在を伝えずに拒否すること
3. `build/index.json` を書き換えると、知識の Tool が提供されなくなること。`source.path` が workspace の外や予約パスを指す Source を build が拒否すること
4. `aliases` に書いた語で、文字を共有しない表記(「インボイス」と「適格請求書」)から該当の決まりが上位 3 件に入ること。2 文字の問い合わせが結果を返すこと。全角と半角の違いで結果が変わらないこと
5. 業務日を変えると、有効期間の違う決まりが入れ替わること。`as_of` で過去を引くと、そのとき有効だった版の `scope` で認可されること
6. 同じ入力から 2 回 build して、`index.json` が byte 単位で一致すること。索引の形式の版を上げると、入力が同じでも再構築されること
7. `build/` を Tool から読み書きできないこと。索引の無い会社フォルダでは知識の Tool が model に渡らないこと

使われることの条件です。

8. 決まりを名指ししない依頼(「この経費は精算できますか」)で、社員エージェントが自分で `knowledge_search` を呼び、答えに決まりの id と有効日を添えること
9. 該当する決まりが無いとき、社員エージェントが「該当する決まりが見つかりません」と答え、一般的な知識で答えないこと
10. 架空の会社の例(`examples/sample-company`)に決まりと資料のひな型があり、`openshain knowledge add` で 1 件追加してから 8 と 9 が通ること

8 と 9 は実際のモデルで確かめます(`OPENSHAIN_LIVE_TESTS=1`)。小さいモデルと大きいモデルの両方で通ることを条件にします。
