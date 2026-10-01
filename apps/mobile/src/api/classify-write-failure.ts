/**
 * Shared mapping from query-failure kind to a user-facing write banner
 * key. Protocol confirmation stays null — it is handled by
 * `submitWithProtocolConfirmation`, not a banner.
 */
import type { QueryFailureKind } from "./errors";

export type WriteFailureBannerKey = "offline" | "permission" | "error";

export function writeFailureIsSilent(kind: QueryFailureKind | null): boolean {
  return kind === null || kind === "confirmation";
}

export function classifyWriteFailure(
  kind: QueryFailureKind | null,
): WriteFailureBannerKey | null {
  if (writeFailureIsSilent(kind)) {
    return null;
  }
  if (kind === "offline") {
    return "offline";
  }
  if (kind === "permission") {
    return "permission";
  }
  return "error";
}
