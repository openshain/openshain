# Spec: Knowledge(会社の決まりと根拠の資料)

Status: 起案(未実装)

## 目的

社員エージェントが、**会社が書いた決まり**を、出典と有効日つきで引けるようにします。証明したいことは 4 つです。

1. 出典か有効日のない決まりは索引に入らないこと
2. 権限のない Principal では、該当の Source が **openshain の Tool を通るどの経路にも**現れないこと。検索の結果にも件数にも、id を直接渡した読み取りにも現れないこと
3. 索引が、人が書いた入力と一致しないとき、知識をいっさい提供しないこと
4. 依頼の中で決まりを名指しされなくても、社員エージェントが自分で引いて、id と有効日を添えて答えること。該当する決まりが無いときは、無いと言うこと

知識は人が書き、`openshain knowledge build` が検証して索引にし、Runtime が Tool として使います。build を通らないファイルは社員エージェントから見えません。

### やらないこと(この版では)

- **法令、通達、ガイドラインを届けること**。この版が扱うのは、会社が自分で書いた決まりと、会社が自分で置いた根拠の資料だけです。日本の法域に固有の知識を継続して届ける経路は後の版です。会社が法令の引用を自分で `knowledge/sources/` に置くことはできますが、書くのは会社です
- 埋め込みベクトルによる検索。この版は文字の重なりだけで探します
- 知識の自動更新。更新は人が資料を置き換えて build し直します
- 決まりの自動適用。知識は判断の材料で、実行してよいかの判定は `authority/` が行います(spec/authority.md)
- 会話だけで完結する結論の差し止め。「この支出は損金にできます」のような、資格者の判断に当たる答えを、コードで止める仕組みはこの版にありません。止められるのは外へ効果を出す呼び出しです
- PDF と Office 文書の取り込み。この版は Markdown と YAML です
- 検索の実装を差し替えるためのインターフェース。実装が 2 つになるまで作りません(docs/design/core.md)

## 用語

- Source: 根拠の資料です。社内規程、契約、会社が引用した法令の条文など、出所のある文書 1 件を指します。`knowledge/sources/` に置くのは**出典を明記した引用**で、原本ではありません。原本の置き場は会社がいま使っている場所のままです
- Rule: 会社の決まりです。1 文の主張と、その根拠になる Source を持ちます
- Provenance: その Source がどこから来たかです。発行者、場所、取得日、版
- 有効日: いつからいつまで有効かです。業務日で判定します
- Scope: 誰が読んでよいかです。Need-to-Know の単位になります
- Index: build の出力です。人も Tool も書きません

Rule と Source の id は人が書く文字列です(`.` と `-` を含む小文字の英数字。`packages/core` の `identifier` は `.` を許さないので、別の正規表現になります)。Work や Event の id(UUIDv7)とは別の系統で、branded type にはしません。

## Company Workspace への追加

```
<workspace>/
└── knowledge/            ← Runtime の予約パス
    ├── rules/            会社の決まり(人が書きます)
    │   └── expenses.yaml
    ├── sources/          根拠の資料(人が置きます)
    │   └── expense-policy.md
    └── build/            knowledge build の出力
        ├── manifest.json 入力のハッシュ、索引のハッシュ、索引の形式の版、件数、時刻
        └── index.json    検索と読み取りが使う索引
```

`knowledge/` を Runtime の予約パスに加えます(`packages/core/src/tool/paths.ts` の `RESERVED_PATHS`)。知識は索引を通してしか読めません。`fs_read` や `markdown_read` で同じファイルを直接読めるままにすると、scope の絞り込みが素通りされるからです。

**この予約が塞ぐのは openshain の Tool を通る経路だけです**。その機械のファイルを読める人は同じ内容を直接読めますし、MCP で接続した外部のエージェントは自分のファイル操作を持っています。Runtime はそれを塞げません(docs/design/mcp.md)。

`knowledge/` の外は変わりません。会社フォルダのどこかに規程や手順書を置いて標準 Tool で読ませる使い方(README の「知識の投入導線」)はそのままです。**書式なしで置くだけの経路**と、**出典と有効日を持たせて索引に載せる経路**が、パスで見分けられます。`knowledge/` の無い会社フォルダは、いまのとおり動きます。

