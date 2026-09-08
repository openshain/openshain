import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { parseYamlFile } from "../config/yaml.ts";
import { OpenshainError } from "../errors.ts";

/** Files under authority/ the runtime reads. */
export const AUTHORITY_DIR_NAME = "authority";
export const POLICY_FILE_NAME = "policy.yaml";
export const DELEGATIONS_FILE_NAME = "delegations.yaml";
export const DECISIONS_DIR_NAME = "decisions";

export const DECISION_KINDS = [
  "allow",
  "approval_required",
  "review_required",
  "deny",
  "decision_backed",
] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

const identifier = z.string().regex(/^[a-z][a-z0-9_-]*$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const oneOrMany = z.union([z.string().min(1).max(200), z.array(z.string().min(1).max(200)).min(1)]);

const MatchSchema = z
  .strictObject({
    tool: oneOrMany.optional(),
    effect: z.enum(["observe", "mutate"]).optional(),
    path: z.string().min(1).max(1000).optional(),
    principal: oneOrMany.optional(),
    work_type: oneOrMany.optional(),
    action: oneOrMany.optional(),
  })
  .refine((m) => Object.values(m).some((v) => v !== undefined), "a rule must match on something");

const RuleSchema = z
  .strictObject({
    id: identifier.max(100),
    match: MatchSchema,
    decision: z.enum(DECISION_KINDS),
    reason: z.string().max(2000).optional(),
    approvers: z.array(identifier).min(1).optional(),
    reviewer: z.strictObject({ role: identifier, name: z.string().max(200).optional() }).optional(),
    decision_id: z.string().min(1).max(200).optional(),
  })
  .refine(
    (r) => r.decision !== "decision_backed" || r.decision_id !== undefined,
    "decision_backed needs decision_id",
  );

export const PolicyFileSchema = z.strictObject({
  version: z.literal(1),
  default: z.enum(DECISION_KINDS).default("allow"),
  rules: z.array(RuleSchema).default([]),
});

export const DelegationsFileSchema = z.strictObject({
  version: z.literal(1),
  delegations: z
    .array(
      z.strictObject({
        principal: identifier,
        profession: identifier,
        valid_from: isoDate.optional(),
        valid_until: isoDate.nullable().optional(),
      }),
    )
    .default([]),
});

/** What a reviewer decided, written to authority/decisions/ and cited by a decision_backed rule. */
export const DecisionFileSchema = z.strictObject({
  // One path segment: the id becomes the file name under authority/decisions/.
  id: z
    .string()
    .min(1)
    .max(200)
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
      "a decision id is letters, digits, dot, dash and underscore",
    ),
  reviewer: z.strictObject({
    name: z.string().min(1).max(200),
    role: identifier,
    /** As the company states it. openshain does not verify a qualification. */
    qualification: z.string().max(500).optional(),
  }),
  approval_id: z.string().min(1).max(200),
  decided_at: z.iso.datetime(),
  effective_from: isoDate,
  effective_until: isoDate.nullable().default(null),
  interpretation: z.string().min(1).max(100_000),
  applies_to: z
    .strictObject({ action: z.string().max(200).optional(), path: z.string().max(1000).optional() })
    .default({}),
});

export type DecisionRecord = z.output<typeof DecisionFileSchema>;

export type PolicyFile = z.output<typeof PolicyFileSchema>;
export type Rule = PolicyFile["rules"][number];
export type Delegation = z.output<typeof DelegationsFileSchema>["delegations"][number];

/** What the runtime knows about who may do what in a workspace. */
export interface Authority {
  /** False when the workspace has no authority/ directory: everything is allowed, as before. */
  present: boolean;
  policy: PolicyFile;
  delegations: Delegation[];
  /** The reviewers' decisions, by id. A decision_backed rule cites one. */
  decisions: Map<string, DecisionRecord>;
}

/** One tool call, as the policy sees it. */
export interface AuthorityRequest {
  tool: string;
  effect: "observe" | "mutate";
  /** The path the call names, normalized and relative to the workspace, if it names one. */
  path?: string;
  principal: string;
  profession: string;
  workType: string;
  /** A name a pack or the policy gives the action. This version uses the tool's name. */
  action?: string;
  /** Today's business date (YYYY-MM-DD), for the delegation's validity. */
  businessDate: string;
}

export type Decision =
  | { kind: "allow"; rule?: Rule; decision?: DecisionRecord }
  | { kind: "deny"; rule?: Rule; reason: string }
  | { kind: "approval_required" | "review_required"; rule: Rule; why?: string };

/** An authority that allows everything: what a workspace without authority/ gets. */
export const OPEN_AUTHORITY: Authority = Object.freeze<Authority>({
  present: false,
  policy: { version: 1, default: "allow", rules: [] },
  delegations: [],
  decisions: new Map(),
});

