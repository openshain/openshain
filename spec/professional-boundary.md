# Spec: 専門職の責務境界

Status: draft(設計の定義です。Authority、Need-to-Know、Approval、Expert Review、Profession Pack は未実装で、この spec はそれらを実装するときの拠り所です)

## 目的

openshain は、会社の決まりと権限、そして必要なときは資格ある専門家の判断を、社員エージェントが安全に業務へ適用するためのエージェントハーネスです。社員エージェントは専門職の判断を業務に適用しますが、その判断を確定する資格者にはなりません。弁護士、税理士、社労士、司法書士、行政書士のような資格者になることも、その資格業務を無条件に代替することも目指しません。

この境界を「これは法的助言ではありません」のような免責表示で作りません。Runtime、Profession、Work、Review の設計として表します。何を社員エージェントが行い、何を会社に残し、何を専門家の Review に送り、Runtime がどの Gate を強制するかを、この spec が決めます。

法律論はここに書きません。個々の士業法の解釈は仕様に推測で書かず、未確定事項として残します(末尾)。

### やらないこと

- 資格名や士業法の規則を `packages/core` に置くこと。core が持つのは一般化した判定の種類だけです
- 専門家の確認を、社員エージェントが呼べる Tool にすること
- openshain 公式の専門家ネットワークに依存すること。専門家は会社が指名します(Bring Your Own Expert)
- 「専門判断は利用者の責任」で Runtime の責務まで免責すること

## 処理の 5 区分

社員エージェントの処理を 5 つに分けます。1 から 4 は社員エージェントの仕事で、5 は資格ある Reviewer の承認済み判断があるときだけ適用します。

| 区分 | 内容 | 例 |
|---|---|---|
| 1. 事実の取得 | ファイルや記録から事実を取り出す | 契約書に責任上限の条項がある。請求書の支払期限はこの日付である。この法令のこの条文にはこう書いてある |
| 2. Source の検索と要約 | 法令、通達、ガイドライン、判例、会計基準などを検索し、出典を示して整理する | インボイスに関する Q&A の該当箇所を出典つきで並べる |
| 3. Company Rule の適用 | 会社が決めたことを当てはめる。過去の Decision と照合する | 当社の契約ポリシーでは責任上限を 12 か月分とする。当社の会計方針ではこの取引をこう処理する |
| 4. 業務上の提案 | 1 から 3 をもとに、次に行う社内の手続きを提案し、SaaS や文書の操作を準備する | この請求書は経費規程に沿うので支払の起票を提案する |
| 5. 資格に関わる個別判断 | 個別の案件について適法か違法かを確定する。税務上の取扱いを個別に確定する。紛争の責任や勝敗を判断する。資格者に独占された代理、申請、書類の作成を行う | この支出は税務上、損金にできると確定する。登記を申請する |

1 から 4 と 5 を同じものとして扱いません。社員エージェントは 5 を自分で確定せず、Reviewer の承認済み判断(Decision)があるときに、それを 3 と 4 の形で適用します。

どの業務が 5 に当たるかは、法域と職種で違います。その分類は core ではなく、Jurisdiction、Profession Pack、会社の Policy が持ちます。

## Authority の判定の種類

Authority engine(open-runtime.md の `authorize` の差し込み口に入るもので、未実装)は、Work と Action(Tool の呼び出し、外部への効果)ごとに次のどれかを返します。

| 判定 | 意味 | Work の状態 |
|---|---|---|
| `allow` | 通常どおり実行する | `in_progress` |
| `approval_required` | 会社の人(principal か委任された人)の承認が要る | `waiting_approval` |
| `review_required` | 条件を満たす Reviewer の承認が要る。条件は Policy が書く(例: 会社が指名した税理士) | `waiting_approval`。Review Package を作る |
| `deny` | 実行しない | 記録して止まる |
| `decision_backed` | 承認済みの Decision を参照して実行する。Decision の id を記録に残す | `in_progress` |

判定はコードが行います。model の出力で判定を変えません。どの Action がどの判定になるかは、`authority/` と Profession Pack の Policy が決め、core はその表を読むだけです。

## Expert Review の流れ

```
Work
  ↓
Authority が判定する(区分 5 に当たるか、Policy に照らす)
  ↓
review_required でない → Work を続ける
review_required
  ↓
Review Package(事実、Source、適用した Company Rule、社員エージェントの提案、問い)
  ↓
Reviewer(会社が指名した資格者)
  ↓
approve / reject / modify
  ↓
承認済みの Decision / Interpretation(記録に残る)
  ↓
社員エージェントが業務へ適用する(decision_backed)
```

