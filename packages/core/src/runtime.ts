import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  type Authority,
  evaluate,
  liveAuthority,
  OPEN_AUTHORITY,
  type Rule,
} from "./authority/policy.ts";
import { mayReachInto, mayRead, type Principal } from "./authority/principals.ts";
import { loadConfig } from "./config/load.ts";
import type { Config, ModelConfig } from "./config/schema.ts";
import { isOpenshainError, OpenshainError } from "./errors.ts";
import type { ModelProvider } from "./model/types.ts";
import { businessDate } from "./time.ts";
import { loadToolModule } from "./tool/load-module.ts";
import { resolveWorkspacePath } from "./tool/paths.ts";
import type { HiddenTool } from "./tool/registry.ts";
import { type RegisteredTool, ToolRegistry } from "./tool/registry.ts";
import type { ToolCall, ToolDefinition, ToolProvider, ToolResult } from "./tool/types.ts";
import { uuidv7 } from "./uuid.ts";
import type { Event, ReviewPackage, ToolContent } from "./work/events.ts";
import { TOOL_REJECTION_CODES, type ToolRejectionCode } from "./work/events.ts";
import { WORK_DIR_NAME, type WorkHandle, WorkStore } from "./work/store.ts";

export interface RuntimeProviders {
  /** Model providers by the id used in openshain.yaml. */
  models: Record<string, (model: ModelConfig) => ModelProvider>;
  /** Tool providers by the id used in openshain.yaml. Modules are loaded from the config directly. */
  /** By the provider id used in openshain.yaml. The workspace is given, since what a provider
   * offers can depend on what is in it. */
  tools: Record<string, (workspaceRoot: string) => ToolProvider>;
}

export interface CreateRuntimeOptions {
  workspaceRoot: string;
  providers: RuntimeProviders;
}

/** What the outside world learns about a registered tool. Calls go through runtime.tools.call. */
export interface ToolSummary {
  definition: ToolDefinition;
  providerId: string;
}

/** Longer tool output is cut here so that one tool cannot flood the model's context. */
export const MAX_TOOL_TEXT_CHARS = 50_000;

/** Where a work keeps the review packages a person sends to a reviewer. */
export const REVIEW_DIR_NAME = "review";

export interface Runtime {
  readonly workspaceRoot: string;
  readonly config: Config;
  readonly model: ModelProvider;
  readonly works: WorkStore;
  readonly tools: {
    list(): ToolSummary[];
    /** Tools the providers offer but the allow lists in the config left out. */
    hidden(): HiddenTool[];
    /** Validates, runs and records one tool call for the given work. Never throws for a tool's own failure. */
    call(work: WorkHandle, call: ToolCall): Promise<ToolResult>;
  };
}

/** Builds a runtime for one workspace from its config and the providers the caller knows. */
export async function createRuntime(options: CreateRuntimeOptions): Promise<Runtime> {
  const { workspaceRoot, providers } = options;
  const config = await loadConfig(workspaceRoot, { modelProviders: Object.keys(providers.models) });

  if (!config.model) {
    throw new OpenshainError(
      "config",
      "this needs a model: add a model section to openshain.yaml (only the interactive CLI needs one)",
    );
  }
  const modelFactory = Object.hasOwn(providers.models, config.model.provider)
    ? providers.models[config.model.provider]
    : undefined;
  if (!modelFactory) {
    throw new OpenshainError("config", `unknown model provider "${config.model.provider}"`);
  }
  const model = modelFactory(config.model);
  const description = model.describe();
  if (!description.capabilities.tools) {
    throw new OpenshainError(
      "config",
      `model ${description.provider}/${description.model} cannot call tools; openshain needs a model with tool support`,
    );
  }

  const registry = await createToolRegistry(workspaceRoot, config, providers.tools);
  const authority = liveAuthority(workspaceRoot);
  const works = new WorkStore(workspaceRoot);
  return {
    workspaceRoot,
    config,
    model,
    works,
    tools: {
      list: () => registry.list().map(({ definition, providerId }) => ({ definition, providerId })),
      hidden: () => registry.hiddenTools(),
      call: createToolCaller({ registry, config, workspaceRoot, authority }),
    },
  };
}

