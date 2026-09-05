import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  type AnyEvent,
  type Artifact,
  compileInputValidator,
  createToolCaller,
  createToolRegistry,
  type Event,
  type InputValidation,
  isOpenshainError,
  isTerminal,
  loadConfig,
  parseWorkId,
  type RuntimeProviders,
  resolveWorkspacePath,
  type ToolDefinition,
  type ToolResult,
  verifyArtifact,
  type Work,
  type WorkId,
  WorkStore,
} from "@openshain/core";
import { Session } from "./session.ts";

export interface McpServerOptions {
  workspaceRoot: string;
  /** Tool providers by the id used in openshain.yaml. */
  tools: RuntimeProviders["tools"];
}

/** The tools every session has, before the workspace's own. Their names are reserved in the runtime. */
const WORK_TOOLS: Tool[] = [
  {
    name: "work_create",
    description:
      "Start a work for a request from the person you work for, and make it the current work. Tool calls are recorded against the current work. Finish the current work with work_complete or work_fail before starting another.",
    inputSchema: {
      type: "object",
      properties: {
        objective: { type: "string", description: "The request, in the person's words." },
        type: {
          type: "string",
          description: "A short label for the kind of work. Defaults to request.",
        },
      },
      required: ["objective"],
      additionalProperties: false,
    },
  },
  {
    name: "work_select",
    description: "Make an existing work the current one. A finished work cannot be selected.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "work_get",
    description: "The state of the current work, or of the work with the given id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "work_list",
    description: "Every work in this workspace, oldest first, with the ones that cannot be read.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "work_complete",
    description:
      "Finish the current work. Say what was done; name the files you produced with their sha256 if you know it. Paths are relative to the workspace. The runtime checks every file and records its own hash.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        artifacts: {
          type: "array",
          items: {
            type: "object",
            properties: { path: { type: "string" }, sha256: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          },
        },
      },
      required: ["summary"],
      additionalProperties: false,
    },
  },
  {
    name: "work_fail",
    description: "Give up on the current work. Say why in a short reason and, if useful, a detail.",
    inputSchema: {
      type: "object",
      properties: { reason: { type: "string" }, detail: { type: "string" } },
      required: ["reason"],
      additionalProperties: false,
    },
  },
];

const NO_WORK =
  "no current work: call work_create to start one for the person's request, or work_select to pick an existing one";

const validators = new Map(
  WORK_TOOLS.map((tool) => [tool.name, compileInputValidator(tool.inputSchema)] as const),
);

/**
 * An MCP server over one workspace. The agent on the other side thinks; the server keeps the
 * work's state, runs the workspace's tools and records everything. Needs no model provider.
 * Calls are handled one at a time per connection.
 */
