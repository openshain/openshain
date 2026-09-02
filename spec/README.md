# spec

人が読む仕様と、コードから生成した JSON Schema を置く場所。

- 正本は `packages/core` の型と schema。ここにある JSON Schema は生成物なので、手で編集しない。
- provider contract、Work とイベントの schema、Profession Pack の仕様を置く。

## 一覧

| spec | 状態 | 内容 |
|---|---|---|
| [open-runtime.md](open-runtime.md) | draft v0.1 | Model、Tool、入口を交換できる Runtime。ModelProvider と ToolProvider の契約、Work とイベント、CLI と MCP |
