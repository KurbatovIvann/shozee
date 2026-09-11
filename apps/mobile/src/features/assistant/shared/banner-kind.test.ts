/**
 * Which failures reach the banner.
 *
 * Silence is pinned per reason, not as one group. The group this replaced held
 * `interaction_open` beside `stale` on the grounds that the corrected question
 * was already on screen — true when answering, false when sending, where the
 * card does not change and the draft bounces back with nothing said (SHO-550).
 */
import { describe, expect, it } from "vitest";

import { assistantCopy } from "../../../i18n/assistant";
import type { AssistantKitFailureKind } from "../api/assistant-kit-client";
import { assistantChatErrorMessage, bannerKindFor } from "../shared/chat-error";

/**
 * Every failure the client can report. A `Record` rather than a list, so a kind
 * added to the union and not here fails to compile — the hand-written list this
 * replaced had quietly missed `turn_open`.
 */
const ALL = Object.keys({
  unreachable: true,
  unreadable: true,
  unauthorized: true,
  expired: true,
  rejected: true,
  server: true,
  rate_limited: true,
  aborted: true,
  interaction_open: true,
  turn_open: true,
  stale: true,
  unresolvable: true,
  action_failed: true,
} satisfies Record<AssistantKitFailureKind, true>) as AssistantKitFailureKind[];

describe("bannerKindFor", () => {
  it("says nothing when an answer came back with the question as it now stands", () => {
    for (const kind of ["stale", "unresolvable"] as const) {
      expect(bannerKindFor({ kind })).toBeNull();
    }
  });

  it("says why a send was refused while a question is open", () => {
    expect(bannerKindFor({ kind: "interaction_open" })).toBe("questionOpen");
  });

  it("says nothing when nothing went out", () => {
    expect(bannerKindFor({ kind: "aborted" })).toBeNull();
  });

  it("names a refused write, because the card alone does not explain it", () => {
    expect(bannerKindFor({ kind: "action_failed" })).toBe("unavailable");
  });

  it("names a turn running elsewhere, because the thread looks idle", () => {
    expect(bannerKindFor({ kind: "turn_open" })).toBe("turnBusy");
  });

  it("names the spend ceiling as its own thing, not a fault", () => {
    expect(bannerKindFor({ kind: "rate_limited" })).toBe("rateLimited");
  });

  it("distinguishes a lost connection from a refused request", () => {
    expect(bannerKindFor({ kind: "unreachable" })).toBe("network");
    expect(bannerKindFor({ kind: "unauthorized" })).toBe("unauthenticated");
    expect(bannerKindFor({ kind: "rejected" })).toBe("validation");
  });

  it("has copy in both languages for every banner it can raise", () => {
    expect(bannerKindFor(null)).toBeNull();
    for (const locale of ["uk", "en"] as const) {
      const copy = assistantCopy(locale);
      for (const kind of ALL) {
        const banner = bannerKindFor({ kind });
        if (banner !== null) {
          expect(assistantChatErrorMessage(banner, copy), kind).not.toBe("");
        }
      }
    }
  });
});
