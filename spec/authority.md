# Spec: Authority(権限と承認)

Status: v0.1(実装済み。完了の条件 1 から 7 を満たしています。ChangeSet と Need-to-Know、端末の認証、専門家への送付の自動化は後の版です)

## 目的

社員エージェントが誰の代理で、どこまでのことをしてよいかを会社が書き、Runtime がそれを強制します。証明したいことは 2 つです。権限のない代理では該当の Action が実行されないこと。承認が要る Action が、人か Reviewer の承認なしに外へ効果を出さないことです。

判定はコードが行います。モデルの出力で判定を変えません。判定の表は人が YAML で書きます。対話で社員エージェントに聞かれて答える形は後の版です。

### やらないこと(この版では)

- Need-to-Know(検索と投影の前の認可)。Knowledge の版で扱います
- ChangeSet(提案と差分と適用の分離)。金額のような値の条件は、差分が取れてから追加します。この版の判定の単位は Tool と path の組です
- 専門家への Review Package の送付。この版は記録の形だけを作り、送付は Email 経由の人手です
- 複数人の同時承認、承認の代理、端末の認証。承認するのは会社の人 1 人です
- Reviewer の資格の検証。会社の申告として記録します

## 用語

- Principal: 会社の人です。`openshain.yaml` の `principal` が既定の依頼者で、`principals/` に他の人を書きます
- Delegation: 代表者から社員エージェント(職種)への職務権限の委任です。誰の代理で、どの職種として、いつからいつまで働くかを書きます
- Resource: Action の対象です。この版では Tool の名前と、入力の `path` です
- Action: Tool の呼び出しです。effect(observe か mutate)と名前を持ちます
- Context: 判定に使う周辺の事実です。この版では代理する Principal、Work の type、業務日です
- 判定: `allow`、`approval_required`、`review_required`、`deny`、`decision_backed` の 5 つです(professional-boundary.md)
- Approval: 会社の人による承認です。Review: 会社が指名した Reviewer による承認です。Decision: Review の結果として記録される承認済みの判断です

## Company Workspace への追加

```
<workspace>/
├── openshain.yaml
├── principals/
│   └── <id>.yaml            会社の人。id、name、role、approver(承認できるか)
├── authority/
│   ├── policy.yaml          判定の表
│   ├── delegations.yaml     委任
│   └── decisions/
│       └── <id>.yaml        承認済みの Decision(Review の結果)。decision_backed が参照する
└── work/<id>/
    └── review/<approval-id>.json   Review Package(送付用の写し。Runtime が書きます)
```

`principals/` と `authority/` は Runtime の予約パスです。Tool からは読み書きとも拒否します。無いときは、`openshain.yaml` の `principal` だけが Principal で、判定の表は空(すべて `allow`)です。いまの workspace はそのまま動きます。

### `authority/policy.yaml`

```yaml
version: 1
default: allow                     # どの規則にも一致しないときの判定
rules:
  - id: ledger-writes-need-approval
    match: { tool: [fs_write, csv_write], path: "ledger/**" }
    decision: approval_required
    approvers: [alice]             # principals の id。省略時は openshain.yaml の principal
  - id: contracts-are-read-only
    match: { effect: mutate, path: "contracts/**" }
    decision: deny
    reason: 契約書は社員エージェントが変更しません
  - id: tax-treatment-needs-review
    match: { action: tax-treatment }   # Pack や Policy が Action に付ける名前。この版では Tool の名前と同じ扱い
    decision: review_required
    reviewer: { role: tax-accountant }
  - id: apply-approved-treatment
    match: { action: tax-treatment }
    decision: decision_backed
    decision_id: dec_2026-09-01-consumption-tax
```

