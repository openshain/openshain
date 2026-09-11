import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { principalCheck } from "./principal.ts";

const DELEGATIONS = `version: 1
delegations:
  - principal: alice
    profession: generic
  - principal: bob
    profession: generic
`;

async function workspace(people: Record<string, string>, policy?: string) {
  const root = await mkdtemp(join(tmpdir(), "openshain-principal-"));
  await mkdir(join(root, "principals"), { recursive: true });
  await mkdir(join(root, "ledger"), { recursive: true });
  await mkdir(join(root, "hr"), { recursive: true });
  await writeFile(join(root, "ledger", "2026-07.csv"), "date,amount\n");
  await writeFile(join(root, "hr", "salaries.csv"), "name,amount\n");
  // The founder is always there; the rules below delegate to both of them.
  await writeFile(join(root, "principals", "alice.yaml"), "id: alice\nname: Alice\n");
  for (const [name, text] of Object.entries(people)) {
    await writeFile(join(root, "principals", name), text);
  }
  if (policy !== undefined) {
    await mkdir(join(root, "authority"), { recursive: true });
    await writeFile(join(root, "authority", "delegations.yaml"), DELEGATIONS);
    await writeFile(join(root, "authority", "policy.yaml"), policy);
  }
  return root;
}

function reading() {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
}

const bob = "id: bob\nname: Bob\nroles: [accounting]\nreads: [ledger/**]\n";
const OPEN = "version: 1\ndefault: allow\nrules: []\n";

describe("openshain principal check", () => {
  test("says where the agent works, and lists what that actually matches", async () => {
    const root = await workspace({ "bob.yaml": bob }, OPEN);
    const { lines, write } = reading();

    const code = await principalCheck({ workspaceRoot: root, id: "bob", write });

    const text = lines.join("\n");
    expect(code).toBe(0);
    expect(text).toContain("Bob(bob)");
    expect(text).toContain("役割: accounting");
    expect(text).toContain("ledger/2026-07.csv");
    expect(text).not.toContain("hr/salaries.csv");
    expect(text).toContain("問題はありません");
  });

  test("a range that matches nothing is the mistake this command is for", async () => {
    const root = await workspace({ "bob.yaml": "id: bob\nname: Bob\nreads: [legder/**]\n" }, OPEN);
    const { lines, write } = reading();

    const code = await principalCheck({ workspaceRoot: root, id: "bob", write });

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("一致するファイルもフォルダもありません");
  });

  test("without a delegation the agent can do nothing, and says so", async () => {
    // Carol is written as a person, but no delegation lets anyone act for her.
    const root = await workspace(
      { "carol.yaml": "id: carol\nname: Carol\n", "bob.yaml": bob },
      OPEN,
    );
    const { lines, write } = reading();

    const code = await principalCheck({ workspaceRoot: root, id: "carol", write });

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("委任: ありません");
  });

  test("a rule allowing what the range does not cover is reported: rules do not widen it", async () => {
    const root = await workspace(
      { "bob.yaml": bob },
      `version: 1
default: deny
rules:
  - id: bob-reads-hr
    match: { principal: bob, path: "hr/**" }
    decision: allow
`,
    );
    const { lines, write } = reading();

    const code = await principalCheck({ workspaceRoot: root, id: "bob", write });

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("bob-reads-hr(hr/**)");
  });

  test("somebody nobody wrote is named, with who is written", async () => {
    const root = await workspace({ "bob.yaml": bob });
    const { lines, write } = reading();

    const code = await principalCheck({ workspaceRoot: root, id: "dave", write });

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("書かれているのは alice、bob です");
  });
});
