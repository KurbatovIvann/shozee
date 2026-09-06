/**
 * Domain error codes an action may declare. Pipeline-level codes and
 * INTERNAL are not part of this alphabet — see undeclarableErrorReason.
 */
export const DECLARED_ERROR_CODES = [
  "VALIDATION",
  "NOT_FOUND",
  "CONFLICT",
] as const;

export type DeclaredErrorCode = (typeof DECLARED_ERROR_CODES)[number];

const DECLARED_ERROR_CODE_SET: ReadonlySet<string> = new Set(
  DECLARED_ERROR_CODES,
);

export function isDeclaredErrorCode(code: string): code is DeclaredErrorCode {
  return DECLARED_ERROR_CODE_SET.has(code);
}

/**
 * Codes that must never appear in `errors`. INTERNAL is a bug signal;
 * the rest are pipeline-level and universal (never thrown by domain
 * handlers). Declaring either class per action would be noise — or, for
 * INTERNAL, a promise that the action may be broken.
 */
const UNDECLARABLE_ERROR_REASONS = {
  INTERNAL:
    "INTERNAL is a bug signal, not a contract — every action can produce it and none may promise it",
  PERMISSION_DENIED:
    "PERMISSION_DENIED is pipeline-level and universal — domain code never throws it, so declaring it per action would be noise",
  IDEMPOTENCY_CONFLICT:
    "IDEMPOTENCY_CONFLICT is pipeline-level and universal — domain code never throws it, so declaring it per action would be noise",
  RETRY_IN_PROGRESS:
    "RETRY_IN_PROGRESS is pipeline-level and universal — domain code never throws it, so declaring it per action would be noise",
  CONFIRMATION_REQUIRED:
    "CONFIRMATION_REQUIRED is pipeline-level and universal — domain code never throws it, so declaring it per action would be noise",
  RATE_LIMITED:
    "RATE_LIMITED is pipeline-level and universal — domain code never throws it, so declaring it per action would be noise",
  TIMEOUT:
    "TIMEOUT is pipeline-level and universal — domain code never throws it, so declaring it per action would be noise",
} as const;

export type UndeclarableErrorCode = keyof typeof UNDECLARABLE_ERROR_REASONS;

export function undeclarableErrorReason(code: string): string | undefined {
  if (Object.hasOwn(UNDECLARABLE_ERROR_REASONS, code)) {
    return UNDECLARABLE_ERROR_REASONS[code as UndeclarableErrorCode];
  }
  return undefined;
}
