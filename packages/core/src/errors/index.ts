/**
 * `@showzy/core/errors` — the only error vocabulary for domain code
 * (core.md §11). Never `throw new Error("...")` in handlers or services.
 *
 * Every class carries a stable `code` that the contract layer maps to an
 * HTTP status and wire shape (contract.md §4), and a `clientMessage` — the
 * only free-text string that may reach a client. `Error#message` is the
 * log-facing message: it defaults to the client message and is replaced by
 * `internalMessage` when the thrower needs diagnostics (IDs, tenant scope,
 * upstream failures) that must stay in logs. The contract layer serializes
 * only `code`, `clientMessage`, and the typed extras (`issues`,
 * `retryAfterSec`, `challenge`).
 */
import type { z } from "zod";

/**
 * Stable wire codes — exactly the contract.md §4 table. Renaming one is a
 * breaking client API change and goes through spec rework, never a casual
 * refactor. The error-code pinning test enforces this.
 */
export type CoreErrorCode =
  | "VALIDATION"
  | "PERMISSION_DENIED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "RETRY_IN_PROGRESS"
  | "CONFIRMATION_REQUIRED"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "INTERNAL";

export interface CoreErrorOptions {
  /** Chained underlying error; reaches logs/Sentry, never a client. */
  readonly cause?: unknown;
  /**
   * Log-only diagnostic detail. When present it becomes `Error#message`
   * in place of the client message, so loggers get the full story while
   * the contract layer keeps serializing `clientMessage` only.
   */
  readonly internalMessage?: string;
}

export abstract class CoreError extends Error {
  /** Stable wire code for the contract layer (contract.md §4). */
  readonly code: CoreErrorCode;
  /** The only free-text string the contract layer may put on the wire. */
  readonly clientMessage: string;

  protected constructor(
    code: CoreErrorCode,
    clientMessage: string,
    options: CoreErrorOptions = {},
  ) {
    super(
      options.internalMessage ?? clientMessage,
      options.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.code = code;
    this.clientMessage = clientMessage;
    this.name = new.target.name;
  }
}

/**
 * Input failed the action's Zod schema (pipeline step 1) or a protocol
 * requirement expressible as input shape (e.g. a missing idempotency key
 * on an idempotent mutation, core.md §5). Issues are client-safe: they
 * describe the submitted shape, never server state.
 */
export class ValidationError extends CoreError {
  readonly issues: readonly z.core.$ZodIssue[];

  constructor(
    issues: readonly z.core.$ZodIssue[],
    clientMessage = "Input validation failed.",
    options?: CoreErrorOptions,
  ) {
    super("VALIDATION", clientMessage, options);
    this.issues = issues;
  }
}

/** The verified principal lacks the permission or membership (core.md §3). */
export class PermissionDeniedError extends CoreError {
  constructor(
    clientMessage = "You do not have permission to perform this action.",
    options?: CoreErrorOptions,
  ) {
    super("PERMISSION_DENIED", clientMessage, options);
  }
}

/**
 * The resource does not exist — or exists but belongs to another tenant or
 * is not visible to this principal. Cross-tenant and ownership denials use
 * this class, never `PermissionDeniedError`, so existence is not leaked
 * (core.md §2, resolveTarget).
 */
export class NotFoundError extends CoreError {
  constructor(
    clientMessage = "The requested resource was not found.",
    options?: CoreErrorOptions,
  ) {
    super("NOT_FOUND", clientMessage, options);
  }
}

/**
 * A domain state conflict, e.g. an invalid status transition. The message
 * is required: "Conflict." helps nobody, and the domain action knows the
 * client-safe reason ("Order is already confirmed.").
 */
export class ConflictError extends CoreError {
  constructor(clientMessage: string, options?: CoreErrorOptions) {
    super("CONFLICT", clientMessage, options);
  }
}

/** Same idempotency key, different request payload (core.md §5). */
export class IdempotencyConflictError extends CoreError {
  constructor(
    clientMessage = "This request was already submitted with different content.",
    options?: CoreErrorOptions,
  ) {
    super("IDEMPOTENCY_CONFLICT", clientMessage, options);
  }
}

/** A previous attempt with the same idempotency key is still running. */
export class ConcurrentRetryError extends CoreError {
  /** Serialized as the wire retry-after hint (contract.md §4). */
  readonly retryAfterSec: number;

  constructor(
    retryAfterSec: number,
    clientMessage = "A previous attempt of this request is still in progress. Retry shortly.",
    options?: CoreErrorOptions,
  ) {
    super("RETRY_IN_PROGRESS", clientMessage, options);
    this.retryAfterSec = retryAfterSec;
  }
}

/**
 * The client-visible part of a confirmation challenge (core.md §7). The
 * full server record (input hash, principal key, company, idempotency key)
 * stays in Redis; only these fields may cross the wire.
 */
export interface ActionPreviewLine {
  readonly label: string;
  readonly value: string;
}

export interface ActionPreview {
  readonly title: string;
  readonly lines: readonly ActionPreviewLine[];
  readonly notes?: readonly string[];
}

export interface ConfirmationChallenge {
  readonly challengeId: string;
  /** Redacted human-readable summary from `confirmationSummary`. */
  readonly summary: string;
  /** ISO-8601 expiry — five minutes from issuance (core.md §7). */
  readonly expiresAt: string;
  readonly preview?: ActionPreview;
}

/**
 * First invocation of a `requiresConfirmation` action: not a failure but a
 * stop — the client re-invokes with the challenge to execute (core.md §7).
 */
export class ConfirmationRequiredError extends CoreError {
  readonly challenge: ConfirmationChallenge;

  constructor(
    challenge: ConfirmationChallenge,
    clientMessage = "This action requires explicit confirmation.",
    options?: CoreErrorOptions,
  ) {
    super("CONFIRMATION_REQUIRED", clientMessage, options);
    this.challenge = challenge;
  }
}

/** The principal-scoped token bucket is exhausted (core.md §10). */
export class RateLimitError extends CoreError {
  /** Serialized as the wire retry-after hint (contract.md §4). */
  readonly retryAfterSec: number;

  constructor(
    retryAfterSec: number,
    clientMessage = "Too many requests. Retry later.",
    options?: CoreErrorOptions,
  ) {
    super("RATE_LIMITED", clientMessage, options);
    this.retryAfterSec = retryAfterSec;
  }
}

/** The whole-pipeline deadline (`timeout` metadata) was exceeded. */
export class TimeoutError extends CoreError {
  constructor(
    clientMessage = "The action did not complete in time.",
    options?: CoreErrorOptions,
  ) {
    super("TIMEOUT", clientMessage, options);
  }
}

/**
 * A server bug: tenant leak, call cycle, output-schema mismatch. Alerts
 * fire; the description is for logs/Sentry only — `clientMessage` is a
 * fixed generic string and the contract layer sends no details on the wire
 * (contract.md §4: `INTERNAL`).
 */
export class CoreInvariantError extends CoreError {
  constructor(internalMessage: string, options?: { readonly cause?: unknown }) {
    super(
      "INTERNAL",
      "Internal error.",
      options?.cause !== undefined
        ? { internalMessage, cause: options.cause }
        : { internalMessage },
    );
  }
}
