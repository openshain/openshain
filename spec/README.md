# spec

人が読む仕様と、コードから生成した JSON Schema を置く場所。

- 正本は `packages/core` の型と schema。ここにある JSON Schema は生成物なので、手で編集しない。
- provider contract、Work とイベントの schema、Profession Pack の仕様を置く。
- `*.plan.md` は同名の spec の実装計画。タスクと checkpoint を持ち、進捗に合わせて更新する。

## 一覧

| spec | 状態 | 内容 |
|---|---|---|
| [open-runtime.md](open-runtime.md) | v0.3(実装済み) | Model、Tool、入口を交換できる Runtime。ModelProvider と ToolProvider の契約、Work とイベント、CLI と MCP |
| [open-runtime.plan.md](open-runtime.plan.md) | draft | 上の spec の実装計画。19 タスク、5 checkpoint |

## JSON Schema(`schemas/`)

`bun run schemas` が `packages/core` の zod schema から生成する。draft 2020-12。手で編集せず、CI が最新かを確かめる。

| ファイル | 内容 |
|---|---|
| `schemas/config.v1.json` | `openshain.yaml` |
| `schemas/events.v1.json` | `work/<id>/events.jsonl` の 1 行。envelope は厳密、payload は知らない項目を通す。知らない type は payload を問わず通す |
| `schemas/work.v1.json` | `work/<id>/work.json` |

zod の refine で書いた条件(`tools` の項目は `provider` か `module` のどちらか 1 つ、`base_url` に認証情報を含めない)は JSON Schema に出ない。JSON Schema で通っても Runtime が拒むことはある。`format`(date-time、uri)は、ajv-formats のように format を知る検証器でだけ効く。
