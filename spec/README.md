# spec

人が読む仕様と、コードから生成した JSON Schema を置く場所。

- 正本は `packages/core` の型と schema。ここにある JSON Schema は生成物なので、手で編集しない。
- provider contract、Work とイベントの schema、Profession Pack の仕様を置く。
- `*.plan.md` は同名の spec の実装計画。タスクと checkpoint を持ち、進捗に合わせて更新する。

## 一覧

| spec | 状態 | 内容 |
|---|---|---|
| [open-runtime.md](open-runtime.md) | draft v0.2 | Model、Tool、入口を交換できる Runtime。ModelProvider と ToolProvider の契約、Work とイベント、CLI と MCP |
| [open-runtime.plan.md](open-runtime.plan.md) | draft | 上の spec の実装計画。19 タスク、5 checkpoint |
