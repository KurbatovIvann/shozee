import { createHash } from "node:crypto";

/** Empty attached catalog — not a SHA-256 of the empty string. */
export const STAFF_ASSISTANT_EMPTY_TOOLSET_HASH = "empty";

/**
 * Stable short hash of sorted provider tool names plus adapter id.
 * Logs only — never includes schemas or payloads. A provider change
 * invalidates cache assumptions (SHO-508).
 */
export function staffAssistantToolsetHash(
  providerNames: readonly string[],
  adapterId?: string,
): string {
  if (providerNames.length === 0) {
    return STAFF_ASSISTANT_EMPTY_TOOLSET_HASH;
  }
  const names = [...providerNames].sort().join("\n");
  const canonical =
    adapterId === undefined || adapterId === ""
      ? names
      : `${adapterId}\n${names}`;
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
