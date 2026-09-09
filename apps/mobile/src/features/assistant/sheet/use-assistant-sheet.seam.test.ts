/**
 * The screen is on the kit path, and stays there.
 *
 * A source check rather than a behavioural one, because what it guards is a
 * wiring mistake: the old hooks, presenters and clients are still on disk until
 * the next step deletes them, and re-importing one of them would quietly restore
 * the client-side state machine this work removed. That failure would not show up
 * as a red test anywhere else — it would show up on a phone, weeks later, as the
 * same HITL defects.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const SHEET = readFileSync(
  new URL("./use-assistant-sheet.ts", import.meta.url),
  "utf8",
);

const VIEW = readFileSync(
  new URL("./assistant-sheet-view.tsx", import.meta.url),
  "utf8",
);

const ROW = readFileSync(
  new URL("./assistant-message-row.tsx", import.meta.url),
  "utf8",
);

const RETIRED = [
  "use-assistant-chat",
  "use-assistant-choice",
  "use-assistant-confirmation",
  "choice-presenter",
  "confirmation-presenter",
  "resume-envelope",
  "assistant-hydrate",
  "chat-rows",
  "assistant-choice",
  "assistant-pending",
  "choice-card",
];

describe("the assistant sheet's wiring", () => {
  it("reads the stored document and mints no parts of its own", () => {
    expect(SHEET).toContain("useAssistantConversation");
    expect(SHEET).toContain("useAssistantConversationId");
    expect(SHEET).toContain("rows: conversation.rows");
    // No local append: what the thread shows is what the server stored.
    expect(SHEET).not.toContain("appendParts");
    expect(SHEET).not.toContain("partsFromResumeEnvelope");
  });

  it("holds no per-question state", () => {
    for (const gone of [
      "ignoredChallengeIds",
      "dismissedChallengeIds",
      "resolvingChallengeId",
      "attempted",
      "challengeId",
    ]) {
      expect(SHEET.includes(gone)).toBe(false);
    }
  });

  it("imports nothing from the path being replaced", () => {
    for (const module of RETIRED) {
      expect(SHEET.includes(module)).toBe(false);
      expect(VIEW.includes(module)).toBe(false);
      expect(ROW.includes(module)).toBe(false);
    }
  });

  it("offers one answer callback, not one per kind of question", () => {
    expect(VIEW).toContain("readonly answer: (answer: unknown) => void");
    // The declarations, not the words: the header comment names what these
    // replaced, and that sentence is worth keeping.
    for (const field of [
      "readonly selectChoice:",
      "readonly confirm:",
      "readonly confirmationApplying:",
      "readonly choiceApplying:",
      "readonly choiceAttempted:",
      "readonly hasInFlightTools:",
    ]) {
      expect(VIEW.includes(field)).toBe(false);
    }
  });
});