/** The tool call pipeline on its own: authorize, validate, run, record. For callers that need no model, such as the MCP server. */
export function createToolCaller(input: {
  registry: ToolRegistry;
  config: Config;
  workspaceRoot: string;
  /**
   * Who may do what. Pass a function when it can change while the server runs: liveAuthority
   * reads the files again when they change. Omitted: the workspace is open, as one without
   * authority/ is.
   */
  authority?: Authority | (() => Authority | Promise<Authority>);
}): (work: WorkHandle, call: ToolCall, options?: CallOptions) => Promise<ToolResult> {
  const given = input.authority;
  const current = typeof given === "function" ? given : () => given ?? OPEN_AUTHORITY;
  return async (work, call, options) => {
    let authority: Authority;
    try {
      authority = await current();
    } catch (err) {
      // The table cannot be read, so nothing is allowed by it. Refusing is the closed side.
      const reason = err instanceof Error ? err.message : String(err);
      await work.append({
        type: "tool.rejected",
        payload: { callId: call.id, name: call.name, code: "denied", reason },
      });
      return { content: [{ type: "text", text: reason }], isError: true };
    }
    return callTool({ ...input, authority, work, call, ...options });
  };
}

export interface CallOptions {
  /** The approval that lets this call run: the policy is not consulted again. */
  approvedBy?: string;
  /** Where the call led when it was approved. The run stops if it leads elsewhere now. */
  judgedPath?: string;
}

/** What a held call answers with: the client shows it to the person and the turn stops there. */
export interface PendingApprovalResult {
  pending: "approval" | "review";
  approval_id: string;
  rule_id: string;
  approvers?: string[];
  reviewer?: { role: string; name?: string };
  /** For a review: why the policy asks for one, when a cited decision did not cover the call. */
  why?: string;
}

/** Registers the tool providers the config names: the caller's factories by id, and modules from the workspace. Needs no model. */
export async function createToolRegistry(
  workspaceRoot: string,
  config: Config,
  tools: RuntimeProviders["tools"],
): Promise<ToolRegistry> {
  const registry = new ToolRegistry();
  for (const entry of config.tools) {
    const registerOptions = entry.allow ? { allow: entry.allow } : {};
    if ("provider" in entry) {
      const factory = Object.hasOwn(tools, entry.provider) ? tools[entry.provider] : undefined;
      if (!factory) {
        throw new OpenshainError(
          "config",
          `unknown tool provider "${entry.provider}"; known providers: ${Object.keys(tools).join(", ")}`,
        );
      }
      await registry.register(factory(workspaceRoot), registerOptions);
    } else {
      await registry.register(await loadToolModule(workspaceRoot, entry.module), registerOptions);
    }
  }
  return registry;
}

/**
 * The one place that allows or refuses a call before it runs by name alone. What the workspace
 * allows a call to do is decided after this, by the policy in `authority/`.
 */
function authorize(
  registry: ToolRegistry,
  call: ToolCall,
): { ok: true; tool: RegisteredTool } | { ok: false; code: ToolRejectionCode; reason: string } {
  const tool = registry.get(call.name);
  if (tool) return { ok: true, tool };
  return registry.isHidden(call.name)
    ? {
        ok: false,
        code: "not_allowed",
        reason: `tool "${call.name}" is not allowed in this workspace`,
      }
    : { ok: false, code: "unknown_tool", reason: `unknown tool "${call.name}"` };
}

