import { z } from "zod";
import { hostTimezone, isTimezone } from "../time.ts";

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

/** Hosts that stay on this machine, where an API key may travel without TLS. */
function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

/** Shape of openshain.yaml as written on disk (snake_case). */
/** The languages the product has words and names for. */
export const LANGUAGES = ["ja", "en"] as const;
export type Language = (typeof LANGUAGES)[number];

export const ConfigFileSchema = z.strictObject({
  version: z.literal(1),
  company: z.strictObject({
    name: z.string().min(1).max(200),
    language: z.enum(LANGUAGES).default("ja"),
    // The company's own clock decides every business date, so a workspace answers the same
    // whether it runs on a laptop in Tokyo or in a container set to UTC.
    // No default in the schema: it would bake the machine that generated it into the published
    // JSON Schema. The fallback is applied when the file is turned into a Config.
    timezone: z
      .string()
      .min(1)
      .max(100)
      .refine(isTimezone, "not a timezone name, such as Asia/Tokyo")
      .optional(),
  }),
  principal: z.strictObject({ id: identifier, name: z.string().min(1).max(200) }),
  profession: z.strictObject({ id: identifier, instructions: z.string().min(1).max(100_000) }),
  model: z
    .strictObject({
      provider: identifier,
      model: z.string().min(1).max(200),
      api_key_env: envVarName,
      base_url: z
        .url()
        .refine((value) => {
          const url = new URL(value);
          return url.username === "" && url.password === "";
        }, "base_url must not carry credentials; use api_key_env")
        .refine((value) => {
          const url = new URL(value);
          return (
            url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname))
          );
        }, "base_url must use https unless it points at this machine (localhost, 127.0.0.0/8, ::1)")
        .optional(),
      options: z.record(z.string(), z.unknown()).optional(),
      // How much this model takes as input. Written by the person: openshain does not guess a
      // length from a model's name, and an OpenAI-compatible endpoint may serve anything.
      context_tokens: z.int().positive().optional(),
    })
    .optional(),
  tools: z.array(toolProviderRef).default([{ provider: "standard" }]),
  limits: z
    .strictObject({
      max_model_calls: z.int().positive().default(30),
      max_tool_calls: z.int().positive().default(100),
      max_output_tokens: z.int().positive().default(16000),
      // What the conversation may reach before it is summarized. Written when the default does
      // not suit the model; 0 turns compaction off. Below 50000 a conversation is summarized so
      // often that it loses more than it saves.
      compact_at_input_tokens: z
        .int()
        .nonnegative()
        .refine(
          (value) => value === 0 || value >= 50_000,
          "write 0 to never compact, or at least 50000",
        )
        .optional(),
    })
    .prefault({}),
  debug: z.strictObject({ persist_raw: z.boolean().default(false) }).prefault({}),
});

export type ConfigFile = z.infer<typeof ConfigFileSchema>;

export type ToolProviderRef =
  | { provider: string; allow: readonly string[] | undefined }
  | { module: string; allow: readonly string[] | undefined };

/** Configuration as used in code (camelCase). */
/** The model section of openshain.yaml, as the model providers take it. */
export interface ModelConfig {
  provider: string;
  model: string;
  apiKeyEnv: string;
  baseUrl: string | undefined;
  options: Record<string, unknown> | undefined;
  /** How much this model takes as input, when the person wrote it. */
  contextTokens: number | undefined;
}

export interface Config {
  version: 1;
  company: { name: string; language: Language; timezone: string };
  principal: { id: string; name: string };
  profession: { id: string; instructions: string };
  /** The model the interactive CLI runs on. Absent when the workspace is used from other agents only. */
  model?: ModelConfig;
  tools: ToolProviderRef[];
  limits: {
    maxModelCalls: number;
    maxToolCalls: number;
    maxOutputTokens: number;
    /** Where the conversation is summarized, when the person wrote it. 0 never summarizes. */
    compactAtInputTokens: number | undefined;
  };
  debug: { persistRaw: boolean };
}

export function toConfig(file: ConfigFile): Config {
  return {
    version: file.version,
    company: {
      name: file.company.name,
      language: file.company.language,
      timezone: file.company.timezone ?? hostTimezone(),
    },
    principal: { id: file.principal.id, name: file.principal.name },
    profession: { id: file.profession.id, instructions: file.profession.instructions },
    ...(file.model && {
      model: {
        provider: file.model.provider,
        model: file.model.model,
        apiKeyEnv: file.model.api_key_env,
        baseUrl: file.model.base_url,
        options: file.model.options,
        contextTokens: file.model.context_tokens,
      },
    }),
    tools: file.tools.map(toToolProviderRef),
    limits: {
      maxModelCalls: file.limits.max_model_calls,
      maxToolCalls: file.limits.max_tool_calls,
      maxOutputTokens: file.limits.max_output_tokens,
      compactAtInputTokens: file.limits.compact_at_input_tokens,
    },
    debug: { persistRaw: file.debug.persist_raw },
  };
}

function toToolProviderRef(entry: ConfigFile["tools"][number]): ToolProviderRef {
  if (entry.provider !== undefined) return { provider: entry.provider, allow: entry.allow };
  if (entry.module !== undefined) return { module: entry.module, allow: entry.allow };
  throw new Error("unreachable: the schema requires provider or module");
}
