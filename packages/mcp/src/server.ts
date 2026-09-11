import { relative } from "node:path";
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
  businessDate,
  companyTime,
  compileInputValidator,
  countToolCalls,
  createToolCaller,
  createToolRegistry,
  DecisionFileSchema,
  type DecisionRecord,
  type Event,
  type EventType,
  type InputValidation,
  isActive,
  isKnownEventType,
  isOpenshainError,
  isTerminal,
  liveAuthority,
  loadConfig,
  type PendingApproval,
  parsePayloadFile,
  parseWorkId,
  pendingApprovals,
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
  type WorkHandle,
  type WorkId,
  WorkStore,
  workHistory,
  writeDecision,
} from "@openshain/core";
import pkg from "../package.json" with { type: "json" };
import { Session } from "./session.ts";

export interface McpServerOptions {
  workspaceRoot: string;
  /** Tool providers by the id used in openshain.yaml. */
  tools: RuntimeProviders["tools"];
  /** Who this server works for. From the client's own settings, never from the company folder. */
  as?: string | undefined;
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
        objective: {
          type: "string",
          minLength: 1,
          maxLength: 10_000,
          description: "The request, in the person's words.",
        },
        type: {
          type: "string",
          maxLength: 50,
          description: "A short label for the kind of work. Defaults to request.",
        },
        parent: {
          type: "string",
          maxLength: 100,
          description: "The id of the work this one was started from, such as the session.",
        },
        agent_name: {
          type: "string",
          maxLength: 100,
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
        summary: { type: "string", maxLength: 20_000 },
        artifacts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string", maxLength: 1000 },
              sha256: { type: "string", maxLength: 64 },
            },
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
      properties: {
        reason: { type: "string", maxLength: 200 },
        detail: { type: "string", maxLength: 20_000 },
      },
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
      properties: {
        call_id: { type: "string", maxLength: 100 },
        answer: { type: "string", maxLength: 20_000 },
      },
      required: ["call_id", "answer"],
      additionalProperties: false,
    },
  },
  {
    name: "context",
    description:
      "Where and when you are working: the current time with its offset, the time zone, today's business date, the company folder, the company, the person you work for, and the current work. Call it when a date or a time matters; the answer is recorded.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "approval_list",
    description:
      "Every tool call held for a person's approval across the works of this workspace, oldest first: approval_id, work_id, the call, the rule, and who may approve.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "approval_decide",
    description:
      "Decide a held tool call as the person this connection acts for. approve runs the call now and returns its result; reject refuses it. Either way the work continues.",
    inputSchema: {
      type: "object",
      properties: {
        approval_id: { type: "string", maxLength: 100 },
        decision: { type: "string", enum: ["approve", "reject"] },
        comment: { type: "string", maxLength: 2000 },
      },
      required: ["approval_id", "decision"],
      additionalProperties: false,
    },
  },
  {
    name: "review_decide",
    description:
      "Record what a qualified reviewer decided about a call the policy held for review. approve and modify write a decision under authority/decisions/ and run the call (modify runs the reviewer's input); reject refuses it. The reviewer is named by the company; openshain does not verify a qualification.",
    inputSchema: {
      type: "object",
      properties: {
        approval_id: { type: "string", maxLength: 100 },
        decision: { type: "string", enum: ["approve", "reject", "modify"] },
        reviewer: {
          type: "object",
          properties: {
            name: { type: "string", maxLength: 200 },
            role: { type: "string", maxLength: 100 },
            qualification: { type: "string", maxLength: 500 },
          },
          required: ["name", "role"],
          additionalProperties: false,
        },
        interpretation: { type: "string", maxLength: 20_000 },
        modified_input: { type: "object" },
        effective_from: { type: "string", maxLength: 10 },
        effective_until: { type: "string", maxLength: 10 },
        applies_to: {
          type: "object",
          properties: {
            action: { type: "string", maxLength: 200 },
            path: { type: "string", maxLength: 1000 },
          },
          additionalProperties: false,
        },
      },
      required: ["approval_id", "decision", "reviewer"],
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
            "conversation.compacted",
          ],
        },
        payload: { type: "object" },
      },
      required: ["work_id", "type", "payload"],
      additionalProperties: false,
    },
  },
];

