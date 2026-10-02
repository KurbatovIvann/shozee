/**
 * Contract.md §4 error union plus query-failure kinds screens map later.
 * Callers narrow on `error.code` / `kind` — never by matching `message` text.
 */
import { onlineManager } from "@tanstack/react-query";
import {
  isWireError,
  type WireActionPreview,
  type WireActionRisk,
  type WireError,
  type WireErrorCode,
} from "@showzy/contract";

/** Contract client is null — not a network failure. */
export class ClientUnavailableError extends Error {
  constructor() {
    super("client unavailable");
    this.name = "ClientUnavailableError";
  }
}

/** Programmer invariant (e.g. upload handshake missing a required step). */
export class InternalInvariantError extends Error {
  constructor(message = "internal invariant") {
    super(message);
    this.name = "InternalInvariantError";
  }
}

/** Non-2xx HTTP status from a raw fetch/PUT (not an oRPC wire error). */
export class HttpStatusError extends Error {
  readonly status: number;

  constructor(status: number) {
    super("http status");
    this.name = "HttpStatusError";
    this.status = status;
  }
}

export function requireReadyClient<T>(client: T | null): T {
  if (client === null) {
    throw new ClientUnavailableError();
  }
  return client;
}

export function isClientUnavailableError(
  error: unknown,
): error is ClientUnavailableError {
  return error instanceof ClientUnavailableError;
}

export function isInternalInvariantError(
  error: unknown,
): error is InternalInvariantError {
  return error instanceof InternalInvariantError;
}

export function isHttpStatusError(error: unknown): error is HttpStatusError {
  return error instanceof HttpStatusError;
}

export function queryFailureKindFromHttpStatus(
  status: number,
): QueryFailureKind {
  if (status === 401) {
    return "unauthenticated";
  }
  if (status === 403) {
    return "permission";
  }
  if (status === 404) {
    return "not_found";
  }
  if (status === 409) {
    return "conflict";
  }
  if (status === 429) {
    return "rate_limited";
  }
  if (status === 400 || status === 422) {
    return "validation";
  }
  if (status === 408 || status === 504) {
    return "timeout";
  }
  if (status >= 500 && status <= 599) {
    return "internal";
  }
  return "network";
}

export type WireErrorView = {
  readonly code: WireErrorCode;
  readonly message: string;
  readonly retryAfterSec?: number;
  readonly challengeId?: string;
  readonly summary?: string;
  readonly risk?: WireActionRisk;
  readonly preview?: WireActionPreview;
};

export type QueryFailureKind =
  | "validation"
  | "unauthenticated"
  | "permission"
  | "not_found"
  | "conflict"
  | "confirmation"
  | "rate_limited"
  | "timeout"
  | "internal"
  | "network"
  | "offline";

export type QueryFailure = {
  readonly kind: QueryFailureKind;
  readonly message: string;
  readonly retryAfterSec?: number;
  readonly challengeId?: string;
  readonly summary?: string;
  readonly risk?: WireActionRisk;
  readonly preview?: WireActionPreview;
};

export function describeWireError(error: unknown): WireErrorView | null {
  if (!isWireError(error)) {
    return null;
  }
  return viewFor(error);
}

export function describeQueryFailure(
  error: unknown,
  options: { readonly online?: boolean } = {},
): QueryFailure {
  const view = describeWireError(error);
  if (view !== null) {
    return {
      kind: kindForWireCode(view.code),
      message: view.message,
      ...(view.retryAfterSec === undefined
        ? {}
        : { retryAfterSec: view.retryAfterSec }),
      ...(view.challengeId === undefined
        ? {}
        : { challengeId: view.challengeId }),
      ...(view.summary === undefined ? {} : { summary: view.summary }),
      ...(view.risk === undefined ? {} : { risk: view.risk }),
      ...(view.preview === undefined ? {} : { preview: view.preview }),
    };
  }
  if (isClientUnavailableError(error) || isInternalInvariantError(error)) {
    return { kind: "internal", message: error.message };
  }
  if (isHttpStatusError(error)) {
    return {
      kind: queryFailureKindFromHttpStatus(error.status),
      message: "http",
    };
  }
  const online = options.online ?? onlineManager.isOnline();
  return online
    ? { kind: "network", message: "network" }
    : { kind: "offline", message: "offline" };
}

function kindForWireCode(code: WireErrorCode): QueryFailureKind {
  switch (code) {
    case "VALIDATION":
      return "validation";
    case "UNAUTHENTICATED":
      return "unauthenticated";
    case "PERMISSION_DENIED":
      return "permission";
    case "NOT_FOUND":
      return "not_found";
    case "CONFLICT":
    case "IDEMPOTENCY_CONFLICT":
    case "RETRY_IN_PROGRESS":
      return "conflict";
    case "CONFIRMATION_REQUIRED":
      return "confirmation";
    case "RATE_LIMITED":
      return "rate_limited";
    case "TIMEOUT":
      return "timeout";
    case "INTERNAL":
      return "internal";
  }
}

function viewFor(error: WireError): WireErrorView {
  switch (error.code) {
    case "RATE_LIMITED":
    case "RETRY_IN_PROGRESS":
      return {
        code: error.code,
        message: error.message,
        retryAfterSec: error.data.retryAfterSec,
      };
    case "CONFIRMATION_REQUIRED":
      return {
        code: error.code,
        message: error.message,
        challengeId: error.data.challenge.challengeId,
        summary: error.data.challenge.summary,
        risk: error.data.challenge.risk,
        ...(error.data.challenge.preview === undefined
          ? {}
          : { preview: error.data.challenge.preview }),
      };
    case "VALIDATION":
    case "UNAUTHENTICATED":
    case "PERMISSION_DENIED":
    case "NOT_FOUND":
    case "CONFLICT":
    case "IDEMPOTENCY_CONFLICT":
    case "TIMEOUT":
    case "INTERNAL":
      return { code: error.code, message: error.message };
  }
}
