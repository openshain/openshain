# openshain.yaml

会社のフォルダ(Company Workspace)の設定です。`openshain init` がひな型を書きます。項目名は snake_case です。機械で読む形は [spec/schemas/config.v1.json](../spec/schemas/config.v1.json) にあります。

## 置き場所と探し方

`openshain` のコマンドはカレントディレクトリから上に向かって `openshain.yaml` を探し、見つかったディレクトリを workspace の root にします。`--workspace <dir>` で起点を指定します。Tool がアクセスできるのは root の中だけで、`openshain.yaml`、`work/`、先頭が `.` の項目にはアクセスできません。

## 項目

| 項目 | 必須 | 意味 |
|---|---|---|
| `version` | 必須 | `1` |
| `company.name` | 必須 | 会社名です。model に伝わります。1 から 200 文字 |
| `company.language` | 任意 | 会社の言語です。`ja` か `en`。社員エージェントの名前をこの言語の一覧から選びます。画面と CLI の文言は日本語のままです。省略時は `ja`。`openshain init` が OS の locale から埋めます |
| `company.timezone` | 任意 | 会社の時刻です(`Asia/Tokyo` のような IANA の名前)。業務日と、判断や委任の有効日はこの時刻で決まります。省略すると openshain を動かしている機械の設定を使います。`openshain init` がその値を埋めます |
| `principal.id` | 必須 | 依頼する人の id です。小文字の英字で始まり、英数字と `_` と `-` で構成します。記録に残ります |
| `principal.name` | 必須 | 表示名です。1 から 200 文字 |
| `profession.id` | 必須 | 職種の id です。今は `generic` だけです。形式は `principal.id` と同じ規則です |
| `profession.instructions` | 必須 | model への指示です。system prompt の先頭に入ります。100,000 文字まで |
| `model` | 任意 | 対話型 CLI(`openshain`)が使うモデルの節です。Claude Code や Codex から MCP で使うだけなら書きません。無いときに `openshain` を実行すると、モデルが要る旨で止まります |
| `model.provider` | model があれば必須 | `anthropic` か `openai-compatible` です。SDK から使うときは登録した provider の id です |
| `model.model` | model があれば必須 | model の名前です。provider にそのまま渡します |
| `model.api_key_env` | model があれば必須 | API キーを入れる環境変数の名前です。大文字の英字で始まり、英数字と `_` で構成します。値はここに書きません |
| `model.base_url` | 任意 | API の root です。openai-compatible では `/v1` まで含めます(例 `http://localhost:11434/v1`)。省略時は各 provider の既定です。`user:pass@` は受け付けません。https か、localhost のようにこの機械を指す http だけを受け付けます。遠隔のホストに http を書くとキーが平文で流れるので拒みます |
| `model.options` | 任意 | provider にそのまま渡す指定です。Anthropic なら `effort` や `thinking`、OpenAI 互換なら `reasoning_effort` や `temperature` です。model、messages、tools、出力の上限は上書きできません |
| `model.context_tokens` | 任意 | このモデルが受け取れる入力の大きさです。会話を要約する目安に使います。openshain はモデルの名前から長さを推し量りません。書かないときは 150000 を目安にします |
| `tools` | 任意 | Tool provider の並びです。省略時は `[{ provider: standard }]` です。各項目は `provider`(組み込みの id)か `module`(ToolProvider を default export するファイルのパス)のどちらか 1 つです。`allow` を書くと、その名前の Tool だけを model に渡します。`module` はそのファイルを読み込んで実行するので、信用できないフォルダでは動かさないでください |
| `limits.max_model_calls` | 任意 | 1 つの Work での model 呼び出しの上限です。既定 30。超えると Work は失敗(上限到達)で止まります |
| `limits.max_tool_calls` | 任意 | Tool 呼び出しの上限です。拒否された呼び出しも数えます。既定 100 |
| `limits.max_output_tokens` | 任意 | model の 1 回の出力の上限です。既定 16000 |
| `limits.compact_at_input_tokens` | 任意 | 1 回の呼び出しの入力がこれを超えたら、次のターンの前に会話を要約します。既定は `model.context_tokens` の 70%、それも無ければ 150000。`0` で要約しません。書くなら 50000 以上です。これより小さいと、要約が保つものより失うもののほうが多くなります |
| `debug.persist_raw` | 任意 | provider の生の応答を記録に残します。既定 false |

