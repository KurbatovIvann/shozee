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

const ROW_MODEL = readFileSync(
  new URL("../document/document-rows.ts", import.meta.url),
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

  /**
   * Every field the row model computes reaches the screen.
   *
   * `failed` was computed, commented ("the reply is absent, not empty") and
   * read by nobody: a turn that broke rendered its cards and said nothing about
   * having broken (SHO-546). That is the same shape as a declared interaction
   * kind with no producer, one layer down, and the same answer applies — the
   * gap between deciding something and using it is closed by a failing test
   * rather than by whoever next reads both files.
   */
  it("renders every field the row model computes", () => {
    const declaration =
      /export type AssistantDocumentRow = \{([^}]*(?:\}[^;][^}]*)*)\};/.exec(
        ROW_MODEL,
      );
    const fields = [
      ...(declaration?.[1] ?? "").matchAll(/readonly (\w+)[?]?:/g),
    ].map((match) => match[1] ?? "");
    // Proof the match spans the whole declaration rather than its first line —
    // a regex that quietly stopped early would make the check below vacuous.
    expect(fields).toEqual(
      expect.arrayContaining([
        "id",
        "role",
        "text",
        "surfaces",
        "interaction",
        "failed",
        "waiting",
      ]),
    );

    const unread = fields.filter((field) => !VIEW.includes(`item.${field}`));
    expect(unread).toEqual([]);
  });

  /**
   * SHO-552. The draft goes back only when the conversation hook says this
   * screen's send was refused. The restore used to decide for itself from a bare
   * failure, outside the tenant guard every other late reply goes through, and
   * after a company switch it put the old company's words in the new composer.
   * Behaviour is asserted in the hook's own suite; this pins that the sheet
   * reads the hook's answer instead of re-deriving it.
   */
  it("restores the draft only on a refusal the hook reports as current", () => {
    expect(SHEET).toContain('outcome.kind === "refused"');
    expect(SHEET).not.toMatch(/\.send\(text\)\.then\(\(failure\)/);
  });

  /**
   * SHO-555. The thread is a window onto a longer conversation. Reaching its top
   * asks for the page before, and a page arriving above must not throw the
   * person back to the bottom — which an unconditional scroll to the end on
   * every size change did. The decision is `assistantThreadFollow`'s, tested on
   * its own; this pins that the screen uses it.
   */
  it("asks for older messages from the top, and stays where the person is reading", () => {
    expect(SHEET).toContain("loadOlder: conversation.loadOlder");
    expect(SHEET).toContain("loadingOlder: conversation.loadingOlder");
    expect(VIEW).toContain("onStartReached={model.loadOlder}");
    expect(VIEW).toContain("onContentSizeChange={followThread}");
    expect(VIEW).toContain("assistantThreadFollow(");
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