- 規則は上から順に見て、最初に一致したものを採ります。一致しなければ `default` です
- `match` の項目は AND です。`tool`(名前か名前の並び)、`effect`、`path`(glob。入力に `path` が無い呼び出しには一致しません)、`principal`、`work_type`、`action`
- `path` の glob は workspace root からの相対パスに対して `*`(1 段)と `**`(何段でも)を使います。判定は path guard を通した後の正規化したパスに対して行います
- `decision_backed` は `decision_id` の Decision が `authority/decisions/` にあり、有効日の中にあり、`applies_to`(action と path)がその呼び出しを覆うときだけ `allow` と同じに動き、`decision.applied` を記録します。どれかを満たさなければ `review_required` として扱い、理由を呼び出し元に返します。無ければ `review_required` として扱います
- 資格名や法域の規則は core に置きません。`action` の名前と `reviewer.role` は Pack や会社の Policy が決める文字列で、core はそれを比べるだけです

### `authority/delegations.yaml`

```yaml
version: 1
delegations:
  - principal: alice               # 誰の代理で
    profession: generic            # どの職種として
    valid_from: 2026-09-01
    valid_until: null
```

Work の Principal と profession に対する委任が無ければ、その Work の Action はすべて `deny` です。`authority/` が無い workspace では、`openshain.yaml` の principal と profession の組に委任があるものとみなします。

## Runtime の振る舞い

Tool を実行する直前の `authorize(call)`(open-runtime.md)が、許可リストの判定に続けて Policy を評価します。

| 判定 | Runtime がすること | Work の状態 |
|---|---|---|
| `allow` | 実行し、記録する | `in_progress` |
| `deny` | 実行せず `tool.rejected`(code `denied`、reason は規則の `reason`)を記録する | `in_progress` |
| `approval_required` | `approval.requested`(approval_id、call、規則、approvers)を記録し、`waiting_approval` にする。呼び出し元には `pending: "approval"` と approval_id を返す | `waiting_approval` |
| `review_required` | Review Package を作って `review.requested` を記録し、`waiting_approval` にする。呼び出し元には `pending: "review"` と reviewer の条件を返す | `waiting_approval` |
| `decision_backed` | Decision を確かめ、`decision.applied`(decision_id)を記録して実行する | `in_progress` |

- 承認は `approval_decide`(approval_id、`approve` か `reject`、by、comment)で記録します。`approve` なら Runtime がそのときに Tool を実行し、`tool.called` と `tool.completed` を残して `in_progress` に戻します。`reject` なら `tool.rejected`(code `rejected_by_person`)を残して `in_progress` に戻します。client は結果を model に渡します
- Review の結果は `review_decide`(approval_id、`approve` か `reject` か `modify`、reviewer、interpretation、任意で applies_to と有効日)で記録します。`approve` と `modify` は Decision を `authority/decisions/<id>.yaml` に書き、`review.decided` を残し、Runtime が Action を実行します。`modify` は Reviewer が書き換えた入力で実行しますが、触る先(`path`)は保留した呼び出しと同じでなければ受け付けません。規則が `reviewer.role` を指定していれば、その役の名で決めなければ受け付けません。Decision の id は 1 つのパスの要素で、`/` や `..` を含みません。`reject` は Decision を書かず、`tool.rejected`(`rejected_by_person`)を残します。承認の Tool(`approval_decide`)では Review を決められず、その逆もできません
- `waiting_approval` の Work では、承認待ちの呼び出し以外の Tool 呼び出しを受け付けません(`ask_user` の `waiting_input` と同じ規則)
- 承認する人の確認は、この版では接続を通して行います。対話型 CLI と MCP の接続は `openshain.yaml` の principal として動くので、その principal が `approvers` に居れば承認できます。端末の認証と複数人は後の版です
- 「この会話では常に承認する」は client の中だけの決定です。`authority/` には書かず、会話を閉じれば消えます。承認の記録は毎回残ります。`review_required` にはこの選択肢を出しません。資格者の承認を人が肩代わりできないためです

### Review Package

```json
{
  "approval_id": "apr_…",
  "work_id": "work_…",
  "action": { "name": "tax-treatment", "tool": "csv_write", "input": { "path": "ledger/2026-07.csv" } },
  "facts": ["…事実の取得の結果…"],
  "sources": [{ "id": "law/…", "locator": "…", "version": "…" }],
  "company_rules": [{ "id": "…", "statement": "…" }],
  "proposal": "社員エージェントの提案",
  "question": "Reviewer への問い",
  "requested_by": "alice",
  "requested_at": "…"
}
```