設定の不備は起動時に行番号つきで報告します。`model` を書き換えるだけで provider が切り替わります。

## 標準 Tool

`tools` に `provider: standard` があると、fs_list、fs_search、fs_read、fs_write、csv_read、csv_aggregate、csv_write、markdown_read の 8 つが有効になります。`openshain tools list` が、登録された Tool と許可の有無を表示します。自分の Tool を追加するには、ToolProvider を default export するファイルを `module` で指すか、別の provider を作ります。例は `examples/tools/echo` にあります。

## 権限と承認(`authority/`)

会社フォルダに `authority/` を置くと、Tool の呼び出しごとに判定が入ります。置かなければ、これまでどおりすべて許可です。`principals/` と `authority/` はランタイムの予約パスで、Tool からは読み書きできません。機械で読む形は [spec/schemas/authority-policy.v1.json](../spec/schemas/authority-policy.v1.json) と [authority-delegations.v1.json](../spec/schemas/authority-delegations.v1.json) にあります。

```
authority/
├── policy.yaml          どの呼び出しに何が要るか
├── delegations.yaml     誰の代理で、どの職種として働いてよいか
└── decisions/           資格者の判断。ランタイムが書きます
```

### `delegations.yaml`

```yaml
version: 1
delegations:
  - principal: alice        # 誰の代理で
    profession: generic     # どの職種として
    valid_from: 2026-09-01  # 任意
    valid_until: null       # 任意。null は期限なし
```

`profession` は `openshain.yaml` の `profession.id` と同じ語を書きます。会社フォルダの職種は 1 つなので、別の語を書いた委任はどの呼び出しにも一致しません。`authority/` があるのに委任が無い組み合わせでは、その Work の呼び出しはすべて拒否されます。書き忘れたときに開かず閉じるためです。

### `policy.yaml`

```yaml
version: 1
default: allow              # どの規則にも一致しないときの判定
rules:
  - id: receipts-are-read-only
    match: { effect: mutate, path: "receipt/**" }
    decision: deny
    reason: 領収書は変更しません
  - id: ledger-needs-approval
    match: { tool: [fs_write, csv_write], path: "ledger/**" }
    decision: approval_required
    approvers: [alice]
  - id: tax-needs-review
    match: { action: tax-treatment }
    decision: review_required
    reviewer: { role: tax-accountant }
  - id: tax-decided
    match: { action: tax-treatment }
    decision: decision_backed
    decision_id: dec_01a0…
```

| 項目 | 必須 | 内容 |
|---|---|---|
| `default` | 任意 | どの規則にも一致しないときの判定です。省略時は `allow` です |
| `rules[].id` | 必須 | 規則の名前です。小文字で始まり、英数字と `_` と `-` で構成します。記録と画面に出ます |
| `rules[].match` | 必須 | 一致の条件です。書いた項目はすべて満たす必要があります |
| `rules[].match.tool` | 任意 | Tool の名前、または名前の並びです |
| `rules[].match.effect` | 任意 | `observe` か `mutate` です |
| `rules[].match.path` | 任意 | 会社フォルダからの相対パスの形です。`*` は 1 つの区切りの中、`**` は区切りをまたぎます。`path` を持たない呼び出しには一致しません |
| `rules[].match.principal` | 任意 | 代理する人の id です |
| `rules[].match.work_type` | 任意 | Work の type です |
| `rules[].match.action` | 任意 | 呼び出しに付いた行為の名前です。いまは Tool の名前と同じ扱いです |
| `rules[].decision` | 必須 | `allow`、`deny`、`approval_required`、`review_required`、`decision_backed` のどれかです |
| `rules[].reason` | 任意 | `deny` の理由、または Reviewer への問いです。画面と記録に出ます |
| `rules[].approvers` | 任意 | `approval_required` で承認できる人の id です。省略時は `openshain.yaml` の principal です |
| `rules[].reviewer` | 任意 | `review_required` で判断できる役です(`{ role: tax-accountant }`)。判断はこの役の名で記録しなければ受け付けません |
| `rules[].decision_id` | `decision_backed` で必須 | 根拠にする判断の id です |

