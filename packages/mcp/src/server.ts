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
  ASK_USER,
  compileInputValidator,
  countToolCalls,
  createToolCaller,
  createToolRegistry,
  type Event,
  type EventType,
  type InputValidation,
  isKnownEventType,
  isOpenshainError,
  isTerminal,
  loadConfig,
  parsePayloadFile,
  parseWorkId,
  pendingQuestions,
  RUNTIME_PROVIDER_ID,
  type RuntimeProviders,
  resolveWorkspacePath,
  SESSION_WORK_TYPE,
  type ToolDefinition,
  type ToolResult,
  uuidv7,
  verifyArtifact,
  type Work,
  type WorkId,
  WorkStore,
  workHistory,
} from "@openshain/core";
import pkg from "../package.json" with { type: "json" };
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
      'Start a work for a request from the person you work for, and make it the current work. Tool calls are recorded against the current work. Finish the current work with work_complete or work_fail before starting another. The type "session" records a conversation: no tool can run inside it, so start the actual work with parent set to the session\'s id.',
    inputSchema: {
      type: "object",
      properties: {
        objective: { type: "string", description: "The request, in the person's words." },
        type: {
          type: "string",
          description: "A short label for the kind of work. Defaults to request.",
        },
        parent: {
          type: "string",
          description: "The id of the work this one was started from, such as the session.",
        },
        agent_name: {
          type: "string",
          description:
            "The name the agent goes by in this work. A session picks one; the works under it carry the same.",
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
    description:
      "The state of the current work, or of the work with the given id. With history, also the tool calls so far, the calls that never got a result, and the questions still waiting for an answer, so a stopped work can be picked up.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, history: { type: "boolean" } },
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
  {
    name: ASK_USER.name,
    description: ASK_USER.description,
    inputSchema: ASK_USER.inputSchema as Tool["inputSchema"],
  },
  {
    name: "work_answer",
    description:
      "Record the person's answer to a question the current work is waiting on, and let the work continue.",
    inputSchema: {
      type: "object",
      properties: { call_id: { type: "string" }, answer: { type: "string" } },
      required: ["call_id", "answer"],
      additionalProperties: false,
    },
  },
  {
    name: "work_record",
    description:
      "Record an event of the client itself on a work: what the person said (human.message), a prompt command expanded for the model (prompt.expanded), a model call (model.requested, model.completed, model.failed) or its usage (usage.recorded with kind model_inference). The payload is in the file form of spec/schemas/events.v1.json. Tool calls are recorded by the runtime and cannot be recorded here.",
    inputSchema: {
      type: "object",
      properties: {
        work_id: { type: "string" },
        type: {
          type: "string",
          enum: [
            "human.message",
            "prompt.expanded",
            "model.requested",
            "model.completed",
            "model.failed",
            "usage.recorded",
          ],
        },
        payload: { type: "object" },
      },
      required: ["work_id", "type", "payload"],
      additionalProperties: false,
    },
  },
];

/** The event types a client may record itself. Everything else is the runtime's to write. */
const RECORDABLE_TYPES: ReadonlySet<string> = new Set([
  "human.message",
  "prompt.expanded",
  "model.requested",
  "model.completed",
  "model.failed",
  "usage.recorded",
]);

const SESSION_HAS_NO_TOOLS =
  "a session records the conversation and runs no tools: call work_create with parent set to the session's id, then call the tool inside that work";

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
    { name: "openshain", version: pkg.version },
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
        if (current) {
          const open = await works.get(current);
          // A session is a conversation: starting a work under it is the normal thing to do.
          if (!isTerminal(open.status) && open.type !== SESSION_WORK_TYPE) {
            return failure(
              `work ${current} is still in progress; finish it with work_complete or work_fail before starting another`,
            );
          }
        }
        const {
          objective,
          type,
          parent,
          agent_name: agentName,
        } = input as { objective: string; type?: string; parent?: string; agent_name?: string };
        if (parent !== undefined) await works.get(parseWorkId(parent));
        const work = await works.create({
          objective,
          principal: config.principal.id,
          profession: config.profession.id,
          ...(type && { type }),
          ...(parent !== undefined && { parent }),
          ...(agentName !== undefined && { agentName }),
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
        const { id: given, history } = input as { id?: string; history?: boolean };
        const id = given ? parseWorkId(given) : session.current;
        if (!id) return failure(NO_WORK);
        const work = await works.get(id);
        if (!history) return json(work);
        return json({ ...work, history: workHistory(await works.events(id)) });
      }
      case ASK_USER.name: {
        const gate = await openWork();
        if ("refused" in gate) return gate.refused;
        const work = await works.get(gate.id);
        if (work.type === SESSION_WORK_TYPE) return failure(SESSION_HAS_NO_TOOLS);
        if (work.status === "waiting_input") {
          return failure(
            `work ${gate.id} is already waiting for an answer; record it with work_answer before asking again`,
          );
        }
        const { question } = input as { question: string };
        const callId = newCallId();
        const opened = await works.open(gate.id);
        try {
          await opened.append({
            type: "tool.called",
            payload: { callId, provider: RUNTIME_PROVIDER_ID, name: ASK_USER.name, input },
          });
          await opened.append({ type: "human.input_requested", payload: { callId, question } });
          await opened.transition("waiting_input", "the agent asked the person a question");
        } finally {
          await opened.close();
        }
        return json({ pending: true, call_id: callId, question });
      }
      case "work_answer": {
        const gate = await openWork();
        if ("refused" in gate) return gate.refused;
        const { call_id: callId, answer } = input as { call_id: string; answer: string };
        const work = await works.get(gate.id);
        if (work.status !== "waiting_input") {
          return failure(`work ${gate.id} is ${work.status}, not waiting for an answer`);
        }
        const pending = pendingQuestions(await works.events(gate.id));
        if (!pending.some((q) => q.callId === callId)) {
          return failure(
            `no unanswered question with call_id ${callId}; pending: ${pending.map((q) => q.callId).join(", ") || "none"}`,
          );
        }
        const opened = await works.open(gate.id);
        try {
          await opened.append({ type: "human.input_provided", payload: { callId, answer } });
          await opened.append({
            type: "tool.completed",
            payload: { callId, content: [{ type: "text", text: answer }], isError: false },
          });
          await opened.transition("in_progress", "the person answered");
          return json(await opened.current());
        } finally {
          await opened.close();
        }
      }
      case "work_record": {
        const { work_id, type, payload } = input as {
          work_id: string;
          type: string;
          payload: unknown;
        };
        const id = parseWorkId(work_id);
        if (!RECORDABLE_TYPES.has(type) || !isKnownEventType(type)) {
          return failure(`type ${type} cannot be recorded by a client`);
        }
        const work = await works.get(id);
        if (isTerminal(work.status)) return failure(`work ${id} is already ${work.status}`);
        const parsed = parsePayloadFile(type as EventType, payload);
        if (type === "usage.recorded" && (parsed as { kind: string }).kind !== "model_inference") {
          return failure("usage.recorded from a client must have kind model_inference");
        }
        const event = await works.append(id, { type, payload: parsed } as never);
        return json({ id: event.id, seq: event.seq });
      }
      case "work_list": {
        const { works: all, problems } = await works.list();
        return json({
          works: all.map((w) => ({
            id: w.id,
            status: w.status,
            type: w.type,
            objective: w.objective,
            createdAt: w.createdAt,
            ...(w.parent !== undefined && { parent: w.parent }),
            ...(w.agentName !== undefined && { agentName: w.agentName }),
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
        const work = await works.get(gate.id);
        if (work.type === SESSION_WORK_TYPE) return failure(SESSION_HAS_NO_TOOLS);
        if (work.status === "waiting_input") {
          return failure(
            `work ${gate.id} is waiting for the person's answer; record it with work_answer before calling tools`,
          );
        }
        const opened = await works.open(gate.id);
        try {
          const limit = config.limits.maxToolCalls;
          if (countToolCalls(await opened.events()) >= limit) {
            const reason = `this work has reached its limit of ${limit} tool calls; finish it with work_complete or work_fail`;
            await opened.append({
              type: "tool.rejected",
              payload: { callId: newCallId(), name, code: "limit_reached", reason },
            });
            return failure(`limit_reached: ${reason}`);
          }
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
 * wrote; every path must be inside the workspace, and the runtime hashes them all. A path no tool
 * of this work wrote is marked claimed, so a reader can tell the agent's word from the record.
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
    const written = new Set(byPath.keys());
    for (const { path, sha256 } of claimed) if (!byPath.has(path)) byPath.set(path, sha256 ?? "");
    const artifacts: Artifact[] = [];
    for (const [path, reported] of byPath) {
      const artifact = await verifyArtifact(workspaceRoot, path, reported);
      artifacts.push(written.has(path) ? artifact : { ...artifact, claimed: true });
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
    annotations: { readOnlyHint: definition.effect === "observe" },
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
  return `call_${uuidv7()}`;
}