/** A client event larger than this is refused: the log is for records, not for payloads. */
const MAX_RECORD_CHARS = 262_144;

/** The event types a client may record itself. Everything else is the runtime's to write. */
const RECORDABLE_TYPES: ReadonlySet<string> = new Set([
  "human.message",
  "prompt.expanded",
  "model.requested",
  "model.completed",
  "model.failed",
  "usage.recorded",
  // The conversation is the client's to shorten: the runtime holds the events either way.
  "conversation.compacted",
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
  const config = await loadConfig(workspaceRoot, { as: options.as });
  const registry = await createToolRegistry(workspaceRoot, config, options.tools);
  // Read again whenever the files change, so a rule written now holds for the next call.
  const authority = liveAuthority(workspaceRoot);
  const callTool = createToolCaller({ registry, config, workspaceRoot, authority });
  const works = new WorkStore(workspaceRoot);

  /**
   * Opens a work for one piece of work on it, and closes it however that ends. The lock a work
   * holds is the single-writer rule, so it must not outlive the call that took it; releasing it
   * here means no caller can forget to.
   */
  async function withWork<T>(id: WorkId, use: (opened: WorkHandle) => Promise<T>): Promise<T> {
    const opened = await works.open(id);
    try {
      return await use(opened);
    } finally {
      await opened.close();
    }
  }
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
        if (type === SESSION_WORK_TYPE && parent !== undefined) {
          return failure("a session is a conversation of its own and cannot have a parent");
        }
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
        // Selecting is what lets a client record into a work. Another person's conversation is
        // theirs: a client that could select it could write what they never said.
        if (work.principal !== config.principal.id) {
          return failure(
            `work ${id} belongs to ${work.principal}; a client selects only the works of the person it acts for`,
          );
        }
        session.select(id);
        return json({ ...work, history: workHistory(await works.events(id)) });
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
        await withWork(gate.id, async (opened) => {
          await opened.append({
            type: "tool.called",
            payload: { callId, provider: RUNTIME_PROVIDER_ID, name: ASK_USER.name, input },
          });
          await opened.append({ type: "human.input_requested", payload: { callId, question } });
          await opened.transition("waiting_input", "the agent asked the person a question");
        });
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
        return await withWork(gate.id, async (opened) => {
          await opened.append({ type: "human.input_provided", payload: { callId, answer } });
          await opened.append({
            type: "tool.completed",
            payload: { callId, content: [{ type: "text", text: answer }], isError: false },
          });
          await opened.transition("in_progress", "the person answered");
          return json(await opened.current());
        });
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
        if (JSON.stringify(payload).length > MAX_RECORD_CHARS) {
          return failure(`payload is larger than ${MAX_RECORD_CHARS} characters`);
        }
        if (!session.knows(id)) {
          return failure(
            `work ${id} was not created or selected on this connection; a client records only on its own works`,
          );
        }
        const parsed = parsePayloadFile(type as EventType, payload);
        if (type === "usage.recorded" && (parsed as { kind: string }).kind !== "model_inference") {
          return failure("usage.recorded from a client must have kind model_inference");
        }
        return await withWork(id, async (opened) => {
          const status = (await opened.current()).status;
          if (isTerminal(status)) return failure(`work ${id} is already ${status}`);
          const event = await opened.append({ type, payload: parsed } as never);
          return json({ id: event.id, seq: event.seq });
        });
      }
      case "context": {
        const now = new Date();
        const timezone = config.company.timezone;
        const info = {
          now: companyTime(timezone, now),
          timezone,
          business_date: businessDate(timezone, now),
          workspace: workspaceRoot,
          company: config.company.name,
          principal: { id: config.principal.id, name: config.principal.name },
          profession: config.profession.id,
          work: session.current ?? null,
        };
        const result = json(info);
        // Recorded on the current work when there is one, even a session: it touches no file.
        const current = session.current;
        if (current && !isTerminal((await works.get(current)).status)) {
          const callId = newCallId();
          await withWork(current, async (opened) => {
            await opened.append({
              type: "tool.called",
              payload: { callId, provider: RUNTIME_PROVIDER_ID, name: "context", input: {} },
            });
            await opened.append({
              type: "tool.completed",
              payload: { callId, content: [{ type: "json", value: info }], isError: false },
            });
          });
        }
        return result;
      }
      case "approval_list": {
        const held: unknown[] = [];
        const { works: all } = await works.list();
        for (const w of all) {
          if (w.status !== "waiting_approval") continue;
          for (const a of pendingApprovals(await works.events(w.id))) {
            held.push({ ...a, work_id: w.id, objective: w.objective });
          }
        }
        return json({ approvals: held });
      }
      case "approval_decide": {
        const {
          approval_id: approvalId,
          decision,
          comment,
        } = input as { approval_id: string; decision: "approve" | "reject"; comment?: string };
        const found = await findApproval(works, approvalId);
        if (!found) return failure(`no pending approval ${approvalId}`);
        const { workId, approval } = found;
        const by = config.principal.id;
        if (approval.kind === "review") {
          return failure(
            `${approvalId} waits for a qualified reviewer, not a person's approval; use review_decide`,
          );
        }
        if (approval.approvers && !approval.approvers.includes(by)) {
          return failure(
            `${by} may not decide ${approvalId}; approvers: ${approval.approvers.join(", ")}`,
          );
        }
        // Read now, not at startup: somebody taken out of principals/ this morning cannot
        // approve this afternoon from a session that is still open.
        if (!isActive((await authority()).principals, by)) {
          return failure(`${by} is no longer with the company and cannot decide ${approvalId}`);
        }
        return await withWork(workId, async (opened) => {
          // Under the lock: another connection may have decided this approval in between.
          if (!pendingApprovals(await opened.events()).some((a) => a.approvalId === approvalId)) {
            return failure(`approval ${approvalId} was already decided`);
          }
          await opened.append({
            type: "approval.decided",
            payload: { approvalId, decision, by, ...(comment !== undefined && { comment }) },
          });
          if (decision === "reject") {
            await opened.append({
              type: "tool.rejected",
              payload: {
                callId: approval.call.callId,
                name: approval.call.name,
                code: "rejected_by_person",
                reason: comment ?? `${by} rejected ${approvalId}`,
              },
            });
            await opened.transition("in_progress", `${by} rejected ${approvalId}`);
            return json({ approval_id: approvalId, decision, work_id: workId });
          }
          await opened.transition("in_progress", `${by} approved ${approvalId}`);
          const result = await callTool(
            opened,
            { id: approval.call.callId, name: approval.call.name, input: approval.call.input },
            {
              approvedBy: approvalId,
              ...(approval.judgedPath !== undefined && { judgedPath: approval.judgedPath }),
            },
          );
          return json({
            approval_id: approvalId,
            decision,
            work_id: workId,
            result: { content: result.content, isError: result.isError ?? false },
          });
        });
      }
      case "review_decide": {
        const {
          approval_id: approvalId,
          decision,
          reviewer,
          interpretation,
          modified_input: modifiedInput,
          effective_from: effectiveFrom,
          effective_until: effectiveUntil,
          applies_to: appliesTo,
        } = input as {
          approval_id: string;
          decision: "approve" | "reject" | "modify";
          reviewer: { name: string; role: string; qualification?: string };
          interpretation?: string;
          modified_input?: Record<string, unknown>;
          effective_from?: string;
          effective_until?: string;
          applies_to?: { action?: string; path?: string };
        };
        const found = await findApproval(works, approvalId);
        if (!found) return failure(`no pending approval ${approvalId}`);
        const { workId, approval } = found;
        if (approval.kind !== "review") {
          return failure(
            `${approvalId} waits for a person's approval, not a review; use approval_decide`,
          );
        }
        if (decision !== "reject" && (interpretation ?? "") === "") {
          return failure("a decision needs the reviewer's interpretation in their own words");
        }
        if (approval.reviewer && approval.reviewer.role !== reviewer.role) {
          return failure(
            `rule ${approval.ruleId} asks for a ${approval.reviewer.role}; the decision names a ${reviewer.role}`,
          );
        }
        if (decision === "modify" && modifiedInput) {
          // Checked before anything is recorded: a refused input leaves the approval pending.
          const before = (approval.call.input ?? {}) as { path?: unknown };
          const after = modifiedInput as { path?: unknown };
          if (before.path !== after.path) {
            return failure(
              `a modified call must touch the same path: ${String(before.path)} was held, ${String(after.path)} was given`,
            );
          }
        }
        // Built and checked before anything is recorded: an input the decision refuses must not
        // consume the approval and leave the work waiting with nobody able to move it.
        const today = new Date();
        let record: DecisionRecord | undefined;
        if (decision !== "reject") {
          const parsed = DecisionFileSchema.safeParse({
            id: `dec_${uuidv7()}`,
            reviewer,
            approval_id: approvalId,
            decided_at: today.toISOString(),
            effective_from: effectiveFrom ?? today.toISOString().slice(0, 10),
            effective_until: effectiveUntil ?? null,
            interpretation,
            applies_to: appliesTo ?? {},
          });
          if (!parsed.success) {
            return failure(
              `the decision is not well formed: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
            );
          }
          record = parsed.data;
        }
        return await withWork(workId, async (opened) => {
          // Under the lock: another connection may have decided this approval in between.
          if (!pendingApprovals(await opened.events()).some((a) => a.approvalId === approvalId)) {
            return failure(`approval ${approvalId} was already decided`);
          }
          await opened.append({
            type: "approval.decided",
            payload: {
              approvalId,
              decision,
              by: reviewer.name,
              ...(interpretation !== undefined && { comment: interpretation }),
              ...(decision === "modify" && modifiedInput && { modifiedInput }),
            },
          });
          if (decision === "reject") {
            await opened.append({ type: "review.decided", payload: { approvalId } });
            await opened.append({
              type: "tool.rejected",
              payload: {
                callId: approval.call.callId,
                name: approval.call.name,
                code: "rejected_by_person",
                reason: interpretation ?? `${reviewer.name} did not approve ${approvalId}`,
              },
            });
            await opened.transition("in_progress", `${reviewer.name} rejected ${approvalId}`);
            return json({ approval_id: approvalId, decision, work_id: workId });
          }
          const written = record as DecisionRecord;
          const file = await writeDecision(workspaceRoot, written);
          await opened.append({
            type: "review.decided",
            payload: { approvalId, decisionId: written.id },
          });
          await opened.transition("in_progress", `${reviewer.name} decided ${approvalId}`);
          const ranWith =
            decision === "modify" && modifiedInput ? modifiedInput : approval.call.input;
          const ran = await callTool(
            opened,
            { id: approval.call.callId, name: approval.call.name, input: ranWith },
            {
              approvedBy: approvalId,
              // A reviewer may change the input, but not where it lands: the same check holds.
              ...(approval.judgedPath !== undefined && { judgedPath: approval.judgedPath }),
            },
          );
          return json({
            approval_id: approvalId,
            decision,
            work_id: workId,
            decision_id: written.id,
            decision_file: relative(workspaceRoot, file),
            result: { content: ran.content, isError: ran.isError ?? false },
          });
        });
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
        const work = await withWork(gate.id, (opened) =>
          complete(workspaceRoot, opened, summary, artifacts ?? []),
        );
        session.clear();
        return json(work);
      }
      case "work_fail": {
        const gate = await openWork();
        if ("refused" in gate) return gate.refused;
        const { reason, detail } = input as { reason: string; detail?: string };
        await withWork(gate.id, async (opened) => {
          await opened.append({ type: "work.failed", payload: { reason, detail: detail ?? "" } });
        });
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
        if (work.status === "waiting_approval") {
          return failure(
            `work ${gate.id} is waiting for an approval; decide it with approval_decide (see approval_list) before calling tools`,
          );
        }
        return await withWork(gate.id, async (opened) => {
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
        });
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
  workspaceRoot: string,
  opened: WorkHandle,
  summary: string,
  claimed: { path: string; sha256?: string }[],
): Promise<Work> {
  for (const { path } of claimed) await resolveWorkspacePath(workspaceRoot, path);
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

/** The work holding a pending approval, found by scanning the works that wait for one. */
async function findApproval(
  works: WorkStore,
  approvalId: string,
): Promise<{ workId: WorkId; approval: PendingApproval } | undefined> {
  const { works: all } = await works.list();
  for (const w of all) {
    if (w.status !== "waiting_approval") continue;
    const approval = pendingApprovals(await works.events(w.id)).find(
      (a) => a.approvalId === approvalId,
    );
    if (approval) return { workId: w.id, approval };
  }
  return undefined;
}