export async function createMcpServer(options: McpServerOptions): Promise<Server> {
  const { workspaceRoot } = options;
  const config = await loadConfig(workspaceRoot);
  const registry = await createToolRegistry(workspaceRoot, config, options.tools);
  const callTool = createToolCaller({ registry, config, workspaceRoot });
  const works = new WorkStore(workspaceRoot);
  const session = new Session();
  const server = new Server(
    { name: "openshain", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );

  /** The current work when it can still take events; otherwise the reason it cannot. */
  async function openWork(): Promise<{ id: WorkId } | { refused: CallToolResult }> {
    const id = session.current;
    if (!id) return { refused: failure(NO_WORK) };
    const work = await works.get(id);
    if (isTerminal(work.status)) {
      session.clear();
      return { refused: failure(`work ${id} is already ${work.status}; ${NO_WORK}`) };
    }
    return { id };
  }

  async function handle(name: string, input: Record<string, unknown>): Promise<CallToolResult> {
    const validate = validators.get(name);
    if (validate) {
      const checked: InputValidation = validate(input);
      if (!checked.ok) {
        return failure(
          `schema_mismatch: input does not match the schema of ${name}: ${checked.reason}`,
        );
      }
    }
    switch (name) {
      case "work_create": {
        const current = session.current;
        if (current && !isTerminal((await works.get(current)).status)) {
          return failure(
            `work ${current} is still in progress; finish it with work_complete or work_fail before starting another`,
          );
        }
        const { objective, type } = input as { objective: string; type?: string };
        const work = await works.create({
          objective,
          principal: config.principal.id,
          profession: config.profession.id,
          ...(type && { type }),
        });
        await works.transition(work.id, "in_progress", "an agent took the work over MCP");
        session.select(work.id);
        return json(await works.get(work.id));
      }
      case "work_select": {
        const id = parseWorkId((input as { id: string }).id);
        const work = await works.get(id);
        if (isTerminal(work.status)) return failure(`work ${id} is already ${work.status}`);
        session.select(id);
        return json(work);
      }
      case "work_get": {
        const given = (input as { id?: string }).id;
        const id = given ? parseWorkId(given) : session.current;
        if (!id) return failure(NO_WORK);
        return json(await works.get(id));
      }
      case "work_list": {
        const { works: all, problems } = await works.list();
        return json({
          works: all.map((w) => ({
            id: w.id,
            status: w.status,
            objective: w.objective,
            createdAt: w.createdAt,
          })),
          problems: problems.map((p) => ({
            id: p.id,
            code: p.error.code,
            message: p.error.message,
          })),
        });
      }
      case "work_complete": {
        const gate = await openWork();
        if ("refused" in gate) return gate.refused;
        const { summary, artifacts } = input as {
          summary: string;
          artifacts?: { path: string; sha256?: string }[];
        };
        const work = await complete(works, workspaceRoot, gate.id, summary, artifacts ?? []);
        session.clear();
        return json(work);
      }
      case "work_fail": {
        const gate = await openWork();
        if ("refused" in gate) return gate.refused;
        const { reason, detail } = input as { reason: string; detail?: string };
        const opened = await works.open(gate.id);
        try {
          await opened.append({ type: "work.failed", payload: { reason, detail: detail ?? "" } });
        } finally {
          await opened.close();
        }
        session.clear();
        return json(await works.get(gate.id));
      }
      default: {
        const gate = await openWork();
        if ("refused" in gate) return gate.refused;
        const opened = await works.open(gate.id);
        try {
          const result = await callTool(opened, { id: newCallId(), name, input });
          return toMcpResult(result);
        } finally {
          await opened.close();
        }
      }
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...WORK_TOOLS, ...registry.list().map((t) => toMcpTool(t.definition))],
  }));

  server.setRequestHandler(CallToolRequestSchema, (request) =>
    session.run(async () => {
      try {
        return await handle(request.params.name, request.params.arguments ?? {});
      } catch (err) {
        if (isOpenshainError(err)) return failure(`${err.code}: ${err.message}`);
        throw err;
      }
    }),
  );

  return server;
}

/**
 * Records the evidence and the completion. Artifacts named by the agent join the ones the tools
 * wrote; every path must be inside the workspace, and the runtime hashes them all.
 */
async function complete(
  works: WorkStore,
  workspaceRoot: string,
  id: WorkId,
  summary: string,
  claimed: { path: string; sha256?: string }[],
): Promise<Work> {
  for (const { path } of claimed) await resolveWorkspacePath(workspaceRoot, path);
  const opened = await works.open(id);
  try {
    const events = await opened.events();
    const refs: string[] = [];
    const byPath = new Map<string, string>();
    for (const event of writesWithAfter(events)) {
      refs.push(event.id);
      for (const { path, sha256 } of event.payload.after ?? []) byPath.set(path, sha256);
    }
    for (const { path, sha256 } of claimed) if (!byPath.has(path)) byPath.set(path, sha256 ?? "");
    const artifacts: Artifact[] = [];
    for (const [path, reported] of byPath) {
      artifacts.push(await verifyArtifact(workspaceRoot, path, reported));
    }
    await opened.append({
      type: "evidence.recorded",
      payload: { claim: summary, refs, artifacts },
    });
    await opened.append({ type: "work.completed", payload: { summary } });
    return opened.current();
  } finally {
    await opened.close();
  }
}

function writesWithAfter(events: AnyEvent[]): Event<"tool.completed">[] {
  return events.filter(
    (e): e is Event<"tool.completed"> =>
      e.type === "tool.completed" &&
      !(e as Event<"tool.completed">).payload.isError &&
      (e as Event<"tool.completed">).payload.after !== undefined,
  );
}

function toMcpTool(definition: ToolDefinition): Tool {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema as Tool["inputSchema"],
  };
}

function toMcpResult(result: ToolResult): CallToolResult {
  return {
    content: result.content.map((part) =>
      part.type === "text"
        ? { type: "text", text: part.text }
        : { type: "text", text: JSON.stringify(part.value) },
    ),
    ...(result.isError && { isError: true }),
  };
}

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function failure(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function newCallId(): string {
  return `call_${Bun.randomUUIDv7()}`;
}
