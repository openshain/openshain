# openshain

Open Company Profession Runtime. TypeScript on Bun. Apache-2.0.

## Tech stack

- Bun 1.3 as runtime, package manager and test runner. TypeScript strict. Biome for lint and format.
- Bun workspaces monorepo. Packages export TypeScript source directly (`exports: ./src/index.ts`); there is no build step yet.
- One root `tsconfig.json` covers every package.

## Commands

- Install: `bun install`
- Type check: `bun run typecheck`
- Lint / format: `bun run lint`, `bun run format`
- Test: `bun test`

## Layout

- `packages/core` contracts (provider interfaces), fundamental objects, work runtime
- `packages/agent` tool loop and model providers (bring your own key)
- `packages/tools` standard tool provider (filesystem, CSV, Markdown, documents, email)
- `packages/mcp` MCP server exposing the runtime
- `packages/cli` the `openshain` reference CLI
- `spec/` human-readable specs and JSON Schemas generated from `packages/core`
- `docs/` user-facing documentation in Japanese
- `packs/` profession packs (none yet)
- `examples/` fictional sample companies and sample extensions such as tool providers (none yet)

## Conventions

- Contracts live in `packages/core`. Every implementation, official or third-party, uses the same contracts. Nothing under `packages/` imports from `packs/` or `examples/`.
- Money, authority checks, state transitions and safety conditions are ordinary code, never model output.
- Named exports only. Tests sit next to the source: `work.ts` has `work.test.ts`.
- Code, comments and commit messages are in English. User-facing docs are written in Japanese first.
- Commit messages follow Conventional Commits and say what changed in the product.

## How to work here

- Before a non-trivial change, write down the assumptions you are making and what done looks like. If the change adds or alters a contract, put the spec under `spec/` first.
- Work in thin vertical slices: one contract, one command or one tool at a time, each with its test, before widening.
- Prefer the boring solution. A new abstraction needs two concrete uses.
- Touch only what the task needs. Do not reformat, rename or clean up unrelated code.
- If the spec, the code and this file disagree, stop and ask. Do not pick one silently.
- A change is done when `bun run typecheck`, `bun run lint` and `bun test` pass and the new behavior has a test. Run them; do not claim completion from reading alone.
- Changes land through pull requests into `main`. Work on a branch named `feat/...`, `fix/...`, `docs/...` or `chore/...`; never push to `main` directly. After a merge, update your local `main` before starting the next change.

## Boundaries

- Examples, fixtures and tests use fictional companies and fictional data only. Never commit real company data, credentials or personal data.
- Do not add a dependency without saying why in the commit message.
- Ask before changing a public contract in `packages/core` or a file under `spec/`.
