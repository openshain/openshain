# openshain

Open Company Profession Runtime: turns any agent into a professional employee of your company.

General agents such as Claude, Codex and Gemini cannot work as employees of a company on their own. openshain gives them what is missing: knowledge specific to Japan and rules specific to the company, job duties and procedures, the ability to work with SaaS and Office files, authority, approval and escalation to experts, work state that survives a session, and evidence and cost per unit of work.

The Japanese README is the primary one: [README.md](README.md). Reference for the configuration file: [docs/configuration.md](docs/configuration.md) (Japanese). Design notes per package: [docs/design/](docs/design/README.md) (Japanese).

## Status

Early. `openshain run` works with an Anthropic or OpenAI-compatible API key; the only profession so far is `generic`. The first real profession will be an accounting employee.

## Quickstart

You need Bun 1.3, git and an API key for Anthropic or an OpenAI-compatible API.

```
git clone https://github.com/openshain/openshain.git
cd openshain
bun install
bun run build                    # produces dist/openshain
cp dist/openshain ~/.local/bin/  # anywhere on your PATH
openshain --help
```

Create a company folder and a workspace in it:

```
mkdir my-company && cd my-company
openshain init
```

`openshain init` writes `openshain.yaml` (configuration), `.mcp.json` (for Claude Code), `AGENTS.md` (instructions for outside agents) and `CLAUDE.md`. Put your API key in the environment variable named by `api_key_env` in `openshain.yaml`, then:

```
export ANTHROPIC_API_KEY=...
openshain run "Total receipt/2026-07.csv by category and write summary.md"
```

Every tool call prints a line; the run ends with the outcome, the usage and who acts next. Records live under `work/<id>/` and are read with `openshain work list` and `openshain work show <id>`.

To use the same runtime from Claude Code, start `claude` in the same folder, trust the folder when asked, and check `/mcp`. Claude Code thinks; openshain does the file work and keeps the record. Other agents can register `openshain mcp` as a stdio MCP server.

## Entry points

- `openshain` CLI, the reference client. Bring your own model key.
- MCP server: `openshain mcp`.
- SDK: `@openshain/core` and `@openshain/agent`.

## Principles

- Work, not answers.
- Existing SaaS remains the system of record.
- Official has no hidden privilege: the official implementation and third-party implementations use the same contracts.
- Paid means easiest: a paid offering takes over operations, it does not unlock features.

## Development

```
bun install
bun run typecheck
bun run lint
bun test
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0
