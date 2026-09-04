# examples

架空の会社と、Runtime を拡張する例を置く場所。自社の実データは置かない。

- `tools/echo/tool.ts` 最小の Tool provider。`openshain.yaml` の `tools` に `- module: ./tools/echo/tool.ts` と書くと、`openshain tools list`、`openshain run`、MCP の 3 つから呼べる