規則は上から順に読み、最初に一致したものが決めます。判定は普通のコードが行い、model の出力では変わりません。

### 判定ごとの動き

| 判定 | 起きること |
|---|---|
| `allow` | そのまま実行します |
| `deny` | 実行せず、`tool.rejected`(`denied`)として記録します |
| `approval_required` | Work が `waiting_approval` で止まります。画面が選択の形になり、書き込みなら差分が出ます。`/approve <id>` と `/reject <id>` でも決められます |
| `review_required` | Review Package を `work/<id>/review/` に置いて止まります。`/review <id> approve` で判断を記録すると、`authority/decisions/` に書かれて実行します |
| `decision_backed` | `decision_id` の判断が有効日の中にあり、その呼び出しを覆うときだけ実行し、`decision.applied` として記録します。満たさなければ `review_required` として扱います |

### `decisions/`

ランタイムが書きます。人は削除しません。`applies_to` に `action` と `path` を書くと、その判断が効く範囲を狭められます。Reviewer の資格は会社の申告として記録するもので、openshain は検証しません。

同じ Action を次から自動で通すには、書かれた判断の id を `decision_backed` の規則に人が追加します。id は `/review <id> approve` の結果に表示され、`authority/decisions/<id>.yaml` のファイル名でもあります。規則を書き足すまでは、同じ Action はもう一度 `review_required` として止まります。

## 長い会話

会話が続くと、モデルへ送る入力は増え続けます。1 回の呼び出しの入力が `limits.compact_at_input_tokens` を超えると、次のターンを始める前に、それまでの会話を要約 1 件にまとめます。直近 5 件の発言はそのまま残ります。要約したことは画面に 1 行表示し、その行にあなたが伝えた前提を短く載せます。合っていなければ、その場で言い直してください。

- `/compact` で、閾値に届いていなくても要約します
- 要約はモデルが書いたものです。引いた会社の決まりと、実行できなかった呼び出しの 2 か所は、openshain が記録から書きます
- 要約は記録(`work/<セッションの id>/events.jsonl`)に残ります。**元のやり取りは消えません**。短くなるのはモデルが読む分だけです
- 要約しても入力が減らないときは、その旨を表示します。会話をいったん終えて、新しく始めてください

## 会社の人(`principals/`)

会社の人を 1 人 1 ファイルで書きます。`principals/` を置かない会社フォルダは、これまでどおり `openshain.yaml` の `principal` が 1 人いるだけの状態です。

```yaml
# principals/bob.yaml
id: bob                           # ファイル名と一致させます
name: Bob
roles: [accounting]               # 担当を表す会社の言葉です
status: active                    # active か inactive。既定は active
reads: [ledger/**, receipts/**]   # この人の社員エージェントが働く範囲。書かなければ全部です
```

| 項目 | 内容 |
|---|---|
| `id` | 小文字の英字で始まり、英数字と `_` と `-` で構成します。ファイル名と一致させます |
| `name` | 表示名です |
| `roles` | 担当です。`authority/policy.yaml` の `match.role` と、`knowledge` の `scope.roles` から参照します。資格者の `reviewer.role`(税理士など)とは別のものです |
| `status` | `inactive` にすると、その人の代理では実行できず、承認者にもできません。記録は残ります |
| `reads` | その人の社員エージェントが働く範囲です。順序のない glob の集合で、書かなければ会社フォルダ全体です |

### 誰として働くか

```
openshain --principal bob     # この端末は bob として使います
```

環境変数 `OPENSHAIN_PRINCIPAL` でも指定します。Claude Code から使うときは、`.mcp.json` の openshain の項目に `"env": { "OPENSHAIN_PRINCIPAL": "bob" }` を書きます(Claude Code が `openshain mcp` を自分で起動するため、端末のオプションは届きません)。

`reads` を書いた人が 2 人以上いるのに指定が無いときは、起動せずに名前を表示します。**本人確認はしていません。** 誰に何を渡すかは、フォルダの共有設定が決めることです。

