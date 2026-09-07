import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { parseYamlFile } from "../config/yaml.ts";

/** Files under authority/ the runtime reads. */
export const AUTHORITY_DIR_NAME = "authority";
export const POLICY_FILE_NAME = "policy.yaml";
export const DELEGATIONS_FILE_NAME = "delegations.yaml";

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

export type PolicyFile = z.output<typeof PolicyFileSchema>;
export type Rule = PolicyFile["rules"][number];
export type Delegation = z.output<typeof DelegationsFileSchema>["delegations"][number];

/** What the runtime knows about who may do what in a workspace. */
export interface Authority {
  /** False when the workspace has no authority/ directory: everything is allowed, as before. */
  present: boolean;
  policy: PolicyFile;
  delegations: Delegation[];
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
  | { kind: "allow"; rule?: Rule }
  | { kind: "deny"; rule?: Rule; reason: string }
  | { kind: "approval_required" | "review_required" | "decision_backed"; rule: Rule };

/** An authority that allows everything: what a workspace without authority/ gets. */
export const OPEN_AUTHORITY: Authority = Object.freeze<Authority>({
  present: false,
  policy: { version: 1, default: "allow", rules: [] },
  delegations: [],
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
    default:
      // approval_required, review_required and decision_backed need a rule to name approvers,
      // a reviewer or a decision; a default of that kind is treated as a rule-less request.
      return { kind, rule: rule ?? { id: "default", match: {}, decision: kind } };
  }
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
  return matchSegments(pattern.split("/"), path.split("/"));
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
