# openshain

任意の Agent を、あなたの会社で働く専門社員に変える Open Company Profession Runtime。

Claude や Codex、Gemini のような汎用 Agent は、そのままでは会社の社員として働けません。openshain はそこに次のものを与えます。

- 日本固有の専門知識と、会社固有のルール
- 職務と業務手順
- SaaS や Office を扱う能力
- 権限、承認、専門家へのエスカレーション
- セッションをまたいで残る Work の状態
- 証跡と、Work ごとのコスト

その結果、Agent は経理や法務の社員として働けるようになります。

> まだ経理社員は雇わなくていい。経理は Agent に投げれば進めてくれる。

## 状態

開発初期。まだ動きません。最初の職種は Accounting Employee(経理)です。

## 入口

- `openshain` CLI。参照実装のクライアント。モデルは自分の API キーで使う(BYOK)
- MCP Server。`openshain mcp` で起動し、Claude Code や Codex から同じ Runtime を使う
- SDK。`@openshain/core` をプログラムから使う

## 設計原則

- Work, not answers。業務の完了まで進める
- Existing SaaS remains the system of record。既存の SaaS をそのまま使う
- Official has no hidden privilege。公式実装と第三者実装は同じ contract を使う
- Paid means easiest。有償版が引き受けるのは運用で、機能の解禁ではない

全文は [docs/principles.md](docs/principles.md)。リポジトリの構成は [AGENTS.md](AGENTS.md)。

## 開発

```
bun install
bun run typecheck
bun run lint
bun test
```

## ライセンス

Apache-2.0