### `knowledge/rules/<name>.yaml`

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
| `id` | 必須 | 会社の中で一意です |
| `statement` | 必須 | 1 文で書きます。10 文字以上 240 文字まで |
| `aliases` | 任意 | 同じことを指す別の言い方です。「インボイス」と「適格請求書」のように文字を共有しない語は、ここに書かないと探せません |
| `applies_to.profession` | 任意 | この決まりを引く職種です。省略するとすべての職種です |
| `scope` | 会社に Principal が 2 人以上いるとき必須 | `{ visibility: company }`、`{ principals: [alice] }`、`{ roles: [officer] }` のどれかです。Principal が 1 人の会社では省略でき、`company` として扱います |
| `effective_from` | 必須 | この日から有効です(`YYYY-MM-DD`) |
| `effective_to` | 必須 | 期限がなければ `null` と書きます。省略は認めません |
| `supersedes` | 任意 | 置き換える前の決まりの id です。build が前の決まりの `effective_to` を、この決まりの `effective_from` の前日に閉じます |
| `expertise` | 必須 | 資格者の領域を表す文字列です。`none` は資格に関わらないことを表します。それ以外の値の集合は Profession Pack か会社が決め、core は形だけを見ます(下の「資格者の領域」) |
| `source` | 必須 | 根拠の Source の id と、あれば節 |

### `knowledge/sources/<name>.md`

```markdown
---
id: internal.expense-policy
title: 経費規程
publisher: サンプル株式会社
path: policies/expenses.md
retrieved_at: 2026-09-01
version: "2026-04"
effective_from: 2026-04-01
effective_to: null
scope: { visibility: company }
expertise: none
---

## 3.2 領収書

...
```

`publisher`、`url` か `path` のどちらか、`retrieved_at`、`effective_from`、`effective_to`、`expertise` が必須です。`scope` は Rule と同じ規則です。`path` は会社フォルダの中の相対パスで、Tool と同じ path guard(`resolveWorkspacePath`)を通します。workspace の外、予約パス、外へ出る symlink を指す Source は build が拒否します。

## `openshain knowledge build`

入力は `knowledge/rules/` と `knowledge/sources/`、出力は `knowledge/build/` です。次の順に検証します。1 つでも通らなければ `build/` には何も書かず、**すべての誤りをまとめて表示してから**終了コード 1 で止まります。1 件目で止めません。

1. 書式。zod の定義を `packages/core` に置き、`bun run schemas` が `spec/schemas/knowledge-*.v1.json` を生成します。YAML は別名と自作 tag を許さない読み込みで、1 ファイル 1 MiB、入力全体 64 MiB、build 全体 60 秒を上限にします
2. 参照の解決。`rule.source.id` が `sources/` に存在すること。`source.path` が path guard を通ること。id が 2 か所で定義されていないこと。`applies_to.profession` と `scope` の名前は形だけを見ます。Runtime はまだ `principals/` を読まないので、実在するかの照合は、複数人を扱うようになったときに入れます
3. Scope の包含。決まりの `scope` が、引いている Source の `scope` より広くないこと。広いと、出典の欄から、読めないはずの資料の存在と場所が漏れます
4. 有効日。`effective_from <= effective_to`。同じ id の決まりで期間が重ならないこと。決まりの期間が、引いている Source の期間の中に収まっていること。**同じ `source.id` を引く決まりどうしで期間が重なるときは拒否**します(`supersedes` があれば前の決まりを閉じ、`scope` か `applies_to` が交わらなければ通します)
5. 出典。Source に `publisher` と場所と `retrieved_at` があること
6. Scope の展開。`principals/` と職種から、誰がどの Source と Rule を読めるかの表に落とします。表は版ごと(id と有効期間の組ごと)に持ちます
7. 索引。決まりと資料の見出しごとに作ります。見出しの無い資料は本文全体を 1 つの単位にします
8. 出力。入力ファイルをパスのコードポイント順に読み、索引の並びも決めた順にして、同じ入力から同じ byte になるようにします。**`index.json` を一時ファイルに書いて rename し、そのあとで `manifest.json` を書いて rename します**。manifest が「索引が揃った」印になります。manifest には入力のハッシュ、**`index.json` 自身のハッシュ**、索引の形式の版、件数、時刻を書きます。入力のハッシュと形式の版がどちらも変わっていなければ再構築しません

`openshain knowledge check` は書き込みをせずに 1 から 6 までを実行します。CI で使います。`--stale` を付けると、`retrieved_at` が 1 年より古い Source を警告します(終了コードは変えません)。

## `openshain knowledge add`

