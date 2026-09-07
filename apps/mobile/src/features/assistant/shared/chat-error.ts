/**
 * Map SSE-mount HTTP failures onto assistant copy. DefaultChatTransport
 * throws `Error` with the JSON body text; fetch failures are TypeError
 * or `Failed to fetch`. Never log cookies or OTP.
 */
import type { QueryFailureKind } from "../../../api/errors";
import type { AssistantCopy } from "../../../i18n/assistant";

export type AssistantChatErrorKind =
  | "validation"
  | "network"
  | "offline"
  | "unavailable"
  | "permission"
  | "unauthenticated"
  | "notConfigured"
  | "rateLimited";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSseNetworkTransportError(error: Error): boolean {
  return error instanceof TypeError || error.message === "Failed to fetch";
}

export function assistantChatErrorKind(error: unknown): AssistantChatErrorKind {
  if (!(error instanceof Error)) {
    return "unavailable";
  }
  if (isSseNetworkTransportError(error)) {
    return "network";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(error.message);
  } catch {
    return "unavailable";
  }
  if (!isRecord(parsed) || typeof parsed.code !== "string") {
    return "unavailable";
  }
  switch (parsed.code) {
    case "VALIDATION":
      return "validation";
    case "UNAUTHENTICATED":
      return "unauthenticated";
    case "PERMISSION_DENIED":
      return "permission";
    case "ASSISTANT_NOT_CONFIGURED":
      return "notConfigured";
    case "RATE_LIMITED":
      return "rateLimited";
    default:
      return "unavailable";
  }
}

export function queryFailureToAssistantKind(
  kind: QueryFailureKind,
): AssistantChatErrorKind {
  switch (kind) {
    case "validation":
    case "network":
    case "offline":
    case "permission":
    case "unauthenticated":
      return kind;
    case "rate_limited":
      return "rateLimited";
    default:
      return "unavailable";
  }
}

export function assistantChatErrorMessage(
  kind: AssistantChatErrorKind,
  copy: AssistantCopy,
): string {
  return copy.errors[kind];
}
