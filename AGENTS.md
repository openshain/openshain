# openshain

An agent harness that turns a general agent into a professional employee of a company. TypeScript on Bun. Apache-2.0.

## Tech stack

- Bun 1.3 as runtime, package manager and test runner. TypeScript strict. Biome for lint and format.
- Bun workspaces monorepo. Packages export TypeScript source directly (`exports: ./src/index.ts`); the packages have no build step. `bun run build` compiles the CLI into one binary, `dist/openshain`, for distribution.
- One root `tsconfig.json` covers every package.

## Commands

- Install: `bun install`
- Type check: `bun run typecheck`
- Lint / format: `bun run lint`, `bun run format`
- Test: `bun test`
- Build the CLI binary: `bun run build`
- Schemas: `bun run schemas` regenerates `spec/schemas/` from the zod schemas in `packages/core`; CI fails when the committed files are stale

## Layout

- `packages/core` contracts (provider interfaces), fundamental objects, work runtime
- `packages/agent` tool loop and model providers (bring your own key)
- `packages/tools` standard tool provider (filesystem, CSV, Markdown, documents, email)
- `packages/mcp` MCP server exposing the runtime
- `packages/cli` the `openshain` reference CLI
- `spec/` human-readable specs and JSON Schemas generated from `packages/core`
- `docs/` user-facing documentation in Japanese; `docs/design/` says why each package is shaped as it is
- `packs/` profession packs (none yet)
- `examples/` fictional sample companies and sample extensions such as tool providers

## Conventions

- Contracts live in `packages/core`. Every implementation, official or third-party, uses the same contracts. Nothing under `packages/` imports from `packs/` or `examples/`.
- Money, authority checks, state transitions and safety conditions are ordinary code, never model output.
- Named exports only. Tests sit next to the source: `work.ts` has `work.test.ts`.
- Code, comments and commit messages are in English. User-facing docs are written in Japanese first, in the polite です・ます style: README, docs, specs, plans, CHANGELOG, CONTRIBUTING and SECURITY alike. Headings, table headers and bullet fragments stay as noun phrases; a bullet that is a sentence ends in です・ます.
- Japanese docs use the words a Japanese engineer would say, not literal translations of English design jargon: エージェント rather than Agent for an agent, インターフェース rather than 契約 for contract, 範囲 rather than 窓 for what a reading tool returns, 原本 rather than 正本 for the source of truth, 残り回数 rather than 予算 for the budget notice, 同じ入力なら同じ結果 rather than 決定的.
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
- How contributions arrive, for people: [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).
