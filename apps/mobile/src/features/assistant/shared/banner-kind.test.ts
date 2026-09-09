/**
 * Which failures reach the banner.
 *
 * The half worth pinning is the silence: `stale`, `unresolvable` and
 * `interaction_open` all came back with the corrected question, which is already
 * on screen. A banner there tells the person something is broken when what
 * actually happened is visible in front of them.
 */
import { describe, expect, it } from "vitest";

import type { AssistantKitFailureKind } from "../api/assistant-kit-client";
import { bannerKindFor } from "../shared/chat-error";

const ALL: readonly AssistantKitFailureKind[] = [
  "unreachable",
  "unreadable",
  "unauthorized",
  "expired",
  "rejected",
  "server",
  "aborted",
  "interaction_open",
  "stale",
  "unresolvable",
  "action_failed",
];

describe("bannerKindFor", () => {
  it("says nothing when the thread already shows what happened", () => {
    for (const kind of [
      "stale",
      "unresolvable",
      "interaction_open",
      "aborted",
    ] as const) {
      expect(bannerKindFor({ kind })).toBeNull();
    }
  });

  it("names a refused write, because the card alone does not explain it", () => {
    expect(bannerKindFor({ kind: "action_failed" })).toBe("unavailable");
  });

  it("distinguishes a lost connection from a refused request", () => {
    expect(bannerKindFor({ kind: "unreachable" })).toBe("network");
    expect(bannerKindFor({ kind: "unauthorized" })).toBe("unauthenticated");
    expect(bannerKindFor({ kind: "rejected" })).toBe("validation");
  });

  it("has an answer for every failure the client can report", () => {
    for (const kind of ALL) {
      expect(() => bannerKindFor({ kind })).not.toThrow();
    }
    expect(bannerKindFor(null)).toBeNull();
  });
});
