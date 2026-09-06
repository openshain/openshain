# examples

架空の会社と、Runtime を拡張する例を置く場所です。自社の実データは置きません。

- `tools/echo/tool.ts` は最小の Tool provider です。`openshain.yaml` の `tools` に `- module: ./tools/echo/tool.ts` と書くと、`openshain tools list`、`openshain run`、MCP の 3 つから呼び出します