### 範囲の効き方

`reads` を書いた人の社員エージェントは、範囲の外を一覧にも検索にも出しません。名指しで読もうとしたときは、そこに何かがあるかどうかに関わらず同じ返事をします。書き込みも届きません。記録には本当の理由が残ります。

ほかの人の Work も読めません。`openshain work list`、`openshain work show`、社員エージェントの `work_list` と `work_get` は、その人が依頼した Work だけを返します。id を名指ししても、無い Work と同じ返事になります。承認待ちの一覧(`approval_list`)は絞りません。承認は、ほかの人の Work に対して行うものだからです。

`reads` は順序のない集合で、`authority/policy.yaml` の表とは別のものです。表は上から読んで最初に一致した規則が決まりますが、`reads` はどれか 1 つに一致すれば範囲の中です。綴りを間違えても、範囲が広がることはありません。狭くなるだけです。

止めているのは社員エージェントであって、人ではありません。会社フォルダを直接読める人は、どのファイルも読めます。Claude Code や Codex は自分のファイル操作を持つので、範囲は効きません。

### 確かめる

```
openshain principal check bob   # その人の社員エージェントがどこで働き、何ができるかを表示します
```

`reads` に実際に一致するファイルとフォルダ、委任の有無、担当で一致する規則、範囲の外を `allow` している規則(設定の誤り)を表示します。問題があれば終了コード 1 です。

## 会社の決まりと資料(`knowledge/`)

会社が自分で決めたことを、出典と有効日を付けて置く場所です。ここに書いた決まりは、依頼のたびに社員エージェントが自分で引きます。`knowledge/` を置かない会社フォルダは、これまでどおり動きます。

```
knowledge/
├── rules/       会社の決まり(YAML)
├── sources/     根拠の資料(Markdown の front matter 付き)
└── build/       openshain knowledge build の出力。人は編集しません
```

### `rules/<name>.yaml`

```yaml
version: 1
rules:
  - id: expenses.receipt-required                              # 引用に使う id です
    statement: 1 万円以上の経費には領収書の原本が要ります。      # 1 文で書きます
    aliases: [領収書, レシート, 証憑]                           # 別の言い方です
    effective_from: 2026-04-01
    effective_to: null                                         # 期限が無ければ null と書きます
    expertise: none                                            # tax、legal など資格の領域です
    source: { id: internal.expense-policy, section: "3.2 領収書" }
```

| 項目 | 内容 |
|---|---|
| `id` | 小文字、数字、`.` `-` `_` です。答えの中でこの id が引用されます |
| `statement` | 決まりそのものです。10 文字から 240 文字で、1 文で書きます |
| `aliases` | 同じことを指す別の言い方です。文字を共有しない表記(「インボイス」と「適格請求書」)は、ここに書かないと見つかりません |
| `applies_to.profession` | その職種のときだけ引く決まりです。省くとすべての職種が引きます |
| `scope` | この決まりを引ける人です。その人の社員エージェントが引けるかどうかを決めます。`{ visibility: company }`、`{ principals: [alice] }`、`{ roles: [accounting] }` のどれかを書きます。省くと会社の全員が引けます。`roles` は `principals/` に書かれた人の `roles` から解決するので、誰も書かれていない会社フォルダでは誰にも見えません |
| `effective_from` / `effective_to` | 有効期間です。`effective_to` は期限が無くても `null` と書きます |
| `supersedes` | 置き換えた古い決まりの id です |
| `expertise` | 資格の領域です。`none` か、職種が定める語(`tax`、`legal`)を書きます |
| `source` | 根拠の資料の id と、その節です。出典の無い決まりは受け付けません |

### `sources/<name>.md`

根拠の資料は、front matter に出所を書いた Markdown です。本文は**出典を明記した引用**で、原本ではありません。原本は会社がいま使っている場所のままにします。

```markdown
---
id: internal.expense-policy
title: 経費規程
publisher: サンプル株式会社
path: policies/expenses.md   # 会社フォルダの中の原本です。外部の資料なら url を書きます
retrieved_at: 2026-04-01     # その内容を確認した日です
version: "2026-04"
effective_from: 2026-04-01
effective_to: null
scope: { visibility: company }
expertise: none
---

## 3.2 領収書

1 万円以上の経費には領収書の原本が要ります。
```

