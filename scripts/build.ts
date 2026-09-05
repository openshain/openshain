// Compiles the CLI into one executable. `bun run build` builds for this machine into
// dist/openshain; the release workflow passes --target and --outfile for each platform.
// Ink imports `react-devtools-core` only when DEV=true, but the bundler still has to resolve
// it, so the plugin below stands in an empty module for it.
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { target: { type: "string" }, outfile: { type: "string", default: "dist/openshain" } },
});
const root = join(import.meta.dir, "..");
const outfile = join(root, values.outfile ?? "dist/openshain");
const target = values.target;

const result = await Bun.build({
  entrypoints: [join(root, "packages/cli/src/bin.ts")],
  target: "bun",
  compile: { outfile, ...(target && { target: target as never }) },
  plugins: [
    {
      name: "stub-react-devtools-core",
      setup(build) {
        build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
          path: "react-devtools-core",
          namespace: "stub",
        }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents: "export default { initialize() {}, connectToDevTools() {} };",
          loader: "js",
        }));
      },
    },
  ],
});
if (!result.success) {
  for (const log of result.logs) console.error(String(log));
  process.exit(1);
}
console.log(`wrote ${values.outfile}${target ? ` (${target})` : ""}`);
