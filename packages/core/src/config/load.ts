import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PRINCIPALS_DIR_NAME, type Principal, readPrincipals } from "../authority/principals.ts";
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

export interface LoadConfigOptions extends Omit<ParseConfigOptions, "fileName"> {
  /**
   * Who this session acts for, when the person said so (`--principal`, OPENSHAIN_PRINCIPAL).
   * The company folder is shared, so the choice is made here and not written into openshain.yaml.
   */
  as?: string | undefined;
}

export async function loadConfig(
  workspaceRoot: string,
  options: LoadConfigOptions = {},
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
  const config = parseConfig(text, { ...options, fileName });
  return actingAs(
    config,
    await readPrincipals(join(workspaceRoot, PRINCIPALS_DIR_NAME)),
    options.as,
  );
}

/**
 * Who the session works for. With nobody written under principals/, it is whoever openshain.yaml
 * names, as it has always been. With people written, the name has to be one of them and they have
 * to be here; and when more than one of them has a range of their own, the session says whose it
 * is. Starting as somebody else without meaning to is the one outcome worth refusing to start for.
 */
export function actingAs(config: Config, people: Map<string, Principal>, as?: string): Config {
  if (people.size === 0) return config;
  const named = as ?? config.principal.id;
  const person = people.get(named);
  if (!person) {
    throw new OpenshainError(
      "config",
      `${named} is not written in ${PRINCIPALS_DIR_NAME}/. The people of this company: ${[...people.keys()].join(", ")}`,
    );
  }
  if (person.status !== "active") {
    throw new OpenshainError("config", `${named} is no longer with the company`);
  }
  const ranged = [...people.values()].filter((p) => p.status === "active" && p.reads !== undefined);
  if (as === undefined && ranged.length > 1) {
    throw new OpenshainError(
      "config",
      `this company folder is shared and more than one person has a range of their own. Say who is working: --principal <id> or OPENSHAIN_PRINCIPAL. The people of this company: ${[...people.keys()].join(", ")}`,
    );
  }
  return { ...config, principal: { id: person.id, name: person.name } };
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