async function callTool(input: {
  registry: ToolRegistry;
  config: Config;
  workspaceRoot: string;
  authority: Authority;
  work: WorkHandle;
  call: ToolCall;
  approvedBy?: string;
  /** Where the call led when it was approved, so the run can check it still does. */
  judgedPath?: string;
}): Promise<ToolResult> {
  const { registry, config, workspaceRoot, authority, work, call } = input;
  const reject = async (code: ToolRejectionCode, reason: string): Promise<ToolResult> => {
    await work.append({
      type: "tool.rejected",
      payload: { callId: call.id, name: call.name, code, reason },
    });
    return { content: [{ type: "text", text: reason }], isError: true };
  };

  const decision = authorize(registry, call);
  if (!decision.ok) return reject(decision.code, decision.reason);
  const { tool } = decision;
  const validation = tool.validate(call.input);
  if (!validation.ok) {
    return reject(
      "schema_mismatch",
      `input does not match the schema of ${call.name}: ${validation.reason}`,
    );
  }
  const person = authority.principals.get(config.principal.id);
  // Before the guard touches anything: a path outside the range is answered the same whether it
  // is there or not, and the guard's own errors (a missing directory, a link that loops) would
  // say more about what is outside than this person may know.
  const named = namedPath(call.input);
  if (named !== undefined && !within(person, workspaceRelative(named))) {
    return reject("out_of_range", OUT_OF_RANGE);
  }
  let path: string | undefined;
  try {
    path = await judgedPath(workspaceRoot, call.input);
  } catch (err) {
    // A path the guard refuses is refused here, with the guard's own reason: the table cannot
    // judge a place the tools may not reach, and the call must not run either.
    const code = isOpenshainError(err) && isRejectionCode(err.code) ? err.code : "invalid_path";
    return reject(code, err instanceof Error ? err.message : String(err));
  }
  // Again on what the guard resolved: a link inside the range that leads out of it is out. This
  // holds for an approved call too, so narrowing what somebody covers stops a call still waiting.
  if (path !== undefined && !within(person, path)) {
    return reject("out_of_range", OUT_OF_RANGE);
  }
  // What a person approved is a call to one place. Between the decision and the run, a link or a
  // folder can be swapped so the same input leads elsewhere; the call does not run then.
  if (
    input.approvedBy !== undefined &&
    input.judgedPath !== undefined &&
    path !== input.judgedPath
  ) {
    return reject(
      "path_changed",
      `${call.name} was approved for ${input.judgedPath}; the same input now leads to ${path ?? "nowhere"}`,
    );
  }
  // The policy judges after the allow list, unless a person already approved this very call.
  if (input.approvedBy === undefined) {
    const judged = evaluate(authority, {
      tool: call.name,
      effect: tool.definition.effect,
      ...(path !== undefined && { path }),
      principal: config.principal.id,
      profession: config.profession.id,
      workType: (await work.current()).type,
      businessDate: businessDate(config.company.timezone),
    });
    if (judged.kind === "deny") return reject("denied", judged.reason);
    if (judged.kind === "approval_required" || judged.kind === "review_required") {
      const review = judged.kind === "review_required";
      const approvalId = `apr_${uuidv7()}`;
      const approvers = judged.rule.approvers ?? [config.principal.id];
      const declared = judged.rule.reviewer;
      const reviewer = declared
        ? { role: declared.role, ...(declared.name !== undefined && { name: declared.name }) }
        : undefined;
      await work.append({
        type: "approval.requested",
        payload: {
          approvalId,
          call: { callId: call.id, name: call.name, input: call.input },
          ...(path !== undefined && { judgedPath: path }),
          ruleId: judged.rule.id,
          kind: review ? "review" : "approval",
          ...(review ? reviewer && { reviewer } : { approvers }),
        },
      });
      if (review) {
        const built = await reviewPackage(work, {
          approvalId,
          call,
          rule: judged.rule,
          principal: config.principal.id,
        });
        await work.append({ type: "review.requested", payload: { approvalId, package: built } });
        // A copy the person can send to the reviewer, next to the work's own record.
        const dir = join(workspaceRoot, WORK_DIR_NAME, work.id, REVIEW_DIR_NAME);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, `${approvalId}.json`), `${JSON.stringify(built, null, 2)}\n`, {
          flag: "wx",
        });
      }
      await work.transition(
        "waiting_approval",
        `rule ${judged.rule.id} needs ${review ? "a review" : "approval"}`,
      );
      const held: PendingApprovalResult = {
        pending: review ? "review" : "approval",
        approval_id: approvalId,
        rule_id: judged.rule.id,
        ...(review ? reviewer && { reviewer } : { approvers }),
        ...(review && judged.why !== undefined && { why: judged.why }),
      };
      return { content: [{ type: "json", value: held }] };
    }
    if (judged.kind === "allow" && judged.decision) {
      await work.append({
        type: "decision.applied",
        payload: { callId: call.id, decisionId: judged.decision.id },
      });
    }
  }

  await work.append({
    type: "tool.called",
    payload: { callId: call.id, provider: tool.providerId, name: call.name, input: call.input },
  });
  const started = performance.now();
  let result: ToolResult;
  try {
    const person = authority.principals.get(config.principal.id);
    result = await tool.provider.call(call, {
      workId: work.id,
      principalId: config.principal.id,
      profession: config.profession.id,
      businessDate: businessDate(config.company.timezone),
      ...(person && { roles: person.roles }),
      workspaceRoot,
      covers: {
        path: (path: string) => mayRead(person, path),
        into: (dir: string) => mayReachInto(person, dir),
      },
    });
  } catch (err) {
    if (isOpenshainError(err) && isRejectionCode(err.code)) return reject(err.code, err.message);
    const message = err instanceof Error ? err.message : String(err);
    result = { content: [{ type: "text", text: message }], isError: true };
  }
  const durationMs = Math.max(0, Math.round(performance.now() - started));
  result = { ...result, content: result.content.map(capContent) };

  await work.append({
    type: "tool.completed",
    payload: {
      callId: call.id,
      content: result.content,
      isError: result.isError ?? false,
      ...(result.observation && { observation: result.observation }),
      ...(result.after && { after: result.after }),
    },
  });
  await work.append({
    type: "usage.recorded",
    payload: { kind: "tool_execution", provider: tool.providerId, usage: { durationMs } },
  });
  return result;
}

