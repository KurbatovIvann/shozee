import { CONFIRMABLE_RISKS, isConfirmableRisk } from "@showzy/core/contract";
import type { ActionRisk } from "@showzy/core/contract";
import { ASSISTANT_PREVIEW_LEVELS } from "@showzy/validation/assistant-chat";
import { describe, expect, it } from "vitest";

import { assistantPreviewLevel } from "./assistant-kit-confirmation.js";

const EVERY_RISK = [
  "read",
  "draft",
  "write",
  "high",
] as const satisfies readonly ActionRisk[];

describe("assistantPreviewLevel", () => {
  it("gives every confirmable risk a level, so the write pauses", () => {
    expect(CONFIRMABLE_RISKS.length).toBeGreaterThan(0);
    for (const risk of CONFIRMABLE_RISKS) {
      const level = assistantPreviewLevel(risk);
      expect(level).toBeDefined();
      expect(ASSISTANT_PREVIEW_LEVELS).toContain(level);
    }
  });

  it("gives no level to a risk core never confirms", () => {
    const unconfirmable = EVERY_RISK.filter((risk) => !isConfirmableRisk(risk));
    expect(unconfirmable).not.toHaveLength(0);
    for (const risk of unconfirmable) {
      expect(assistantPreviewLevel(risk)).toBeUndefined();
    }
  });

  it("asks harder for a high-risk write than for an ordinary one", () => {
    expect(assistantPreviewLevel("write")).toBe("card");
    expect(assistantPreviewLevel("high")).toBe("strong");
  });
});
