export const ERROR_CODES = [
  "auth",
  "network",
  "rate_limit",
  "invalid_response",
  "config",
  "corrupt_log",
  "invalid_transition",
  "duplicate_tool",
  "invalid_id",
  "invalid_tool",
  "invalid_path",
  "lock_held",
  "not_found",
  "reserved_path",
  "outside_workspace",
  "concurrent_write",
  "invalid_event",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class OpenshainError extends Error {
  override readonly name = "OpenshainError";
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

export function isOpenshainError(value: unknown): value is OpenshainError {
  return value instanceof OpenshainError;
}
