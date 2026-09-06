/**
 * The contract.md §4 error-mapping table — the single client-safe source
 * for wire codes, HTTP statuses, and the typed extras each code carries.
 *
 * Core error codes are pinned to the core error vocabulary (core.md §11):
 * renaming one is a breaking client API change and goes through spec
 * rework, never a casual refactor. `UNAUTHENTICATED` is transport-level
 * (no session where one is required) and is not a core error class.
 * The table test enforces the exact §4 rows; `satisfies Record<CoreErrorCode, …>`
 * keeps the core subset complete when core gains an error class.
 */
import type { DeclaredErrorCode } from "@showzy/core/contract";
import type { CoreErrorCode } from "@showzy/core/errors";
import { z } from "zod";

const coreWireErrorStatus = {
  VALIDATION: 400,
  PERMISSION_DENIED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  RETRY_IN_PROGRESS: 409,
  CONFIRMATION_REQUIRED: 409,
  RATE_LIMITED: 429,
  TIMEOUT: 504,
  INTERNAL: 500,
} as const satisfies Record<CoreErrorCode, number>;

/** HTTP status per wire code — exactly the §4 table. */
export const wireErrorStatus = {
  VALIDATION: coreWireErrorStatus.VALIDATION,
  UNAUTHENTICATED: 401,
  PERMISSION_DENIED: coreWireErrorStatus.PERMISSION_DENIED,
  NOT_FOUND: coreWireErrorStatus.NOT_FOUND,
  CONFLICT: coreWireErrorStatus.CONFLICT,
  IDEMPOTENCY_CONFLICT: coreWireErrorStatus.IDEMPOTENCY_CONFLICT,
  RETRY_IN_PROGRESS: coreWireErrorStatus.RETRY_IN_PROGRESS,
  CONFIRMATION_REQUIRED: coreWireErrorStatus.CONFIRMATION_REQUIRED,
  RATE_LIMITED: coreWireErrorStatus.RATE_LIMITED,
  TIMEOUT: coreWireErrorStatus.TIMEOUT,
  INTERNAL: coreWireErrorStatus.INTERNAL,
} as const;

/** The stable wire-code union clients discriminate on (contract.md §4). */
export type WireErrorCode = keyof typeof wireErrorStatus;

/**
 * One serialized Zod issue (§4: `VALIDATION` "+ Zod issues"). Loose on
 * purpose: issues carry per-code extras (`expected`, `origin`, …) that
 * must survive the wire; only the universally present fields are pinned.
 */
export const wireValidationIssueSchema = z.looseObject({
  code: z.string(),
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
});

/**
 * The client-visible part of a confirmation challenge (core.md §7). Only
 * these fields may cross the wire — the full server record (input hash,
 * principal key, company, idempotency key) stays in Redis.
 */
export const wireConfirmationChallengeSchema = z.object({
  challengeId: z.string(),
  /** Redacted human-readable summary from `confirmationSummary`. */
  summary: z.string(),
  /** ISO-8601 expiry — five minutes from issuance (core.md §7). */
  expiresAt: z.string(),
});

/**
 * The full §4 oRPC error map. Procedures attach a subset: pipeline-universal
 * codes plus the action's declared domain codes (`procedureErrorDefinitions`).
 * Clients get a discriminated union typed by wire code — no string matching
 * (contract.md §4). Codes without a `data` schema carry no payload beyond
 * `code`/`message`/`status`; `INTERNAL` sends no details on the wire by
 * construction (the server maps it from a fixed generic client message).
 */
export const wireErrorDefinitions = {
  VALIDATION: {
    status: wireErrorStatus.VALIDATION,
    data: z.object({ issues: z.array(wireValidationIssueSchema) }),
  },
  UNAUTHENTICATED: { status: wireErrorStatus.UNAUTHENTICATED },
  PERMISSION_DENIED: { status: wireErrorStatus.PERMISSION_DENIED },
  NOT_FOUND: { status: wireErrorStatus.NOT_FOUND },
  CONFLICT: { status: wireErrorStatus.CONFLICT },
  IDEMPOTENCY_CONFLICT: { status: wireErrorStatus.IDEMPOTENCY_CONFLICT },
  RETRY_IN_PROGRESS: {
    status: wireErrorStatus.RETRY_IN_PROGRESS,
    data: z.object({ retryAfterSec: z.number() }),
  },
  CONFIRMATION_REQUIRED: {
    status: wireErrorStatus.CONFIRMATION_REQUIRED,
    data: z.object({ challenge: wireConfirmationChallengeSchema }),
  },
  RATE_LIMITED: {
    status: wireErrorStatus.RATE_LIMITED,
    data: z.object({ retryAfterSec: z.number() }),
  },
  TIMEOUT: { status: wireErrorStatus.TIMEOUT },
  INTERNAL: { status: wireErrorStatus.INTERNAL },
} as const;

