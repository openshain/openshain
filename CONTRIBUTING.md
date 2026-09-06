# 貢献のしかた

English follows the Japanese.

## 進め方

- バグや提案は GitHub の Issue へ。再現できる手順か、変えたい振る舞いを書いてください
- コードの変更は fork から Pull Request で。1 つの PR で 1 つのことを変えます
- PR は CI(typecheck、lint、test、schema の差分、audit)が通ることが条件です。手元では `bun run typecheck`、`bun run lint`、`bun test` を回してください
- 振る舞いを変える PR には、その振る舞いのテストを含めてください。package の形を変えるなら `docs/design/` のノートも修正します。インターフェース(`packages/core`)や `spec/` を変えるときは、先に Issue で相談してください
- コード、コメント、commit message は英語で書きます。利用者向けの文書は日本語で、文体は「です・ます」です。commit message は Conventional Commits(feat、fix、docs、chore、refactor、test)に従います
- 規約と構成は [AGENTS.md](AGENTS.md) にまとめてあります。人にもエージェントにも同じ規約です
- 例、fixture、テストには架空の会社と架空のデータだけを使います。実在の会社のデータ、認証情報、個人情報は入れません

メンテナは CI が通った変更を main に直接 commit します。外からの貢献は PR で受けます。

## ライセンス

貢献したコードは、このリポジトリと同じ Apache-2.0 で提供されたものとして扱います。

---

## How to contribute (English)

- Bugs and proposals go to GitHub Issues, with steps to reproduce or the behavior you want changed.
- Code changes come as pull requests from a fork, one change per PR.
- A PR must pass CI (typecheck, lint, test, schema diff, audit). Locally: `bun run typecheck`, `bun run lint`, `bun test`.
- A PR that changes behavior includes a test for it. A change to a package's shape updates its note under `docs/design/`. Open an issue before changing a contract in `packages/core` or anything under `spec/`.
- Code, comments and commit messages are in English; user-facing documents are in Japanese, in the polite です・ます style. Commit messages follow Conventional Commits.
- Conventions and layout are in [AGENTS.md](AGENTS.md), the same for people and agents.
- Examples, fixtures and tests use fictional companies and fictional data only.

Maintainers commit to `main` directly once CI passes; outside contributions arrive as pull requests. Contributions are accepted under the repository's Apache-2.0 license.
