/**
 * The banner copy for a failed turn.
 *
 * What used to live here — parsing a JSON `{ code }` out of an `Error.message`,
 * and mapping a query failure — went with the client that threw those. The kit
 * path reports a typed failure instead, and the sheet maps it to one of these
 * kinds before asking for the copy.
 */
import type { AssistantCopy } from "../../../i18n/assistant";
import type { AssistantKitFailure } from "../api/assistant-kit-client";

export type AssistantChatErrorKind =
  | "validation"
  | "network"
  | "offline"
  | "unavailable"
  | "permission"
  | "unauthenticated"
  | "notConfigured"
  | "rateLimited";

export function assistantChatErrorMessage(
  kind: AssistantChatErrorKind,
  copy: AssistantCopy,
): string {
  return copy.errors[kind];
}

/**
 * Which failures are worth a banner, and which are already visible in the thread.
 *
 * `stale`, `unresolvable` and `interaction_open` all came back with the corrected
 * question, which is now on screen — saying so twice reads as an error when the
 * person can see what happened. `action_failed` does get one: the card is still
 * there and nothing about it explains why the tap did not take.
 */
export function bannerKindFor(
  failure: AssistantKitFailure | null,
): AssistantChatErrorKind | null {
  if (failure === null) {
    return null;
  }
  switch (failure.kind) {
    case "stale":
    case "unresolvable":
    case "interaction_open":
    case "aborted":
      return null;
    case "unreachable":
      return "network";
    case "rate_limited":
      return "rateLimited";
    case "unauthorized":
      return "unauthenticated";
    case "rejected":
      return "validation";
    case "expired":
    case "unreadable":
    case "server":
    case "action_failed":
      return "unavailable";
  }
}
