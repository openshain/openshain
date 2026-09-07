import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { OpenshainError } from "../errors.ts";
import { type Config, ConfigFileSchema, toConfig } from "./schema.ts";
import { parseYamlFile } from "./yaml.ts";

export const CONFIG_FILE_NAME = "openshain.yaml";

export interface ParseConfigOptions {
  /** Provider ids the runtime can construct. When given, other names are rejected. */
  modelProviders?: readonly string[];
  /** Name used in error messages. Defaults to openshain.yaml. */
  fileName?: string;
}

export async function loadConfig(
  workspaceRoot: string,
  options: Omit<ParseConfigOptions, "fileName"> = {},
): Promise<Config> {
  const fileName = join(workspaceRoot, CONFIG_FILE_NAME);
  let text: string;
  try {
    text = await readFile(fileName, "utf8");
  } catch (cause) {
    throw new OpenshainError("config", `${CONFIG_FILE_NAME} not found in ${workspaceRoot}`, {
      cause,
    });
  }
  return parseConfig(text, { ...options, fileName });
}

export function parseConfig(text: string, options: ParseConfigOptions = {}): Config {
  const fileName = options.fileName ?? CONFIG_FILE_NAME;
  const { data, problem } = parseYamlFile(text, ConfigFileSchema, fileName);
  const result = { data };

  const known = options.modelProviders;
  if (known && result.data.model && !known.includes(result.data.model.provider)) {
    throw new OpenshainError(
      "config",
      problem(
        ["model", "provider"],
        `unknown provider "${result.data.model.provider}"; known providers: ${known.length > 0 ? known.join(", ") : "none"}`,
      ),
    );
  }

  return toConfig(result.data);
}