/**
 * §4 codes that are never declared per action: transport `UNAUTHENTICATED`,
 * pipeline gates, and `INTERNAL`. Domain `VALIDATION` / `NOT_FOUND` /
 * `CONFLICT` join a procedure only when the action lists them.
 */
export const pipelineUniversalErrorDefinitions = {
  UNAUTHENTICATED: wireErrorDefinitions.UNAUTHENTICATED,
  PERMISSION_DENIED: wireErrorDefinitions.PERMISSION_DENIED,
  IDEMPOTENCY_CONFLICT: wireErrorDefinitions.IDEMPOTENCY_CONFLICT,
  RETRY_IN_PROGRESS: wireErrorDefinitions.RETRY_IN_PROGRESS,
  CONFIRMATION_REQUIRED: wireErrorDefinitions.CONFIRMATION_REQUIRED,
  RATE_LIMITED: wireErrorDefinitions.RATE_LIMITED,
  TIMEOUT: wireErrorDefinitions.TIMEOUT,
  INTERNAL: wireErrorDefinitions.INTERNAL,
} as const;

export type PipelineUniversalWireErrorCode =
  keyof typeof pipelineUniversalErrorDefinitions;

export type ProcedureErrorDefinitions =
  typeof pipelineUniversalErrorDefinitions &
    Partial<Pick<typeof wireErrorDefinitions, DeclaredErrorCode>>;

/**
 * Error map for one contract procedure: pipeline-universal ∪ `contract.errors`.
 * Shared HTTP statuses stay a oneOf — declaring `CONFLICT` does not drop
 * `CONFIRMATION_REQUIRED` / `IDEMPOTENCY_CONFLICT`.
 */
export function procedureErrorDefinitions(
  declared: readonly DeclaredErrorCode[],
): ProcedureErrorDefinitions {
  return {
    ...pipelineUniversalErrorDefinitions,
    ...(declared.includes("VALIDATION")
      ? { VALIDATION: wireErrorDefinitions.VALIDATION }
      : {}),
    ...(declared.includes("NOT_FOUND")
      ? { NOT_FOUND: wireErrorDefinitions.NOT_FOUND }
      : {}),
    ...(declared.includes("CONFLICT")
      ? { CONFLICT: wireErrorDefinitions.CONFLICT }
      : {}),
  };
}

type WireErrorDefinition = (typeof wireErrorDefinitions)[WireErrorCode];

type WireErrorData<K extends WireErrorCode> =
  "data" extends keyof (typeof wireErrorDefinitions)[K]
    ? z.infer<(typeof wireErrorDefinitions)[K]["data"]>
    : never;

/**
 * Discriminated union of defined wire errors. Narrow by `error.code` —
 * never by matching `message` text (contract.md §4).
 */
export type WireError = {
  [K in WireErrorCode]: [WireErrorData<K>] extends [never]
    ? {
        readonly code: K;
        readonly status: (typeof wireErrorStatus)[K];
        readonly message: string;
      }
    : {
        readonly code: K;
        readonly status: (typeof wireErrorStatus)[K];
        readonly message: string;
        readonly data: WireErrorData<K>;
      };
}[WireErrorCode];

function isWireErrorCode(code: string): code is WireErrorCode {
  return Object.hasOwn(wireErrorStatus, code);
}

function definitionHasData(
  definition: WireErrorDefinition,
): definition is WireErrorDefinition & { readonly data: z.ZodType } {
  return "data" in definition;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * True when `error` is a contract.md §4 wire error. Identify by `code`
 * and HTTP `status` (and typed extras), not `instanceof ORPCError` —
 * Metro can load more than one `@orpc/client` copy, and a 401 then
 * collapses to a network banner. After this guard, `error.code` narrows
 * the extras without matching `message` text.
 */
export function isWireError(error: unknown): error is WireError {
  if (!isObjectRecord(error)) {
    return false;
  }
  const code = error.code;
  if (typeof code !== "string" || !isWireErrorCode(code)) {
    return false;
  }
  if (error.status !== wireErrorStatus[code]) {
    return false;
  }
  if (typeof error.message !== "string") {
    return false;
  }
  const definition = wireErrorDefinitions[code];
  if (definitionHasData(definition)) {
    return definition.data.safeParse(error.data).success;
  }
  return true;
}