対話で 1 件の決まりを書き加えます。何についての決まりか、いつから有効か、根拠は何か、**他にどう言い換えるか**(`aliases`)を順に聞きます。端末が無ければ質問せず、使い方を表示して終わります(docs/design/cli.md)。

**追加は成功するか、何も起きなかったことになるかのどちらかです**。入力を一時領域に写して検証と build を行い、通ったときだけ `knowledge/rules/` と `knowledge/build/` を置き換えます。落ちたときは書いた内容を取り消し、誤りを表示します。これをしないと、1 件足す操作が、それまでの決まり全部を読めなくする経路になります(build が落ちると入力と索引が食い違い、下の「索引を信用する条件」で提供が止まるためです)。

build のあとに知識の Tool が現れるのは、次に対話を開いたときです。Runtime は起動時に Tool を数えるためで、`add` はその旨を表示します。

## 引くための Tool

`standard` の Tool provider が、`knowledge/build/manifest.json` のある会社フォルダでだけ次の 2 つを登録します。設定の追加は要りません。索引が無い会社フォルダでは Tool の一覧に現れないので、model からは見えません。

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

文字の 2 つ組と 3 つ組の転置索引を build 時に作り、`knowledge/build/index.json` に置きます。本文と `aliases` を NFKC で正規化し、小文字にして、空白を除いてから作ります。

- 3 文字以上の問い合わせは 3 つ組で、3 文字に満たない問い合わせは 2 つ組で探します。「請求」「経費」のような 2 文字の語が日本語の業務では普通に使われるためです。1 文字の問い合わせは受け付けず、2 文字以上を求めます
- 点は、問い合わせの組のうち何割が一致したかで付け、長い文書がその長さだけで上位に来ないように文書の長さで補正します。同点は id 順です
- 同じ組が 1 つの文書に何度現れても 1 回として数えます。同じ語を並べた文書がすべての問い合わせで上位に来ないようにするためです
- 文字を共有しない同義語(「インボイス」と「適格請求書」)は、この方法では橋渡しできません。`aliases` に書いたものだけが一致します。資料の本文に `aliases` はありません

2,000 件の決まりで、3 つ組だけなら索引は 305 KB、2 つ組を足すと 598 KB、build は 28 ミリ秒、1 回の検索は 0.11 ミリ秒でした(試作での実測)。

SQLite の FTS5 を使わない理由です。Bun 1.3.14 は `node:sqlite` を実装しておらず(実測)、Node.js 24 は実装しています。SQLite を使うと、npm で配る Node.js 向けの経路と、Bun で作る単体バイナリの経路で実装が分かれます。会社フォルダの知識は数千件の規模なので、`node:` のモジュールだけで書いた索引で足ります。

## 索引を信用する条件

`knowledge/` は予約パスですが、それが塞ぐのは openshain の Tool だけです。索引を無条件に信用すると、書き換えた索引で偽の決まりを配れます。

そこで、知識の Tool は使う前に、`manifest.json` を読み、次の 3 つを照合します。

1. `rules/` と `sources/` から計算し直した入力のハッシュ
2. `index.json` 自身のハッシュ
3. 索引の形式の版

1 つでも合わなければ、知識の Tool を提供せず、「索引が入力と一致しません。`openshain knowledge build` を実行してください」とだけ伝えます。中身は返しません。2 を省くと、索引だけを書き換えた改ざんを検出できません。

照合は Work ごとに 1 回行い、その Work の間は同じ結果を使います。呼び出しのたびに全件を読み直すと、件数に比例して遅くなるためです。Work の途中で入力が変わっても、その Work は開始時に確かめた索引を使い続けます。次の Work で照合し直します。manifest と index は 1 回のまとまりとして読み、読んだ内容から答えます。

**この照合が守るのは「索引が入力の像であること」だけです**。入力そのものを書ける人は、決まりを差し替えられます。会社フォルダのファイルを書ける人は誰でもそれができます。SECURITY.md に明記します。

## 資格者の領域

決まりと資料は `expertise` を持ちます。`none` は資格に関わらないことを表し、それ以外の値の集合は **Profession Pack か会社が決めます**。`packages/core` は文字列として比べるだけで、資格名も士業法も持ちません(docs/design/core.md、spec/professional-boundary.md)。どの業務が資格者の判断に当たるかは、経理 Pack を作るときに税理士と確認して Pack の表に書きます。`authority.md` の `reviewer.role` と `action` の名前が同じ扱いです。

