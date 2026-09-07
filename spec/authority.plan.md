# 実装計画: Authority(権限と承認)

spec は [authority.md](authority.md) です。小さい縦の切れ目で進め、切れ目ごとにテストを通して commit します。各 Task で `bun run typecheck`、`bun run lint`、`bun test` を通し、package の振る舞いを変える Task は `docs/design/` のノートを同じ commit で更新します。

#### Task 0: 基本情報の Tool

社員エージェントに現在時刻、タイムゾーン、今日の業務日、会社フォルダの path、代理する Principal を渡す Runtime Tool `context`(名前は予約)を追加します。投影は記録から同じ結果になる規則なので、system prompt に時刻を直接入れず、Tool の結果として記録します。対話の開始時に client が 1 回呼ぶ形にします。

- 受け入れ: `context` が MCP と対話型 CLI の両方で呼べ、結果が `tool.completed` に残ります。同じ記録から同じ投影ができます
- 検証: `bun test packages/mcp packages/agent`
- サイズ: S

#### Task 1: Policy の読み込みと判定

`authority/policy.yaml` と `authority/delegations.yaml` の schema(zod)、読み込み、判定の関数(規則の順、`match` の AND、glob、`default`)。`authorize()` に差し込み、`allow` と `deny` を動かします。`principals/` と `authority/` を予約パスにします。JSON Schema を生成します。

- 受け入れ: 完了の条件 1、5、6。`deny` が `tool.rejected`(denied)で記録されます
- 検証: `bun test packages/core`、`bun run schemas`
- サイズ: M

#### Task 2: 承認の流れ

`approval.requested` と `approval.decided`、`waiting_approval`、MCP の `approval_list` と `approval_decide`、承認後の実行。client の loop が `pending: "approval"` を受けたときの扱い(人に知らせて turn を終える)。対話型 CLI の表示と `/approve`、`/reject`、`/approvals`。`work show` の表示。

- 受け入れ: 完了の条件 2 と 7
- 検証: `bun test packages/mcp packages/agent packages/cli`、擬似端末で実走
- サイズ: L

#### Task 3: Review と Decision

`review_required`、Review Package の生成と `work/<id>/review/` への写し、`review.requested`、`review_decide`、`authority/decisions/` への書き込み、`decision_backed` の判定、`decision.applied`。`/review <id> approve` の入力。

- 受け入れ: 完了の条件 3 と 4
- 検証: `bun test`、`bun run schemas`
- サイズ: M

#### Task 4: 文書と版

docs/design/core.md(判定の置き場と glob の理由)、docs/design/mcp.md(承認の Tool)、docs/design/cli.md(承認の表示)、docs/configuration.md(`authority/` の書き方)、README(できることに 1 行、しないことの注記を更新)、CHANGELOG。3 観点のレビュー。0.4.0。

- 受け入れ: 文書に未実装の記述が残らないこと。README の「権限、承認はこれから」が消えること
- サイズ: M
