import { z } from "zod";

const identifier = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*$/, "use lowercase letters, digits, _ or -, starting with a letter");
const envVarName = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/, "environment variable names are UPPER_SNAKE_CASE");
const toolName = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, "tool names use lowercase letters, digits and _");

// One strict object instead of a union: zod reports union failures at the union
// itself, which would hide the exact line of a bad `allow` entry.
const toolProviderRef = z
  .strictObject({
    provider: identifier.optional(),
    module: z.string().min(1).optional(),
    allow: z.array(toolName).optional(),
  })
  .refine((entry) => (entry.provider === undefined) !== (entry.module === undefined), {
    message: "name exactly one of provider or module",
  });

/** Shape of openshain.yaml as written on disk (snake_case). */
export const ConfigFileSchema = z.strictObject({
  version: z.literal(1),
  company: z.strictObject({ name: z.string().min(1).max(200) }),
  principal: z.strictObject({ id: identifier, name: z.string().min(1).max(200) }),
  profession: z.strictObject({ id: identifier, instructions: z.string().min(1).max(100_000) }),
  model: z.strictObject({
    provider: identifier,
    model: z.string().min(1).max(200),
    api_key_env: envVarName,
    base_url: z
      .url()
      .refine((value) => {
        const url = new URL(value);
        return url.username === "" && url.password === "";
      }, "base_url must not carry credentials; use api_key_env")
      .optional(),
    options: z.record(z.string(), z.unknown()).optional(),
  }),
  tools: z.array(toolProviderRef).default([{ provider: "standard" }]),
  limits: z
    .strictObject({
      max_model_calls: z.int().positive().default(30),
      max_tool_calls: z.int().positive().default(100),
      max_output_tokens: z.int().positive().default(16000),
    })
    .prefault({}),
  debug: z.strictObject({ persist_raw: z.boolean().default(false) }).prefault({}),
});

export type ConfigFile = z.infer<typeof ConfigFileSchema>;

export type ToolProviderRef =
  | { provider: string; allow: readonly string[] | undefined }
  | { module: string; allow: readonly string[] | undefined };

/** Configuration as used in code (camelCase). */
export interface Config {
  version: 1;
  company: { name: string };
  principal: { id: string; name: string };
  profession: { id: string; instructions: string };
  model: {
    provider: string;
    model: string;
    apiKeyEnv: string;
    baseUrl: string | undefined;
    options: Record<string, unknown> | undefined;
  };
  tools: ToolProviderRef[];
  limits: { maxModelCalls: number; maxToolCalls: number; maxOutputTokens: number };
  debug: { persistRaw: boolean };
}

export function toConfig(file: ConfigFile): Config {
  return {
    version: file.version,
    company: { name: file.company.name },
    principal: { id: file.principal.id, name: file.principal.name },
    profession: { id: file.profession.id, instructions: file.profession.instructions },
    model: {
      provider: file.model.provider,
      model: file.model.model,
      apiKeyEnv: file.model.api_key_env,
      baseUrl: file.model.base_url,
      options: file.model.options,
    },
    tools: file.tools.map(toToolProviderRef),
    limits: {
      maxModelCalls: file.limits.max_model_calls,
      maxToolCalls: file.limits.max_tool_calls,
      maxOutputTokens: file.limits.max_output_tokens,
    },
    debug: { persistRaw: file.debug.persist_raw },
  };
}

function toToolProviderRef(entry: ConfigFile["tools"][number]): ToolProviderRef {
  if (entry.provider !== undefined) return { provider: entry.provider, allow: entry.allow };
  if (entry.module !== undefined) return { module: entry.module, allow: entry.allow };
  throw new Error("unreachable: the schema requires provider or module");
}
