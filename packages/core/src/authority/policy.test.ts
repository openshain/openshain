import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenshainError } from "../errors.ts";
import {
  type Authority,
  type AuthorityRequest,
  type DecisionRecord,
  evaluate,
  loadAuthority,
  matchGlob,
  OPEN_AUTHORITY,
  type Rule,
  writeDecision,
} from "./policy.ts";

const request = (over: Partial<AuthorityRequest> = {}): AuthorityRequest => ({
  tool: "fs_write",
  effect: "mutate",
  path: "ledger/2026-07.csv",
  principal: "alice",
  profession: "generic",
  workType: "request",
  businessDate: "2026-09-07",
  ...over,
});

const delegated: Authority = {
  present: true,
  policy: { version: 1, default: "allow", rules: [] },
  delegations: [{ principal: "alice", profession: "generic" }],
  decisions: new Map(),
};

const decision = (over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  id: "dec_1",
  reviewer: { name: "田中", role: "tax-accountant" },
  approval_id: "apr_1",
  decided_at: "2026-09-01T00:00:00.000Z",
  effective_from: "2026-09-01",
  effective_until: null,
  interpretation: "この処理で進めてよい",
  applies_to: {},
  ...over,
});

const backed = (rule: Partial<Rule>, decisions: DecisionRecord[]): Authority => ({
  ...delegated,
  policy: {
    version: 1,
    default: "allow",
    rules: [
      {
        id: "tax",
        match: { tool: "fs_write" },
        decision: "decision_backed",
        decision_id: "dec_1",
        ...rule,
      } as Rule,
    ],
  },
  decisions: new Map(decisions.map((d) => [d.id, d])),
});

describe("matchGlob", () => {
  test("* is part of one segment, ** any number of segments", () => {
    expect(matchGlob("ledger/**", "ledger/2026-07.csv")).toBe(true);
    expect(matchGlob("ledger/**", "ledger/a/b/c.csv")).toBe(true);
    expect(matchGlob("ledger/**", "ledger")).toBe(true);
    expect(matchGlob("ledger/**", "receipts/x.csv")).toBe(false);
    expect(matchGlob("*.csv", "a.csv")).toBe(true);
    expect(matchGlob("*.csv", "dir/a.csv")).toBe(false);
    expect(matchGlob("**/*.csv", "dir/sub/a.csv")).toBe(true);
    expect(matchGlob("**/*.csv", "a.csv")).toBe(true);
    expect(matchGlob("ledger/2026-*.csv", "ledger/2026-07.csv")).toBe(true);
    expect(matchGlob("ledger/2026-*.csv", "ledger/2025-07.csv")).toBe(false);
    expect(matchGlob("summary.md", "summary.md")).toBe(true);
    expect(matchGlob("summary.md", "summary.md.bak")).toBe(false);
    // Repeated ** is the same as one, so a pathological pattern cannot blow up.
    expect(matchGlob("**/**/**/**/**/*.csv", "a/b/c/d/e/f/g/h/i/j/k/l.csv")).toBe(true);
    expect(matchGlob("**/**/x", "a/b/y")).toBe(false);
  });
});

describe("evaluate", () => {
  test("a workspace without authority/ allows everything and needs no delegation", () => {
    expect(evaluate(OPEN_AUTHORITY, request({ principal: "nobody" }))).toEqual({ kind: "allow" });
  });

  test("without a delegation for the principal and profession, everything is denied", () => {
    expect(evaluate(delegated, request({ principal: "bob" })).kind).toBe("deny");
    expect(evaluate(delegated, request({ profession: "accounting" })).kind).toBe("deny");
    expect(evaluate(delegated, request({ tool: "fs_list", effect: "observe" })).kind).toBe("allow");
  });

  test("a delegation has a validity window", () => {
    const windowed: Authority = {
      ...delegated,
      delegations: [
        {
          principal: "alice",
          profession: "generic",
          valid_from: "2026-09-01",
          valid_until: "2026-09-30",
        },
      ],
    };
    expect(evaluate(windowed, request({ businessDate: "2026-09-15" })).kind).toBe("allow");
    expect(evaluate(windowed, request({ businessDate: "2026-08-31" })).kind).toBe("deny");
    expect(evaluate(windowed, request({ businessDate: "2026-10-01" })).kind).toBe("deny");
  });

  test("the first matching rule decides; conditions are ANDed; the default closes the list", () => {
    const authority: Authority = {
      ...delegated,
      policy: {
        version: 1,
        default: "deny",
        rules: [
          { id: "read-anything", match: { effect: "observe" }, decision: "allow" },
          {
            id: "ledger-needs-approval",
            match: { tool: ["fs_write", "csv_write"], path: "ledger/**" },
            decision: "approval_required",
            approvers: ["alice"],
          },
          {
            id: "contracts-read-only",
            match: { effect: "mutate", path: "contracts/**" },
            decision: "deny",
            reason: "契約書は変更しません",
          },
          { id: "notes", match: { tool: "fs_write", path: "notes/**" }, decision: "allow" },
        ],
      },
    };
    expect(evaluate(authority, request({ tool: "fs_read", effect: "observe" })).kind).toBe("allow");
    expect(evaluate(authority, request())).toMatchObject({
      kind: "approval_required",
      rule: { id: "ledger-needs-approval" },
    });
    expect(evaluate(authority, request({ path: "contracts/nda.md" }))).toMatchObject({
      kind: "deny",
      reason: "契約書は変更しません",
    });
    expect(evaluate(authority, request({ path: "notes/todo.md" })).kind).toBe("allow");
    expect(evaluate(authority, request({ path: "other/x.md" }))).toMatchObject({
      kind: "deny",
      reason: "denied by the policy's default",
    });
    // A rule on path never matches a call that names no path.
    const { path: _, ...noPath } = request({ tool: "csv_write" });
    expect(evaluate(authority, noPath).kind).toBe("deny");
  });

  test("action matches the tool's name unless the call carries an action", () => {
    const authority: Authority = {
      ...delegated,
      policy: {
        version: 1,
        default: "allow",
        rules: [
          {
            id: "tax",
            match: { action: "tax-treatment" },
            decision: "review_required",
            reviewer: { role: "tax-accountant" },
          },
        ],
      },
    };
    expect(evaluate(authority, request({ action: "tax-treatment" })).kind).toBe("review_required");
    expect(evaluate(authority, request()).kind).toBe("allow");
  });
});