`knowledge_search` と `knowledge_read` が返すのは、spec/professional-boundary.md の区分 1(事実の取得)、区分 2(Source の検索と要約)、区分 3(Company Rule の適用)の材料です。区分 5(資格に関わる個別判断)に当たる結論を社員エージェントが確定してはいけません。材料と出典と、判断が要る点を示して人に渡します。

**この版で `expertise` に強制力はありません**。記録と Review Package に残るだけで、`authority/` の判定には入りません。`expertise` が `none` でない材料を使った呼び出しを止めたい会社は、`authority/policy.yaml` に `action` の規則を自分で書きます。次の版で、その対応づけを検査するか、判定に載せるかを決めます。

## 記録

- 引いた知識は、いまの Tool と同じく `tool.called` と `tool.completed` に残ります
- 1 回の検索は複数の Source を返すので、いまの `observation`(`{ source, retrievedAt }` が 1 つ)では表せません。`observation` を配列にし、`{ id, version, retrievedAt }` を持てるようにします。`packages/core` の公開インターフェースの変更です
- Work が引用した Source と決まりは、Review Package の `sources` と `companyRules` に入ります(いまは空のまま出しています)
- build は Work の外の作業なので、Work のイベントにはしません
- 引用した抜粋は Work の記録に残り、`work_get` と `work_list` はこの会社フォルダのどの Work も読めます。Principal が 1 人のいまは差がありませんが、複数人になったときは読み取りにも同じ絞り込みが要ります。そのときに入れます

## 受け入れた制限

- **社員エージェントは、build を通る前の `knowledge/` を読めません**。人が書いた決まりを社員エージェントに添削させることはできません。`knowledge build` と `knowledge check` の出力を人が読み、必要なら会話に貼ります。予約を緩めると Need-to-Know が素通りするので、この版はこの形にします
- `aliases` は人が書きます。書き忘れた言い方では見つかりません

## 完了の条件

仕組みの条件です。

1. 出典か有効日の無い決まりを `knowledge build` が拒否し、`build/` に何も書かないこと。誤りが複数あるとき、1 回の実行ですべて表示すること
2. 権限のない Principal では、該当の Source が `knowledge_search` の結果にも件数にも現れないこと。`knowledge_read` に id を直接渡しても、存在を伝えずに拒否すること。決まりの `scope` が引いている Source より広いとき、build が拒否すること
3. `index.json` だけを書き換えると、知識の Tool が提供されなくなること。`manifest.json` だけを書き換えたときも同じこと。`source.path` が workspace の外や予約パスを指す Source を build が拒否すること。`knowledge/` を `fs_read`、`fs_list`、`fs_search`、`markdown_read` から読めないこと
4. `aliases` に書いた語で、文字を共有しない表記(「インボイス」と「適格請求書」)から該当の決まりが上位 3 件に入ること。2 文字の問い合わせが結果を返すこと。全角と半角の違いで結果が変わらないこと。長い資料が、同じ語を含む短い決まりより上位に来ないこと
5. 業務日を変えると、有効期間の違う決まりが入れ替わること。`as_of` で過去を引くと、そのとき有効だった版の `scope` で認可されること
6. 同じ入力から 2 回 build して、`index.json` が byte 単位で一致すること。索引の形式の版を上げると、入力が同じでも再構築されること
7. `knowledge add` が検証に落ちたとき、`knowledge/` が実行前と同じ状態に戻り、それまでの決まりが引き続き読めること

使われることの条件です。

8. 決まりを名指ししない依頼(「この経費は精算できますか」)で、社員エージェントが自分で `knowledge_search` を呼び、答えに決まりの id と有効日を添えること
9. 該当する決まりが無いとき、社員エージェントが「該当する決まりが見つかりません」と答え、一般的な知識で答えないこと
10. 同じ問い合わせに当てはまる決まりが 2 件あるとき(職種が違う、片方が期限切れ)、社員エージェントが両方を示すか、現に有効なほうを選ぶこと。黙って 1 件だけ選ばないこと
11. 架空の会社の例(`examples/sample-company`)に決まりと資料のひな型があり、`openshain knowledge add` で 1 件追加してから 8 から 10 が通ること

8 から 10 は実際のモデルで確かめます(`OPENSHAIN_LIVE_TESTS=1`)。小さいモデルと大きいモデルの両方で通ることを条件にします。
