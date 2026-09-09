# examples

架空の会社と、ランタイムを拡張する例を置く場所です。自社の実データは置きません。

- `tools/echo/tool.ts` は最小の Tool provider です。`openshain.yaml` の `tools` に `- module: ./tools/echo/tool.ts` と書くと、`openshain tools list` に現れ、対話型 CLI の社員エージェントと、MCP で接続した外部のエージェントの両方から呼び出します