/** Reads authority/ of a workspace. A workspace without it is open, as every workspace was before. */
export async function loadAuthority(workspaceRoot: string): Promise<Authority> {
  const dir = join(workspaceRoot, AUTHORITY_DIR_NAME);
  try {
    if (!(await stat(dir)).isDirectory()) return OPEN_AUTHORITY;
  } catch {
    return OPEN_AUTHORITY;
  }
  const policy = await readOptional(join(dir, POLICY_FILE_NAME));
  const delegations = await readOptional(join(dir, DELEGATIONS_FILE_NAME));
  return {
    present: true,
    decisions: await readDecisions(join(dir, DECISIONS_DIR_NAME)),
    policy:
      policy === undefined
        ? { version: 1, default: "allow", rules: [] }
        : parseYamlFile(policy, PolicyFileSchema, `${AUTHORITY_DIR_NAME}/${POLICY_FILE_NAME}`).data,
    delegations:
      delegations === undefined
        ? []
        : parseYamlFile(
            delegations,
            DelegationsFileSchema,
            `${AUTHORITY_DIR_NAME}/${DELEGATIONS_FILE_NAME}`,
          ).data.delegations,
  };
}

/** Every decision under authority/decisions/, by id. A file that cannot be read is a config error. */
async function readDecisions(dir: string): Promise<Map<string, DecisionRecord>> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".yaml"));
  } catch {
    return new Map();
  }
  const decisions = new Map<string, DecisionRecord>();
  for (const name of names.sort()) {
    const text = await readFile(join(dir, name), "utf8");
    const { data } = parseYamlFile(
      text,
      DecisionFileSchema,
      `${AUTHORITY_DIR_NAME}/${DECISIONS_DIR_NAME}/${name}`,
    );
    decisions.set(data.id, data);
  }
  return decisions;
}

