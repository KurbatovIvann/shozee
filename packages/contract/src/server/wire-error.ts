/**
 * Typed core error → wire error (contract.md §4). Two sources exist:
 *
 * 1. Everything the pipeline throws is a §11 core error — `toWireError`
 *    maps it to an `ORPCError` carrying the stable code, the §4 HTTP
 *    status, the `clientMessage` (the only free text allowed on the
 *    wire), and the typed extras (`issues`, `retryAfterSec`,
 *    `challenge`).
 * 2. oRPC itself validates procedure input/output against the contract
 *    schemas. Those failures surface as oRPC's own codes and must be
 *    remapped to the §4 vocabulary — `wireErrorInterceptors` does that
 *    and is mounted on the transport handler (`RPCHandler`) by the API
 *    composition (client interceptors run before oRPC error validation,
 *    so the remapped error is still validated against the defined map).
 */
import {
  ORPCError,
  ValidationError as OrpcValidationError,
} from "@orpc/server";
import type { ActionRisk } from "@showzy/core/contract";
import {
  ConcurrentRetryError,
  ConfirmationRequiredError,
  CoreError,
  RateLimitError,
  ValidationError,
  type CoreErrorCode,
} from "@showzy/core/errors";

import { wireErrorStatus } from "../client/wire-errors.js";

/**
 * Typed extras keyed by wire code. Remaining `CoreError` classes carry
 * none — `clientMessage` is the only serializable text (core.md §11);
 * for `CoreInvariantError` it is the fixed generic string, so INTERNAL
 * sends no details on the wire by construction.
 */
type WireExtras =
  | { readonly issues: ValidationError["issues"] }
  | { readonly retryAfterSec: number }
  | {
      readonly challenge: ConfirmationRequiredError["challenge"] & {
        readonly risk: ActionRisk;
      };
    };

const WIRE_EXTRAS: {
  readonly [Code in CoreErrorCode]?: (
    error: CoreError,
    risk: ActionRisk,
  ) => WireExtras | undefined;
} = {
  VALIDATION: (error) =>
    error instanceof ValidationError ? { issues: error.issues } : undefined,
  RETRY_IN_PROGRESS: (error) =>
    error instanceof ConcurrentRetryError
      ? { retryAfterSec: error.retryAfterSec }
      : undefined,
  CONFIRMATION_REQUIRED: (error, risk) =>
    error instanceof ConfirmationRequiredError
      ? { challenge: { ...error.challenge, risk } }
      : undefined,
  RATE_LIMITED: (error) =>
    error instanceof RateLimitError
      ? { retryAfterSec: error.retryAfterSec }
      : undefined,
};

export function toWireError(
  error: unknown,
  risk: ActionRisk,
): ORPCError<CoreErrorCode, unknown> {
  if (error instanceof CoreError) {
    const extras = WIRE_EXTRAS[error.code]?.(error, risk);
    if (extras !== undefined) {
      return new ORPCError(error.code, {
        status: wireErrorStatus[error.code],
        message: error.clientMessage,
        data: extras,
        cause: error,
      });
    }
    return new ORPCError(error.code, {
      status: wireErrorStatus[error.code],
      message: error.clientMessage,
      cause: error,
    });
  }
  // The pipeline wraps every throw outside the §11 vocabulary as
  // `CoreInvariantError` (core.md §4), so this branch is defense in depth
  // for transport-composition bugs — same wire shape, no details.
  return new ORPCError("INTERNAL", {
    status: wireErrorStatus.INTERNAL,
    message: "Internal error.",
    cause: error,
  });
}

/**
 * Remaps oRPC schema-validation failures onto the §4 vocabulary. Mounted
 * as `clientInterceptors` on the transport handler (fnd-T26); the tests
 * here mount it the same way.
 *
 * - Input validation (`BAD_REQUEST` + oRPC `ValidationError` cause) →
 *   `VALIDATION` 400 with the Zod issues, exactly like a pipeline-level
 *   input failure.
 * - Output validation (`INTERNAL_SERVER_ERROR` + `ValidationError`
 *   cause) means the response drifted from the published contract — a
 *   server bug: `INTERNAL` 500 with no details on the wire, mirroring
 *   the pipeline's own output-mismatch rule (core.md §4).
 *
 * Written as an explicit `async` interceptor (not `onError`) so the
 * return type is `Promise<unknown>`, which is what `RPCHandler`'s
 * `clientInterceptors` slot requires.
 */
export async function remapOrpcSchemaError(options: {
  next: () => Promise<unknown>;
}): Promise<unknown> {
  try {
    return await options.next();
  } catch (error) {
    if (
      error instanceof ORPCError &&
      error.code === "BAD_REQUEST" &&
      error.cause instanceof OrpcValidationError
    ) {
      throw new ORPCError("VALIDATION", {
        status: wireErrorStatus.VALIDATION,
        message: "Input validation failed.",
        data: { issues: error.cause.issues },
        cause: error.cause,
      });
    }
    if (
      error instanceof ORPCError &&
      error.code === "INTERNAL_SERVER_ERROR" &&
      error.cause instanceof OrpcValidationError
    ) {
      throw new ORPCError("INTERNAL", {
        status: wireErrorStatus.INTERNAL,
        message: "Internal error.",
        cause: error.cause,
      });
    }
    throw error;
  }
}

export const wireErrorInterceptors = [remapOrpcSchemaError] as const;
