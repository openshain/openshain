// @openshain/core: Contracts (provider interfaces), fundamental objects, and the work runtime

export { matchGlob, reaches } from "./authority/glob.ts";
export {
  AUTHORITY_DIR_NAME,
  type Authority,
  type AuthorityRequest,
  DECISION_KINDS,
  DECISIONS_DIR_NAME,
  DELEGATIONS_FILE_NAME,
  type Decision,
  DecisionFileSchema,
  type DecisionKind,
  type DecisionRecord,
  type Delegation,
  DelegationsFileSchema,
  evaluate,
  liveAuthority,
  loadAuthority,
  OPEN_AUTHORITY,
  POLICY_FILE_NAME,
  type PolicyFile,
  PolicyFileSchema,
  type Rule,
  writeDecision,
} from "./authority/policy.ts";
export {
  isActive,
  mayReachInto,
  mayRead,
  mayReadWork,
  PRINCIPALS_DIR_NAME,
  type Principal,
  readPrincipals,
} from "./authority/principals.ts";
export {
  CONFIG_FILE_NAME,
  loadConfig,
  type ParseConfigOptions,
  parseConfig,
} from "./config/load.ts";
export type { Config, ModelConfig, ToolProviderRef } from "./config/schema.ts";
export { LANGUAGES, type Language } from "./config/schema.ts";
export {
  ERROR_CODES,
  type ErrorCode,
  isOpenshainError,
  isTooLarge,
  OpenshainError,
} from "./errors.ts";
export {
  type EventId,
  newEventId,
  newWorkId,
  parseEventId,
  parseWorkId,
  type WorkId,
} from "./ids.ts";
export {
  buildIndex,
  hashKnowledgeInput,
  INDEX_FORMAT_VERSION,
  type IndexState,
  type IndexUnit,
  type KnowledgeIndex,
  type Manifest,
  readIndex,
  serializeIndex,
  writeIndex,
} from "./knowledge/build.ts";
export {
  type Checked,
  checkKnowledge,
  hasKnowledge,
  KNOWLEDGE_DIR_NAME,
} from "./knowledge/check.ts";
export {
  type LoadedRule as LoadedKnowledgeRule,
  type Rule as KnowledgeRule,
  RuleSchema as KnowledgeRuleSchema,
  RulesFileSchema,
  type Scope as KnowledgeScope,
  ScopeSchema as KnowledgeScopeSchema,
  type Source as KnowledgeSource,
  type SourceFrontMatter,
  SourceFrontMatterSchema,
} from "./knowledge/schema.ts";
export {
  type Hit,
  inEffect,
  MIN_QUERY_LENGTH,
  type SearchOptions,
  search,
} from "./knowledge/search.ts";
export {
  knowledgePath,
  readKnowledgeFile,
  writeKnowledgeFile,
} from "./knowledge/store.ts";
export type {
  ModelDescription,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  UserPart,
} from "./model/types.ts";
export {
  type CallOptions,
  type CreateRuntimeOptions,
  createRuntime,
  createToolCaller,
  createToolRegistry,
  MAX_TOOL_TEXT_CHARS,
  type PendingApprovalResult,
  REVIEW_DIR_NAME,
  type Runtime,
  type RuntimeProviders,
  type ToolSummary,
} from "./runtime.ts";
export { jsonSchemas, type SchemaName } from "./schemas.ts";
export { businessDate, companyTime, hostTimezone, isTimezone } from "./time.ts";
export { ASK_USER, RUNTIME_PROVIDER_ID } from "./tool/ask-user.ts";
export {
  MAX_BINARY_READ_BYTES,
  MAX_READ_BYTES,
  MAX_WRITE_BYTES,
  readWorkspaceBytes,
  readWorkspaceText,
  readWorkspaceTextIfAny,
  textOf,
  writeWorkspaceText,
} from "./tool/files.ts";
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
  type Observation,
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
export { uuidv7 } from "./uuid.ts";
export { hashWorkspaceFile, verifyArtifact } from "./work/artifacts.ts";
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
  isKnownEventType,
  type ModelUsage,
  parsePayloadFile,
  payloadFileSchemas,
  type ReviewPackage,
  type StopReason,
  TOOL_REJECTION_CODES,
  type ToolContent,
  type ToolRejectionCode,
  type UnknownEvent,
} from "./work/events.ts";
export {
  countToolCalls,
  type FailureReason,
  type HistoryCall,
  type PendingApproval,
  type PendingQuestion,
  pendingApprovals,
  pendingQuestions,
  type WorkHistory,
  workHistory,
} from "./work/history.ts";
export { acquireLock, LOCK_FILE_NAME, type Lock } from "./work/lock.ts";
export {
  buildProjection,
  type Projection,
  type ProjectionInput,
  RECENT_MESSAGES,
} from "./work/projection.ts";
export {
  type CreateWorkInput,
  type ListResult,
  noSuchWork,
  WORK_DIR_NAME,
  WORK_FILE_NAME,
  type WorkHandle,
  WorkStore,
} from "./work/store.ts";
export {
  isTerminal,
  reduceWork,
  SESSION_WORK_TYPE,
  transition,
  WORK_STATUSES,
  type Work,
  type WorkFile,
  WorkFileSchema,
  WorkStatus,
  workToFile,
} from "./work/work.ts";