/** Writes one decision under authority/decisions/. The runtime owns that directory. */
export async function writeDecision(
  workspaceRoot: string,
  decision: DecisionRecord,
): Promise<string> {
  // The id is checked again here: this function is public, and the id names a file.
  const checked = DecisionFileSchema.parse(decision);
  try {
    if (!(await stat(join(workspaceRoot, AUTHORITY_DIR_NAME))).isDirectory()) throw new Error();
  } catch {
    throw new OpenshainError(
      "config",
      `this workspace has no ${AUTHORITY_DIR_NAME}/, so it has no policy to decide under`,
    );
  }
  const dir = join(workspaceRoot, AUTHORITY_DIR_NAME, DECISIONS_DIR_NAME);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${checked.id}.yaml`);
  await writeFile(file, toYaml(checked), { flag: "wx" });
  return file;
}

/**
 * A decision as YAML. Written by hand so that core keeps one YAML dependency, for reading.
 * The interpretation is a block scalar without trailing blank lines, so that what is read back
 * equals what was written.
 */
function toYaml(decision: DecisionRecord): string {
  const quote = (text: string) => JSON.stringify(text);
  return `${[
    `id: ${quote(decision.id)}`,
    "reviewer:",
    `  name: ${quote(decision.reviewer.name)}`,
    `  role: ${decision.reviewer.role}`,
    ...(decision.reviewer.qualification !== undefined
      ? [`  qualification: ${quote(decision.reviewer.qualification)}`]
      : []),
    `approval_id: ${quote(decision.approval_id)}`,
    `decided_at: ${quote(decision.decided_at)}`,
    `effective_from: ${quote(decision.effective_from)}`,
    `effective_until: ${decision.effective_until === null ? "null" : quote(decision.effective_until)}`,
    "interpretation: |-",
    ...decision.interpretation
      .replace(/\n+$/, "")
      .split("\n")
      .map((line) => `  ${line}`),
    // An empty applies_to is written inline: a bare key would read back as null, not as an object.
    ...(decision.applies_to.action === undefined && decision.applies_to.path === undefined
      ? ["applies_to: {}"]
      : [
          "applies_to:",
          ...(decision.applies_to.action !== undefined
            ? [`  action: ${quote(decision.applies_to.action)}`]
            : []),
          ...(decision.applies_to.path !== undefined
            ? [`  path: ${quote(decision.applies_to.path)}`]
            : []),
        ]),
  ].join("\n")}\n`;
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * Judges one call. Ordinary code: the first rule whose every condition holds decides, else the
 * policy's default. Without a delegation for the principal and the profession, everything is
 * denied. A workspace without authority/ allows everything and needs no delegation.
 */
export function evaluate(authority: Authority, request: AuthorityRequest): Decision {
  if (!authority.present) return { kind: "allow" };
  if (!delegated(authority.delegations, request)) {
    return {
      kind: "deny",
      reason: `no delegation lets a ${request.profession} act for ${request.principal} on ${request.businessDate}`,
    };
  }
  const rule = authority.policy.rules.find((r) => matches(r, request));
  const kind = rule?.decision ?? authority.policy.default;
  switch (kind) {
    case "allow":
      return rule ? { kind, rule } : { kind };
    case "deny":
      return {
        kind,
        ...(rule && { rule }),
        reason:
          rule?.reason ?? (rule ? `denied by rule ${rule.id}` : "denied by the policy's default"),
      };
    case "decision_backed": {
      // The rule cites a reviewer's decision. Without a valid one that covers this call, the
      // reviewer has to look at it again: the rule falls back to a review.
      const named = rule ?? { id: "default", match: {}, decision: kind };
      const decision = named.decision_id ? authority.decisions.get(named.decision_id) : undefined;
      const why = !decision
        ? `rule ${named.id} cites decision ${named.decision_id}, which this workspace does not have`
        : !inEffect(decision, request.businessDate)
          ? `decision ${decision.id} is not in effect on ${request.businessDate}`
          : !covers(decision, request)
            ? `decision ${decision.id} does not cover this call`
            : undefined;
      if (decision && why === undefined) return { kind: "allow", rule: named, decision };
      return { kind: "review_required", rule: named, ...(why !== undefined && { why }) };
    }
    default:
      // approval_required and review_required need a rule to name approvers or a reviewer;
      // a default of that kind is treated as a rule-less request.
      return { kind, rule: rule ?? { id: "default", match: {}, decision: kind } };
  }
}

/** Whether the business date falls in the decision's window. */
function inEffect(decision: DecisionRecord, businessDate: string): boolean {
  return (
    decision.effective_from <= businessDate &&
    (decision.effective_until === null || businessDate <= decision.effective_until)
  );
}

/** Whether the decision was written for this kind of call. An empty applies_to covers the rule. */
function covers(decision: DecisionRecord, request: AuthorityRequest): boolean {
  const { action, path } = decision.applies_to;
  if (action !== undefined && action !== (request.action ?? request.tool)) return false;
  if (path !== undefined && (request.path === undefined || !matchGlob(path, request.path))) {
    return false;
  }
  return true;
}

function delegated(delegations: Delegation[], request: AuthorityRequest): boolean {
  return delegations.some(
    (d) =>
      d.principal === request.principal &&
      d.profession === request.profession &&
      (d.valid_from === undefined || d.valid_from <= request.businessDate) &&
      (d.valid_until === undefined ||
        d.valid_until === null ||
        request.businessDate <= d.valid_until),
  );
}

function matches(rule: Rule, request: AuthorityRequest): boolean {
  const m = rule.match;
  if (m.tool !== undefined && !oneOf(m.tool, request.tool)) return false;
  if (m.effect !== undefined && m.effect !== request.effect) return false;
  if (m.principal !== undefined && !oneOf(m.principal, request.principal)) return false;
  if (m.work_type !== undefined && !oneOf(m.work_type, request.workType)) return false;
  if (m.action !== undefined && !oneOf(m.action, request.action ?? request.tool)) return false;
  if (m.path !== undefined) {
    if (request.path === undefined) return false;
    if (!matchGlob(m.path, request.path)) return false;
  }
  return true;
}

function oneOf(expected: string | string[], actual: string): boolean {
  return Array.isArray(expected) ? expected.includes(actual) : expected === actual;
}

/**
 * Matches a workspace-relative path against a glob: `*` stands for part of one segment, `**`
 * for any number of whole segments. No other syntax. `ledger/**` matches everything under
 * ledger/, `*.csv` a CSV at the root, `**\/*.csv` a CSV anywhere.
 */
export function matchGlob(pattern: string, path: string): boolean {
  // Repeated `**` means the same as one, and collapsing them keeps the match linear.
  const parts = pattern.split("/").filter((part, i, all) => part !== "**" || all[i - 1] !== "**");
  return matchSegments(parts, path.split("/"));
}

function matchSegments(pattern: string[], path: string[]): boolean {
  if (pattern.length === 0) return path.length === 0;
  const [head, ...rest] = pattern as [string, ...string[]];
  if (head === "**") {
    for (let i = 0; i <= path.length; i++) {
      if (matchSegments(rest, path.slice(i))) return true;
    }
    return false;
  }
  if (path.length === 0) return false;
  const [segment, ...remaining] = path as [string, ...string[]];
  return matchSegment(head, segment) && matchSegments(rest, remaining);
}

function matchSegment(pattern: string, segment: string): boolean {
  const parts = pattern.split("*");
  if (parts.length === 1) return pattern === segment;
  let position = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? "";
    if (i === 0) {
      if (!segment.startsWith(part)) return false;
      position = part.length;
    } else if (i === parts.length - 1) {
      return segment.slice(position).endsWith(part);
    } else {
      const found = segment.indexOf(part, position);
      if (found === -1) return false;
      position = found + part.length;
    }
  }
  return true;
}
