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
  | "rateLimited"
  | "turnBusy"
  | "questionOpen";

export function assistantChatErrorMessage(
  kind: AssistantChatErrorKind,
  copy: AssistantCopy,
): string {
  return copy.errors[kind];
}

/**
 * Which failures are worth a banner, and which are already visible in the thread.
 *
 * The test for silence is whether the screen changed in a way that explains
 * itself. Two refusals once shared a branch on the grounds that "the corrected
 * question is on screen", and that was only true of one of them (SHO-550).
 * `action_failed` gets a banner for the same reason: the card is still there
 * and nothing about it explains why the tap did not take.
 */
export function bannerKindFor(
  failure: AssistantKitFailure | null,
): AssistantChatErrorKind | null {
  if (failure === null) {
    return null;
  }
  switch (failure.kind) {
    // Refusals of an answer. The card re-renders as the question now stands,
    // and that change is the explanation — a banner on top reads as a fault.
    case "stale":
    case "unresolvable":
      return null;
    // A refusal of a send. Nothing on screen changes, since the card was
    // already there, and the draft goes back into the field — so without a
    // line saying why, the tap looks as though it did nothing at all.
    case "interaction_open":
      return "questionOpen";
    // Nothing went out: a tap while another command was in flight, or blank
    // text. The thread is unchanged and the draft is back where it was, which
    // is an accurate picture of what happened. Nothing to explain.
    //
    // There is no longer a case where something went out and this phone stopped
    // listening — the turn runs off the request, so a closed connection ends
    // nothing (ADR-0039).
    case "not_sent":
      return null;
    // Nothing on screen explains this one: the turn holding the conversation
    // is running on another device, so the thread looks idle.
    case "turn_open":
      return "turnBusy";
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