- Reviewer は Review Authority です。Tool ではありません。社員エージェントが Review を呼ぶのではなく、Runtime が Work を止めて Review Package を渡し、Decision が記録されるまで先へ進みません
- Decision は Work の記録と会社の `rules/`(Company Rule)に残り、同じ問いに再び使えます。有効日と出典(どの Reviewer が、どの Review Package に対して)を持ちます
- 社員エージェントが Decision を適用することと、社員エージェント自身が資格者として判断を確定することは別のものです。後者は起きません
- 最初の実装は Email 経由の人手です。専門家への送付と返答の記録が形になっていれば足ります

## Runtime 自身が負う責務

「専門判断は利用者の責任」で全体を免責しません。Runtime は次を約束します。

- 設定された Authority を正しく強制する。判定はコードが行う
- `approval_required` と `review_required` の Action を、承認なしに実行しない
- 社員エージェントが誰の代理で動いたか(principal、Delegation)を Work に残す
- 実行した Action と結果を Work のイベントとして記録する
- Source、Evidence、Decision の出どころ(provenance)を失わない
- Need-to-Know を入れた後は、認可されていない情報を model に渡さない
- Pause、deny、approval_required、review_required の状態遷移を model に任せない

金額、権限、状態遷移、安全の判定を model の出力にしない原則(AGENTS.md)は、この spec にも当てはまります。

## core と Profession Pack の境界

| 置き場 | 持つもの | 持たないもの |
|---|---|---|
| `packages/core` | 判定の種類(上の 5 つ)、Review Package と Decision の記録の形、Authority の差し込み口 | 資格名、士業法、日本固有の規制、どの業務が区分 5 かの表 |
| Profession Pack、Jurisdiction | 職種と法域ごとの、どの業務がどの判定になるかの既定の表。Review Package のひな型。Rule の template | Gate を越える判断 |
| 会社の Policy(`authority/`、`rules/`) | 会社としての判定の表(Pack の既定を上書きできる)。指名した Reviewer と、その条件 | |

公式の Pack も第三者の Pack も、会社が自分で書く Policy も、同じ形で core に読まれます。公式の Pack や Managed Service だからといって、隠れた権限で区分 5 の判断を生成する経路はありません。公式が提供するのは、Source の継続更新、一般的な Workflow、Company Rule の template、Review の workflow、専門家が確認した資料、運用代行です。会社固有の個別判断が `review_required` になったときは、公式でも Gate で止まります。

## 回答の種類

社員エージェントの返答と Review Package の中身では、次を区別します。

| 種類 | 例 |
|---|---|
| 事実 | 契約書の第 12 条に責任上限の条項があります |
| Source の要約 | 国税庁の Q&A 問 76 は、この場合の保存期間を 7 年としています |
| Company Rule | 当社の契約ポリシーでは責任上限を 12 か月分としています |
| 業務上の提案 | このポリシーへの重大な逸脱は検出されませんでした。法的な有効性について専門家の判断が要る項目は別に示します |
| 専門家の見解 | 税理士の Decision(2026-09-01)により、この処理で進めます |

避ける形の例。「この契約は法的に問題ありません」「この支出は税務上、損金にできます」。望ましい形の例。「当社の契約ポリシーへの重大な逸脱は検出されませんでした。法的有効性について専門家の判断が必要な項目は別に示します」「当社の会計 Rule ではこの処理が候補です。税務上の取扱いについて承認済みの判断がないため、専門家確認が必要です」。

文言を固定することが目的ではありません。この区別は Work の流れ(どの区分の処理をしたか、Decision があるか)と記録で表します。5 種類を public schema にするかは、経理 Pack の提案文と Review Package の 2 つの利用例が出てから決めます。

## 完了の条件(この spec を実装するとき)

1. Authority が上の 5 種類を返し、`review_required` の Action が承認なしに実行されないことをテストで示す
2. Review Package と Decision が Work の記録に残り、Decision を参照した実行が `decision_backed` として記録される
3. core のソースに資格名と士業法が現れないことを、テストか lint で確かめる
4. 公式の Pack と第三者の Pack が同じ形で読まれ、公式だけが使う経路がないことをテストで示す

## 未確定

- Reviewer の資格を openshain は検証しません。会社が Reviewer を指名し、資格は会社の申告として記録します。検証の仕組みを持つかは決めていません
- 日本の士業法でどの業務が区分 5 に当たるか(税務相談、法律事件の判断、社会保険と労働関係の手続、登記、許認可など)は、経理 Pack を作るときに税理士と確認して Pack の表に書きます。ここでは決めません
- Decision の有効期限と、法令の改正で Decision が古くなったときの扱い
- 会社の人による `approval_required` と、Reviewer による `review_required` を同じ画面で扱うか