/**
 * What the reviewer is asked to decide on, from the work's own record: the call, the tool calls
 * that came before it, and the agent's last words as the proposal. Sources and company rules stay
 * empty until knowledge is in.
 */
async function reviewPackage(
  work: WorkHandle,
  input: { approvalId: string; call: ToolCall; rule: Rule; principal: string },
): Promise<ReviewPackage> {
  const events = await work.events();
  const facts: string[] = [];
  let proposal = "";
  for (const event of events) {
    if (event.type === "tool.called") {
      const { name, input: called } = (event as Event<"tool.called">).payload;
      const path = namedPath(called);
      facts.push(path === undefined ? name : `${name} ${path}`);
    } else if (event.type === "model.completed") {
      const text = (event as Event<"model.completed">).payload.content
        .filter((part) => part.type === "text")
        .map((part) => (part as { text: string }).text)
        .join("\n")
        .trim();
      if (text !== "") proposal = text;
    }
  }
  const current = await work.current();
  return {
    approvalId: input.approvalId,
    workId: work.id,
    action: {
      name: input.rule.match.action?.toString() ?? input.call.name,
      tool: input.call.name,
      input: input.call.input,
    },
    facts,
    sources: [],
    companyRules: [],
    proposal,
    question:
      input.rule.reason ??
      `${current.objective} のために ${input.call.name} を実行してよいか、判断をお願いします。`,
    requestedBy: input.principal,
    requestedAt: new Date().toISOString(),
  };
}

/**
 * The path a call names, as the table judges it: the guard's own answer, relative to the company
 * folder. The guard follows a link inside the folder to what it points at, so a rule about
 * `hr/**` holds for `notes/shortcut.csv` when that is what the link leads to. Judging the string
 * the call carried would let a link, or a different spelling, walk past the rule.
 */
/**
 * Whether a call may name this path at all: the range covers it, or it is a folder the range
 * lies under. Listing the company folder is how a person finds their own folders, so the way
 * there is not the same question as what is in it.
 */
function within(person: Principal | undefined, path: string): boolean {
  return mayRead(person, path) || mayReachInto(person, path);
}

/** Said for anything outside the range, whether it is there or not: the same answer either way. */
const OUT_OF_RANGE = "その場所は、この社員エージェントが働く範囲の外です";

/** The path as the person wrote it, folded to a workspace-relative posix path without touching disk. */
function workspaceRelative(path: string): string {
  const segments: string[] = [];
  for (const segment of path.replaceAll("\\", "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}

/**
 * The path a call named, for a person to read. Taken from the record as it was written, so it
 * says what the agent asked for; the guard's answer is what the table judged.
 */
function namedPath(input: unknown): string | undefined {
  const path = (input as { path?: unknown } | null)?.path;
  return typeof path === "string" && path !== "" ? path : undefined;
}

async function judgedPath(workspaceRoot: string, input: unknown): Promise<string | undefined> {
  const path = (input as { path?: unknown } | null)?.path;
  if (typeof path !== "string" || path === "") return undefined;
  const resolved = await resolveWorkspacePath(workspaceRoot, path);
  const root = await realpath(workspaceRoot);
  return relative(root, resolved).split(sep).join("/");
}

/** Today's date on this machine's clock, YYYY-MM-DD. */

function isRejectionCode(code: string): code is ToolRejectionCode {
  return (TOOL_REJECTION_CODES as readonly string[]).includes(code);
}

/** Cuts a content part down to MAX_TOOL_TEXT_CHARS and says so at the end. */
function capContent(part: ToolContent): ToolContent {
  const text = part.type === "text" ? part.text : JSON.stringify(part.value);
  const chars = [...text];
  if (chars.length <= MAX_TOOL_TEXT_CHARS) return part;
  const cut = chars.length - MAX_TOOL_TEXT_CHARS;
  return {
    type: "text",
    text: `${chars.slice(0, MAX_TOOL_TEXT_CHARS).join("")}\n…[${cut} characters cut by the runtime]`,
  };
}
