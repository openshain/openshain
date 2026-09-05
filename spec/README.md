# spec

人が読む仕様と、コードから生成した JSON Schema を置く場所です。

- 原本は `packages/core` の型と schema です。ここにある JSON Schema は生成物なので、手で編集しません。
- provider contract、Work とイベントの schema、Profession Pack の仕様を置きます。
- `*.plan.md` は同名の spec の実装計画です。タスクと checkpoint を持ち、進捗に合わせて更新します。

## 一覧

| spec | 状態 | 内容 |
|---|---|---|
| [open-runtime.md](open-runtime.md) | v0.3(実装済み) | Model、Tool、入口を交換できる Runtime です。ModelProvider と ToolProvider のインターフェース、Work とイベント、CLI と MCP を決めます |
| [open-runtime.plan.md](open-runtime.plan.md) | draft | 上の spec の実装計画です。19 タスク、5 checkpoint |
| [interactive-cli.md](interactive-cli.md) | draft v0.1 | `openshain` の画面です。社員エージェントと話し、作業は Work に出します。セッションの記録と社員エージェントの道具を決めます |
| [interactive-cli.plan.md](interactive-cli.plan.md) | draft | 上の spec の実装計画です。5 タスク、1 checkpoint |

## JSON Schema(`schemas/`)

`bun run schemas` が `packages/core` の zod schema から生成します。draft 2020-12 です。手で編集せず、CI が最新かを確かめます。

| ファイル | 内容 |
|---|---|
| `schemas/config.v1.json` | `openshain.yaml` |
| `schemas/events.v1.json` | `work/<id>/events.jsonl` の 1 行です。envelope は厳密に、payload は知らない項目を通します。知らない type は payload を問わず通します |
| `schemas/work.v1.json` | `work/<id>/work.json` |

zod の refine で書いた条件(`tools` の項目は `provider` か `module` のどちらか 1 つ、`base_url` に認証情報を含めない)は JSON Schema に出ません。JSON Schema で通っても Runtime が拒むことはあります。`format`(date-time、uri)は、ajv-formats のように format を知る検証器でだけ効きます。
