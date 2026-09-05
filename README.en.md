# openshain

Turns a general agent into a professional employee of your company. Open Company Profession Runtime.

[![CI](https://github.com/openshain/openshain/actions/workflows/ci.yml/badge.svg)](https://github.com/openshain/openshain/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/openshain)](https://www.npmjs.com/package/openshain)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

The Japanese [README.md](README.md) is the primary one; documentation is written in Japanese first.

```
$ openshain run "Total receipt/2026-07.csv by category and write summary.md"
fs_list .
csv_read receipt/2026-07.csv
csv_aggregate receipt/2026-07.csv
fs_write summary.md
Wrote the count and total per category to summary.md: 296 receipts, 3,258,930 yen in all.
  wrote summary.md
model calls 5, tool calls 7, input 20862 tokens (18953 cached), output 769 tokens
Nobody needs to act next.
```

Agents such as Claude and Codex cannot work as employees of a company on their own. They lack the company's rules and procedures, hands for SaaS and Office files, authority and approval, work state that survives a session, and evidence and cost. openshain adds these as a runtime.

## Features

- A request becomes a work, fully recorded in `work/<id>/events.jsonl`; stop and resume at will
- Swap the model in configuration: Anthropic and OpenAI-compatible APIs, with your own key
- Standard tools for files, CSV and Markdown, confined to the workspace; results come as windows and aggregates, never whole files
- Use the same runtime from Claude Code or Codex over MCP: the agent thinks, the runtime records
- Add your own tool with one line of configuration, under the same contract as the official ones
- Artifact hashes and usage recorded per work

Authority, approval, escalation to experts and profession packs are still to come. The only profession today is `generic`; the accounting employee is the first one being built.

## Install

Take a binary from [GitHub Releases](https://github.com/openshain/openshain/releases) and put it on your PATH as `openshain`. The macOS binaries are unsigned: run `xattr -d com.apple.quarantine openshain` once.

With Bun:

```
bun install -g openshain
```

From source:

```
git clone https://github.com/openshain/openshain.git
cd openshain
bun install
bun run build   # dist/openshain
```

## Usage

```
mkdir my-company && cd my-company
openshain init                       # writes openshain.yaml, .mcp.json, AGENTS.md, CLAUDE.md
export ANTHROPIC_API_KEY=...         # the variable name is api_key_env in openshain.yaml
openshain run "Total this month's receipts"
openshain work list
openshain work show <id>
```

| Command | What it does |
|---|---|
| `openshain init` | Write the workspace configuration and the instruction files for agents |
| `openshain run "<request>"` | Create a work and drive it to completion or a stop |
| `openshain work list` / `work show <id>` | List works and show one, with usage totals and who acts next |
| `openshain work resume <id>` | Continue a work that stopped on a question or an interruption |
| `openshain tools list` | The tools available and whether each is allowed |
| `openshain mcp` | Serve the workspace over MCP on stdio |

`--workspace <dir>` names the company folder; otherwise it is found by walking up from the current directory to `openshain.yaml`.

### From Claude Code

Start `claude` in the company folder and trust it. The `.mcp.json` written by `openshain init` connects `openshain mcp`, and `/mcp` lists openshain. Write the request as usual: Claude Code thinks, openshain does the file work and keeps the record. `AGENTS.md` tells the agent to use openshain's tools for company files.

Any other agent that speaks MCP over stdio, such as Codex, can register `openshain mcp` the same way.

## Configuration

The smallest `openshain.yaml`:

```yaml
version: 1
company:
  name: Sample Inc.
principal:
  id: alice
  name: Alice
profession:
  id: generic
  instructions: You are the back-office clerk of this company.
model:
  provider: anthropic          # anthropic | openai-compatible
  model: claude-opus-5
  api_key_env: ANTHROPIC_API_KEY
```

Every field: [docs/configuration.md](docs/configuration.md) (Japanese). JSON Schemas: [spec/schemas/](spec/schemas/).

## Design

- Work, not answers.
- Existing SaaS remains the system of record.
- Official has no hidden privilege: official and third-party implementations use the same contracts.
- Paid means easiest: a paid offering takes over operations; it does not unlock features.

Principles in full: [docs/principles.md](docs/principles.md). Why each package is shaped as it is: [docs/design/](docs/design/README.md). Specification: [spec/](spec/README.md).

## Development

```
bun install
bun run typecheck && bun run lint && bun test
```

Layout and conventions: [AGENTS.md](AGENTS.md). Contributing: [CONTRIBUTING.md](CONTRIBUTING.md). Security: [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE)
