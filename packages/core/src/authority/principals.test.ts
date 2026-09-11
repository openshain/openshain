import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, loadAuthority } from "./policy.ts";
import { readPrincipals } from "./principals.ts";

async function workspace(people: Record<string, string>, authority?: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "openshain-principals-"));
  await mkdir(join(root, "principals"));
  for (const [name, text] of Object.entries(people)) {
    await writeFile(join(root, "principals", name), text);
  }
  if (authority) {
    await mkdir(join(root, "authority"));
    for (const [name, text] of Object.entries(authority)) {
      await writeFile(join(root, "authority", name), text);
    }
  }
  return root;
}

const alice = "id: alice\nname: Alice\nroles: [founder]\n";
const bob = "id: bob\nname: Bob\nroles: [accounting]\nreads: [ledger/**]\n";
const delegations = `version: 1
delegations:
  - principal: alice
    profession: generic
  - principal: bob
    profession: generic
`;

const asking = (principal: string, over: Record<string, unknown> = {}) => ({
  tool: "fs_read",
  effect: "observe" as const,
  principal,
  profession: "generic",
  workType: "request",
  businessDate: "2026-09-11",
  ...over,
});

describe("principals/", () => {
  test("reads a person, with what they handle and whether they are still here", async () => {
    const root = await workspace({ "alice.yaml": alice, "bob.yaml": bob });

    const people = await readPrincipals(join(root, "principals"));

    expect([...people.keys()]).toEqual(["alice", "bob"]);
    expect(people.get("bob")).toMatchObject({
      name: "Bob",
      roles: ["accounting"],
      status: "active",
      reads: ["ledger/**"],
    });
  });

  test("passes over the files a sync service leaves behind", async () => {
    const root = await workspace({
      "bob.yaml": bob,
      "bob (conflicted copy).yaml": "id: bob\nname: Bob の写し\n",
      "README.md": "人はここに書きます",
    });

    const people = await readPrincipals(join(root, "principals"));

    expect([...people.keys()]).toEqual(["bob"]);
  });

  test("a file that disagrees with its own name stops everything", async () => {
    const root = await workspace({ "bob.yaml": "id: robert\nname: Bob\n" });

    expect(readPrincipals(join(root, "principals"))).rejects.toThrow(/is the file of bob/);
  });

  test("a second file cannot claim the same person: the name is the person", async () => {
    const root = await workspace({ "bob.yaml": bob, "bob_2.yaml": "id: bob\nname: Bob\n" });

    expect(readPrincipals(join(root, "principals"))).rejects.toThrow(/is the file of bob_2/);
  });

  test("a name nobody wrote, in a delegation or an approver, stops everything", async () => {
    const missing = await workspace(
      { "alice.yaml": alice },
      {
        "delegations.yaml": delegations,
        "policy.yaml": "version: 1\ndefault: allow\nrules: []\n",
      },
    );

    expect(loadAuthority(missing)).rejects.toThrow(/names bob/);
  });
});

describe("a rule about what somebody handles", () => {
  const policy = `version: 1
default: allow
rules:
  - id: accounting-reads-the-ledger
    match: { role: accounting, path: "ledger/**" }
    decision: allow
  - id: the-ledger-is-for-accounting
    match: { path: "ledger/**" }
    decision: deny
    reason: 台帳は経理の担当です
`;

  test("matches the person who has the role, and nobody else", async () => {
    const root = await workspace(
      { "alice.yaml": alice, "bob.yaml": bob },
      { "delegations.yaml": delegations, "policy.yaml": policy },
    );
    const authority = await loadAuthority(root);

    expect(evaluate(authority, asking("bob", { path: "ledger/2026-07.csv" })).kind).toBe("allow");
    const others = evaluate(authority, asking("alice", { path: "ledger/2026-07.csv" }));
    expect(others.kind).toBe("deny");
    expect(others.kind === "deny" && others.reason).toBe("台帳は経理の担当です");
  });

  test("somebody who has left is acted for by nobody", async () => {
    const root = await workspace(
      { "alice.yaml": alice, "bob.yaml": `${bob}status: inactive\n` },
      {
        "delegations.yaml": delegations,
        "policy.yaml": "version: 1\ndefault: allow\nrules: []\n",
      },
    );
    const authority = await loadAuthority(root);

    expect(evaluate(authority, asking("bob")).kind).toBe("deny");
    expect(evaluate(authority, asking("alice")).kind).toBe("allow");
  });
});
