import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildIndex, checkKnowledge, hashKnowledgeInput, writeIndex } from "@openshain/core";
import { createMcpServer } from "@openshain/mcp";
import { standardTools } from "@openshain/tools";

/**
 * The whole way through: the people written under principals/, the name this connection works
 * under, the roles that reach the tools, and the scope of a rule in the index.
 */
test("a rule for a role reaches the people who have it, and nobody else", async () => {
  const root = await mkdtemp(join(tmpdir(), "openshain-roles-"));
  await mkdir(join(root, "knowledge", "rules"), { recursive: true });
  await mkdir(join(root, "knowledge", "sources"), { recursive: true });
  await mkdir(join(root, "principals"), { recursive: true });
  await writeFile(
    join(root, "openshain.yaml"),
    `version: 1
company:
  name: サンプル株式会社
principal:
  id: alice
  name: Alice
profession:
  id: generic
  instructions: 事務担当として働く。
tools:
  - provider: standard
`,
  );
  await writeFile(
    join(root, "principals", "alice.yaml"),
    "id: alice\nname: Alice\nroles: [founder]\n",
  );
  await writeFile(
    join(root, "principals", "bob.yaml"),
    "id: bob\nname: Bob\nroles: [accounting]\n",
  );
  await writeFile(
    join(root, "knowledge", "sources", "expenses.md"),
    `---
id: internal.expense-policy
title: 経費規程
publisher: サンプル株式会社
url: https://example.invalid/expenses
retrieved_at: 2026-04-01
effective_from: 2020-01-01
effective_to: null
expertise: none
---

## 3.2 領収書

1 万円以上の経費には領収書の原本が要ります。
`,
  );
  await writeFile(
    join(root, "knowledge", "rules", "expenses.yaml"),
    `version: 1
rules:
  - id: expenses.receipt-required
    statement: 1 万円以上の経費には領収書の原本が要ります。
    aliases: [領収書]
    effective_from: 2026-04-01
    effective_to: null
    expertise: none
    scope: { roles: [accounting] }
    source: { id: internal.expense-policy, section: "3.2 領収書" }
`,
  );
  const checked = await checkKnowledge(root);
  expect(checked.problems).toEqual([]);
  await writeIndex(root, buildIndex(checked), {
    hash: await hashKnowledgeInput(root),
    rules: checked.rules.length,
    sources: checked.sources.length,
  });

  const ask = async (as: string) => {
    const server = await createMcpServer({
      workspaceRoot: root,
      tools: { standard: (r: string) => standardTools(r) },
      as,
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(clientSide);
    await client.callTool({ name: "work_create", arguments: { objective: "決まりを引く" } });
    const result = await client.callTool({
      name: "knowledge_search",
      arguments: { query: "領収書" },
    });
    return (result.content as { text?: string }[]).map((c) => c.text ?? "").join("");
  };

  expect(await ask("bob")).toContain("expenses.receipt-required");
  expect(await ask("alice")).not.toContain("expenses.receipt-required");
});
