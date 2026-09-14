import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkStore } from "../work/store.ts";
import { observe } from "./trigger.ts";

const OBLIGATION = `version: 1
obligations:
  - id: accounting.invoice-received
    trigger:
      event: invoice.received
    profession: generic
    create_work:
      type: accounts_payable
      objective: 届いた請求書を処理する
`;

async function workspace(obligations?: string) {
  const root = await mkdtemp(join(tmpdir(), "openshain-observe-"));
  await writeFile(join(root, "openshain.yaml"), "version: 1\n");
  if (obligations !== undefined) {
    await mkdir(join(root, "obligations"), { recursive: true });
    await writeFile(join(root, "obligations", "accounting.yaml"), obligations);
  }
  return root;
}

const invoice = {
  type: "invoice.received",
  source: "mailbox",
  scope: { profession: "generic" },
  payloadRef: "inbox/2026-09-15.eml",
};

describe("something happened", () => {
  test("is written down, and starts the work the company said it should", async () => {
    const root = await workspace(OBLIGATION);

    const { observation, works } = await observe(root, "alice", invoice);

    const written = JSON.parse(
      await readFile(join(root, "observations", `${observation.id}.json`), "utf8"),
    );
    expect(written).toMatchObject({
      type: "invoice.received",
      source: "mailbox",
      scope: { profession: "generic" },
      payloadRef: "inbox/2026-09-15.eml",
    });
    expect(written.observedAt).toBeTruthy();
    expect(written.recordedAt).toBeTruthy();

    expect(works).toHaveLength(1);
    const work = await new WorkStore(root).get(works[0] as never);
    expect(work).toMatchObject({
      type: "accounts_payable",
      objective: "届いた請求書を処理する",
      principal: "alice",
      // What it came of, and what turned it into work.
      observation: observation.id,
      obligation: "accounting.invoice-received",
    });
  });

  test("is written down and starts nothing when the company said nothing about it", async () => {
    const root = await workspace(OBLIGATION);

    const { observation, works } = await observe(root, "alice", {
      ...invoice,
      type: "parcel.delivered",
    });

    expect(works).toEqual([]);
    expect(await readFile(join(root, "observations", `${observation.id}.json`), "utf8")).toContain(
      "parcel.delivered",
    );
  });

  test("does not start work an obligation of another profession asks for", async () => {
    const root = await workspace(OBLIGATION.replace("profession: generic", "profession: legal"));

    const { works } = await observe(root, "alice", invoice);

    expect(works).toEqual([]);
  });

  test("starts one work for each obligation that asks for it", async () => {
    const root = await workspace(
      `${OBLIGATION}  - id: accounting.file-it
    trigger:
      event: invoice.received
    profession: generic
    create_work:
      type: filing
      objective: 請求書を保存する
`,
    );

    const { works } = await observe(root, "alice", invoice);

    expect(works).toHaveLength(2);
  });

  test("a workspace with no obligations writes the observation and stops there", async () => {
    const root = await workspace();

    const { observation, works } = await observe(root, "alice", invoice);

    expect(works).toEqual([]);
    expect(observation.type).toBe("invoice.received");
  });
});
