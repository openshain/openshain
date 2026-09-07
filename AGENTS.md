# openshain

An agent harness that turns a general agent into a professional employee of a company. TypeScript on Bun. Apache-2.0.

## Tech stack

- Bun 1.3 as runtime, package manager and test runner. TypeScript strict. Biome for lint and format.
- Bun workspaces monorepo. Inside the repository the packages resolve to TypeScript source (the `bun` condition of `exports`), so development needs no build. For npm, `bun run build:packages` emits JavaScript and declarations into each package's `dist/` (the `import` and `types` conditions; the CLI's `bin` is `dist/bin.js`), and `prepublishOnly` runs it. Published packages run on Node 22 and Bun. `bun run build` compiles the CLI into one binary, `dist/openshain`.
- One root `tsconfig.json` covers every package.

## Commands

- Install: `bun install`
- Type check: `bun run typecheck`
- Lint / format: `bun run lint`, `bun run format`
- Test: `bun test`
- Build the CLI binary: `bun run build`
- Build the npm packages: `bun run build:packages` (in dependency order; a package's `tsconfig.build.json` resolves its siblings through their `dist/`)
- Schemas: `bun run schemas` regenerates `spec/schemas/` from the zod schemas in `packages/core`; CI fails when the committed files are stale

## Layout

- `packages/core` contracts (provider interfaces), fundamental objects, work runtime
- `packages/agent` the conversation loop of the interactive CLI, an MCP client of the runtime, and the model providers (bring your own key)
- `packages/tools` standard tool provider (filesystem, CSV, Markdown, documents, email)
- `packages/mcp` MCP server exposing the runtime: its only surface, used by the interactive CLI and by outside agents alike
- `packages/cli` the `openshain` reference CLI
- `spec/` human-readable specs and JSON Schemas generated from `packages/core`
- `docs/` user-facing documentation in Japanese; `docs/design/` says why each package is shaped as it is
- `packs/` profession packs (none yet)
- `examples/` fictional sample companies and sample extensions such as tool providers

## Conventions

- Contracts live in `packages/core`. Every implementation, official or third-party, uses the same contracts. Nothing under `packages/` imports from `packs/` or `examples/`.
- Money, authority checks, state transitions and safety conditions are ordinary code, never model output.
- The runtime (core, tools, mcp) never calls a model. Clients do: the interactive CLI brings its own model and reaches the runtime only through the MCP tools, exactly like Claude Code. `@openshain/agent` does not import `WorkStore` or `ToolRegistry`; a test enforces it.
- Named exports only. Tests sit next to the source: `work.ts` has `work.test.ts`.
- Runtime code uses no Bun-only API (`Bun.*`); it runs on Node and Bun alike through `node:` modules and web standards. Tests may use `bun:test`. A test enforces this.
- Code, comments and commit messages are in English. User-facing docs are written in Japanese first, in the polite です・ます style: README, docs, specs, plans, CHANGELOG, CONTRIBUTING and SECURITY alike. Headings, table headers and bullet fragments stay as noun phrases; a bullet that is a sentence ends in です・ます.
- The README opens with one short real exchange from the interactive CLI, then says who the reader is talking to. Feature bullets lead with a bold label (`**対話型 CLI**: ...`). Every line in a command block carries a comment saying what it does. Procedures are numbered steps; links are bullets. Say what exists today and what is in development, and never describe a command, file or binary that is not shipped. Keep README.en.md a section-for-section mirror of README.md.
- Japanese docs use the words a Japanese engineer would say, not literal translations of English design jargon: エージェント rather than Agent for an agent, インターフェース rather than 契約 for contract, 範囲 rather than 窓 for what a reading tool returns, 原本 rather than 正本 for the source of truth, 残り回数 rather than 予算 for the budget notice, 同じ入力なら同じ結果 rather than 決定的.
- Japanese docs and CLI messages use the verbs of a written technical document, not spoken ones: 追加する rather than 足す, 削除する rather than 消す, 修正する rather than 直す, 表示する / 出力する / 公開する rather than 出す, 変更する rather than 触る, 確認する rather than 見る, 受け付けない rather than 断る, 依頼する rather than 頼む, 実行する rather than 走る or 打つ. Ordinary written verbs (作る, 書く, 読む, 持つ, 残す, 止まる) stay as they are. Say what happens rather than what is possible: 〜します rather than 〜できます or 働けます unless the capability itself is the point. No body metaphors (手, 目, 顔): name the thing (手段, 操作). 「同じです」 must say what is the same (同じ手順で動きます).
- Commit messages follow Conventional Commits and say what changed in the product.
- The project calls itself an agent harness (エージェントハーネス) wherever it describes itself. "Runtime" names the component that runs works, not the project. The model the person talks to on the screen is called the 社員エージェント (employee agent in English); 担当 is not used for it.

## How to work here

- Before a non-trivial change, write down the assumptions you are making and what done looks like. If the change adds or alters a contract, put the spec under `spec/` first.
- Work in thin vertical slices: one contract, one command or one tool at a time, each with its test, before widening.
- Prefer the boring solution. A new abstraction needs two concrete uses.
- A tool that observes returns a window and the counts around it, never a whole file. Counting, adding and searching happen in the tool, not in the model.
- When a change alters how a package works, update its note under `docs/design/` in the same commit. The note holds the reasons; the spec holds the numbers.
- Touch only what the task needs. Do not reformat, rename or clean up unrelated code.
- If the spec, the code and this file disagree, stop and ask. Do not pick one silently.
- A change is done when `bun run typecheck`, `bun run lint` and `bun test` pass and the new behavior has a test. Run them; do not claim completion from reading alone.
- Maintainers commit to `main` once the checks pass; contributions from outside come as pull requests. Use a branch only for an experiment that may not land. Pull before starting a change, and undo a change with `git revert` rather than by rewriting history.

## Boundaries

- Examples, fixtures and tests use fictional companies and fictional data only. Never commit real company data, credentials or personal data.
- Do not add a dependency without saying why in the commit message. The screen is drawn with Ink and React; the rest of the CLI prints plain lines and takes no color or spinner library.
- Ask before changing a public contract in `packages/core` or a file under `spec/`.
- The official website builds from this repository at a release commit and reads only the paths listed in [docs/website-integration.md](docs/website-integration.md). Moving, renaming or deleting one of them is a breaking change: update that table in the same commit.
- How contributions arrive, for people: [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).