describe("evaluate, with a reviewer's decision", () => {
  test("a decision that is in effect and covers the call lets it run", () => {
    const judged = evaluate(backed({}, [decision()]), request());

    expect(judged.kind).toBe("allow");
    expect(judged.kind === "allow" && judged.decision?.id).toBe("dec_1");
  });

  test("no decision, an expired one, or one that does not cover the call sends it back to review", () => {
    const missing = evaluate(backed({}, []), request());
    expect(missing).toMatchObject({ kind: "review_required" });
    expect(missing.kind === "review_required" && missing.why).toContain("does not have");

    const expired = evaluate(
      backed({}, [decision({ effective_until: "2026-09-06" })]),
      request({ businessDate: "2026-09-07" }),
    );
    expect(expired.kind === "review_required" && expired.why).toContain("not in effect");

    const early = evaluate(
      backed({}, [decision({ effective_from: "2026-10-01" })]),
      request({ businessDate: "2026-09-07" }),
    );
    expect(early.kind).toBe("review_required");

    const elsewhere = evaluate(
      backed({}, [decision({ applies_to: { path: "receipts/**" } })]),
      request({ path: "ledger/2026-07.csv" }),
    );
    expect(elsewhere.kind === "review_required" && elsewhere.why).toContain("does not cover");
  });

  test("applies_to narrows a decision to an action and a path", () => {
    const scoped = decision({ applies_to: { action: "tax-treatment", path: "ledger/**" } });
    expect(
      evaluate(backed({}, [scoped]), request({ action: "tax-treatment", path: "ledger/a.csv" }))
        .kind,
    ).toBe("allow");
    expect(evaluate(backed({}, [scoped]), request({ path: "ledger/a.csv" })).kind).toBe(
      "review_required",
    );
  });
});

describe("loadAuthority", () => {
  test("reads policy.yaml and delegations.yaml, and reports problems with line numbers", async () => {
    const root = await mkdtemp(join(tmpdir(), "openshain-authority-"));
    expect(await loadAuthority(root)).toBe(OPEN_AUTHORITY);

    await mkdir(join(root, "authority"));
    await writeFile(
      join(root, "authority", "policy.yaml"),
      `version: 1
default: allow
rules:
  - id: ledger
    match: { tool: fs_write, path: "ledger/**" }
    decision: approval_required
    approvers: [alice]
`,
    );
    await writeFile(
      join(root, "authority", "delegations.yaml"),
      "version: 1\ndelegations:\n  - principal: alice\n    profession: generic\n",
    );
    const authority = await loadAuthority(root);
    expect(authority.present).toBe(true);
    expect(authority.policy.rules.map((r) => r.id)).toEqual(["ledger"]);
    expect(authority.delegations).toEqual([{ principal: "alice", profession: "generic" }]);

    await writeFile(
      join(root, "authority", "policy.yaml"),
      "version: 1\nrules:\n  - id: bad\n    match: {}\n    decision: maybe\n",
    );
    await expect(loadAuthority(root)).rejects.toThrow(OpenshainError);
    await expect(loadAuthority(root)).rejects.toThrow(/authority\/policy\.yaml:5:/);

    await writeFile(
      join(root, "authority", "policy.yaml"),
      "version: 1\nrules:\n  - id: needs-decision\n    match: { tool: fs_write }\n    decision: decision_backed\n",
    );
    await expect(loadAuthority(root)).rejects.toThrow(/decision_id/);
  });

  test("writes a decision, reads it back, and refuses to overwrite one", async () => {
    const root = await mkdtemp(join(tmpdir(), "openshain-authority-"));
    await mkdir(join(root, "authority"));
    const written = decision({
      interpretation: "1 行目\n2 行目",
      applies_to: { path: "ledger/**" },
      reviewer: { name: "田中 太郎", role: "tax-accountant", qualification: "税理士(会社の申告)" },
    });

    const file = await writeDecision(root, written);

    expect(file).toContain(join("authority", "decisions", "dec_1.yaml"));
    const authority = await loadAuthority(root);
    expect(authority.decisions.get("dec_1")).toEqual(written);
    // Trailing blank lines are not kept: what is read back is what the reviewer wrote.
    await writeDecision(root, decision({ id: "dec_2", interpretation: "本文\n\n" }));
    expect((await loadAuthority(root)).decisions.get("dec_2")?.interpretation).toBe("本文");
    await expect(writeDecision(root, written)).rejects.toThrow();
  });

  test("a decision id names a file, so it may not be a path, and it needs an authority/ to live in", async () => {
    const root = await mkdtemp(join(tmpdir(), "openshain-authority-"));

    await expect(writeDecision(root, decision({ id: "dec_1" }))).rejects.toThrow(/authority/);

    await mkdir(join(root, "authority"));
    for (const id of ["../evil", "a/b", ".hidden", ""]) {
      await expect(writeDecision(root, decision({ id }))).rejects.toThrow();
    }
    expect(existsSync(join(root, "..", "evil.yaml"))).toBe(false);
  });
});
