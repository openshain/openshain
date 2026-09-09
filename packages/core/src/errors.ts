export const ERROR_CODES = [
  "auth",
  "network",
  "rate_limit",
  // The request did not fit the model: the conversation has to get shorter before it can run.
  "too_large",
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

/**
 * A request the model refused for its size. Both APIs answer 400 for it, and the only thing that
 * separates it from a wrong setting is what the message says, so the words are matched loosely.
 */
export function isTooLarge(message: string): boolean {
  return /too long|too large|context[ _-]?length|maximum context|context window|reduce the length/i.test(
    message,
  );
}
