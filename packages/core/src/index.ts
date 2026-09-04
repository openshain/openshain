// @openshain/core: Contracts (provider interfaces), fundamental objects, and the work runtime
export {
  CONFIG_FILE_NAME,
  loadConfig,
  type ParseConfigOptions,
  parseConfig,
} from "./config/load.ts";
export type { Config, ToolProviderRef } from "./config/schema.ts";
export { ERROR_CODES, type ErrorCode, isOpenshainError, OpenshainError } from "./errors.ts";
export {
  type EventId,
  newEventId,
  newWorkId,
  parseEventId,
  parseWorkId,
  type WorkId,
} from "./ids.ts";
export type {
  ModelDescription,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  UserPart,
} from "./model/types.ts";
export {
  type CreateRuntimeOptions,
  createRuntime,
  createToolRegistry,
  MAX_TOOL_TEXT_CHARS,
  type Runtime,
  type RuntimeProviders,
  type ToolSummary,
} from "./runtime.ts";
export { loadToolModule } from "./tool/load-module.ts";
export { RESERVED_PATHS, resolveWorkspacePath } from "./tool/paths.ts";
export {
  type HiddenTool,
  type RegisteredTool,
  type RegisterOptions,
  ToolRegistry,
} from "./tool/registry.ts";
export {
  ASK_USER_TOOL_NAME,
  type JsonSchema,
  RESERVED_TOOL_NAMES,
  TOOL_NAME_PATTERN,
  type ToolCall,
  type ToolContext,
  type ToolDefinition,
  type ToolEffect,
  type ToolProvider,
  type ToolResult,
} from "./tool/types.ts";
export { compileInputValidator, type InputValidation } from "./tool/validate.ts";
export { EVENTS_FILE_NAME, EventLog, type NewEvent } from "./work/event-log.ts";
export {
  type AnyEvent,
  type Artifact,
  type AssistantPart,
  canonical,
  type Event,
  type EventFile,
  EventFileSchema,
  type EventPayloads,
  type EventType,
  eventFromFile,
  eventToFile,
  type ModelUsage,
  payloadFileSchemas,
  type StopReason,
  TOOL_REJECTION_CODES,
  type ToolContent,
  type ToolRejectionCode,
  type UnknownEvent,
} from "./work/events.ts";
export { acquireLock, LOCK_FILE_NAME, type Lock } from "./work/lock.ts";
export { buildProjection, type Projection, type ProjectionInput } from "./work/projection.ts";
export {
  type CreateWorkInput,
  type ListResult,
  WORK_DIR_NAME,
  WORK_FILE_NAME,
  type WorkHandle,
  WorkStore,
} from "./work/store.ts";
export {
  isTerminal,
  reduceWork,
  transition,
  WORK_STATUSES,
  type Work,
  type WorkFile,
  WorkFileSchema,
  WorkStatus,
  workToFile,
} from "./work/work.ts";
