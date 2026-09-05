// Writes the JSON Schemas of the files openshain reads and writes to spec/schemas/.
// Run with `bun run schemas`. CI fails when the committed files differ from this output.
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { jsonSchemas } from "../packages/core/src/index.ts";

const root = join(import.meta.dir, "..");
const dir = join(root, "spec", "schemas");
await mkdir(dir, { recursive: true });
for (const [name, schema] of Object.entries(jsonSchemas())) {
  const file = join(dir, `${name}.json`);
  await writeFile(file, `${JSON.stringify(schema, null, 2)}\n`);
  console.log(`wrote ${relative(root, file)}`);
}