facts、sources、company_rules は、この版では Work の記録から取れる範囲(Tool の結果と社員エージェントの文)で埋めます。Knowledge の版で Source と Rule の id が付きます。

### Decision

```yaml
id: dec_2026-09-01-consumption-tax
reviewer: { name: "…", role: tax-accountant, qualification: "会社の申告。openshain は検証しない" }
approval_id: apr_…
decided_at: 2026-09-01
effective_from: 2026-09-01
effective_until: null
interpretation: |
  Reviewer が書いた判断の本文
applies_to: { action: tax-treatment, path: "ledger/**" }
```

## イベント

| type | payload |
|---|---|
| `approval.requested` | approval_id、call(call_id、name、input)、rule_id、kind(`approval` か `review`)、approvers か reviewer |
| `approval.decided` | approval_id、decision(`approve`、`reject`、`modify`)、by、comment、modified_input(modify のとき) |
| `review.requested` | approval_id、package(Review Package) |
| `review.decided` | approval_id、decision_id |
| `decision.applied` | call_id、decision_id |

`tool.rejected` の code に `denied` と `rejected_by_person` を追加します。

## 入口

- MCP: `approval_list`(承認待ちの一覧。approval_id、work_id、kind、action、要求した時刻)、`approval_decide`、`review_decide`。名前は予約です
- 対話型 CLI: 承認が要る呼び出しが起きると、入力欄が選択の画面に変わり、呼び出し、規則、変わる中身の差分と 3 つの選択肢(実行する、この会話では常に承認する、実行しない)が出ます。選ぶとターンはそのまま続きます。会話をまたぐ承認や、外のエージェントが残した承認待ちには `/approvals`、`/approve <id>`、`/reject <id>` を使います。Review の結果は、Email で受け取った内容を `/review <id> approve` の形で人が記録します(この版は人手)
- `openshain work show <id>` は承認待ちの呼び出しと、Review Package の置き場を表示します
- Claude Code から使うときは、承認が要る呼び出しの結果に `pending` が返ります。承認は会社の人が `openshain` の画面か `approval_decide` で行います

## 設定

`openshain.yaml` に追加しません。判定の表は `authority/` にあります。

## 完了の条件

1. 委任のない Principal の代理の Work では、mutate の Tool がすべて `deny` になることをテストで示す
2. `approval_required` の呼び出しが `waiting_approval` で止まり、承認なしにファイルが変わらないこと。`approve` で実行され、`reject` で実行されないことをテストで示す
3. `review_required` の呼び出しで Review Package が記録に残り、`review_decide` の `approve` で Decision が書かれ、その後の同じ Action が `decision_backed` で通ることをテストで示す
4. 判定が Policy の表とコードだけで決まること。model の出力(投影の system prompt を含む)に判定の分岐が無いことをテストで示す
5. `authority/` の無い既存の workspace が、この版でも同じに動くこと
6. core のソースに資格名と士業法が現れないことを lint かテストで確かめる
7. 対話型 CLI で、承認が要る呼び出しの表示、`/approve`、`/reject`、`/approvals` が動くことを ink-testing-library で示す

## 未確定

- 承認する人の確認。この版は接続の principal で代えます。MCP で接続した外部のエージェントは、自分が止められた呼び出しを自分で承認できます(SECURITY.md に明記)。端末の認証(device authorization)は後の版
- 規則の照合は、Tool に渡されたパスの文字列を正規化して行います。symlink と、大文字小文字を区別しないファイルシステムでは、照合と実際の書き込み先がずれます。実行時の path guard は別に働きます。解決済みのパスで照合するかは、ChangeSet の版で決めます
- Delegation の形。この版は principal と profession と期間だけです。範囲(どの Resource か)を委任に持たせるかは、Policy との重複を確認してから決めます
- `action` の名前の付け方。この版は Tool の名前と同じ扱いで、Pack が Action の名前を Tool 呼び出しに付ける形は Pack の版で決めます
- Decision の有効期限と、法令の改正で古くなった Decision の扱い
- 金額の条件。ChangeSet の差分が取れてから決めます