`url` と `path` はどちらか一方が要ります。本文は見出しごとに 1 件として索引に載るので、決まりの `source.section` は見出しの文字列と合わせます。見出しの無い資料は、本文全体で 1 件になります。

### 追加と検証

```
openshain knowledge add     # 質問に答えて決まりを 1 件追加します
openshain knowledge build   # 検証して knowledge/build/ に索引を作ります
openshain knowledge check   # 索引を書かずに検証だけ実行します
```

`add` は、書く前に検証します。落ちたときは何も書きません。`build` は誤りを 1 件目で止めず、すべて表示してから終了コード 1 で止まります。`check --stale` を付けると、`retrieved_at` が 1 年より古い資料を警告します(終了コードは変わりません)。

決まりを変更したら `build` を実行します。索引が入力と食い違っている間、社員エージェントは知識を引けず、`openshain knowledge build` を実行するよう伝えます。古い内容で答えるより、答えられないほうが安全だからです。

### `scope` と有効期間

- 検索も読み取りも、依頼した人の社員エージェントが引ける `scope` と、その日に有効な期間で絞ってから返します。引けない資料は結果にも件数にも現れません
- `knowledge/` はランタイムの予約パスです。`fs_read` や `markdown_read` では読めません。索引を通さずに読めると、この絞り込みが素通りするからです
- そのため、社員エージェントは `build` を通す前の決まりを読めません。書いた内容の確認は `knowledge check` の出力を人が読みます

## 会社フォルダの置き場

会社フォルダは、そのまま別の機械へ持ち運べます。Dropbox や Google Drive や git で同期しても構いません。ただし **同じ会社フォルダを同時に 2 か所で動かさないでください**。作業中の Work の lock はプロセスの番号で判定するため、別の機械のプロセスは判定できません。同時に書き込むと、記録(`work/<id>/events.jsonl`)が同期の競合として分かれ、一方の出来事が失われます。

- 1 人が複数の機械で、順番に使う分には問題ありません
- 会社が書いた決まりと資料(`knowledge/rules/` と `knowledge/sources/`)は git に向いています。変更の履歴と、誰がいつ変えたかが残ります
- 同じ機械であれば、複数の人がそれぞれ `--principal` で自分として働けます(`principals/`)。別々の機械から 1 つの会社フォルダへ同時に書き込む形は、この版にはありません

## 記録

Work ごとに `work/<id>/events.jsonl`(原本)と `work.json`(状態の投影)が残ります。`openshain` の画面での会話も `type: session` の Work として残り、そこから依頼した Work は `parent` で会話を指します。形式は [spec/schemas/events.v1.json](../spec/schemas/events.v1.json) と [spec/schemas/work.v1.json](../spec/schemas/work.v1.json) です。`openshain work list` と `openshain work show <id>` で参照します。

## Claude Code から使うためのファイル

`openshain init` は設定のほかに 3 つのファイルを書きます。既にあるものは上書きしません。`.mcp.json` が既にあれば、他のサーバーの項目を残したまま openshain の項目だけを追加します(JSON として読めないときは変更せず、その旨を表示します)。`AGENTS.md` と `CLAUDE.md` は既にあれば変更しません。

| ファイル | 内容 |
|---|---|
| `.mcp.json` | Claude Code のプロジェクト設定です。`openshain mcp` を stdio の MCP server として登録します。`openshain` が PATH にあることが前提です。Claude Code をアプリから起動して PATH が通らないときは、command に絶対パスを書いてください |
| `AGENTS.md` | MCP 経由で入る外部エージェントへの指示です。会社のファイルは openshain の Tool で扱い、`work_create` から始めて `work_complete` で終えます。|
| `CLAUDE.md` | `@AGENTS.md` の 1 行です。Claude Code に同じ指示を読ませます |

Claude Code はフォルダを信頼するまで `.mcp.json` を読みません。起動時の確認で信頼を選んでから `/mcp` で確認してください。
