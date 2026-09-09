/**
 * Typed failure when the staff AI mount is invoked without a configured
 * Anthropic key and without an injected test model. The HTTP process still
 * boots — this is a request-time failure, not a ConfigValidationError.
 */
export class StaffAssistantNotConfiguredError extends Error {
  readonly code = "AI_NOT_CONFIGURED" as const;

  constructor() {
    super("Staff assistant is not configured.");
    this.name = "StaffAssistantNotConfiguredError";
  }
}

/**
 * Upstream `streamText` failed before this turn produced usable model
 * prose and without a committed domain write. Chat must not persist
 * "Готово." as a successful empty reply (Anthropic 400 on illegal
 * `tool_use.id`). Phase B after a write still returns fallback speech.
 */
export class StaffAssistantProviderError extends Error {
  readonly code = "AI_PROVIDER_ERROR" as const;

  constructor(cause?: unknown) {
    super("The assistant could not complete this turn.");
    this.name = "StaffAssistantProviderError";
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}
