import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  assistantComposerSendVisible,
  assistantExampleChips,
  assistantReplyTone,
  assistantShozikPose,
  SHOZIK_EMPTY_POSE_SIZE,
  SHOZIK_HEADER_POSE_SIZE,
  SHOZIK_WAIT_POSE_SIZE,
} from "./assistant-chrome";
import * as sharedAssistantCopy from "@showzy/copy/assistant";

import { assistantCopy } from "../../../i18n/assistant";
import * as mobileAssistantCopy from "../../../i18n/assistant";

const sheetView = readFileSync(
  new URL("./assistant-sheet-view.tsx", import.meta.url),
  "utf8",
);
const composer = readFileSync(
  new URL("./assistant-composer.tsx", import.meta.url),
  "utf8",
);
const poseMark = readFileSync(
  new URL("./shozik-pose-mark.tsx", import.meta.url),
  "utf8",
);
const surfaceCard = readFileSync(
  new URL("./assistant-surface-card.tsx", import.meta.url),
  "utf8",
);
const collectionBlock = readFileSync(
  new URL("./assistant-collection-block.tsx", import.meta.url),
  "utf8",
);
const aggregateCard = readFileSync(
  new URL("./orders-aggregate-result-card.tsx", import.meta.url),
  "utf8",
);
const aggregateBlock = readFileSync(
  new URL("./assistant-aggregate-block.tsx", import.meta.url),
  "utf8",
);
const entityCard = readFileSync(
  new URL("./order-entity-card.tsx", import.meta.url),
  "utf8",
);

describe("assistantShozikPose", () => {
  it("sits when idle and digs while a request is in flight", () => {
    expect(assistantShozikPose({ thinking: false })).toBe("sit");
    expect(assistantShozikPose({ thinking: true })).toBe("dig");
  });
});

describe("assistantComposerSendVisible", () => {
  it("hides send when the field is empty or whitespace", () => {
    expect(assistantComposerSendVisible("")).toBe(false);
    expect(assistantComposerSendVisible("   ")).toBe(false);
  });

  it("shows send when there is text", () => {
    expect(assistantComposerSendVisible("покажи замовлення")).toBe(true);
  });
});

describe("assistant conversation chrome (SHO-392)", () => {
  it("puts local sit/dig in the header and first-run empty, not Sparkles", () => {
    expect(sheetView).toContain("ShozikPoseMark");
    expect(sheetView).toContain("assistantShozikPose");
    expect(sheetView).toContain("SHOZIK_HEADER_POSE_SIZE");
    expect(sheetView).toContain("SHOZIK_EMPTY_POSE_SIZE");
    expect(sheetView).toContain('pose="sit"');
    expect(sheetView).not.toContain("SparklesIcon");
    expect(sheetView).not.toContain("listen.svg");
    expect(poseMark).toContain("sit.svg");
    expect(poseMark).toContain("dig.svg");
    expect(poseMark).not.toContain("listen.svg");
    expect(poseMark).not.toContain("magicpatterns");
    expect(SHOZIK_HEADER_POSE_SIZE).toBe(40);
    expect(SHOZIK_EMPTY_POSE_SIZE).toBe(72);
  });

  it("hides the send control until there is text", () => {
    expect(composer).toContain("assistantComposerSendVisible");
    expect(composer).toContain("showSend ?");
    expect(composer).not.toContain("MicIcon");
    expect(composer).not.toContain("AudioLinesIcon");
  });

  it("keeps the i18n module a re-export of the shared namespace", () => {
    expect(Object.keys(mobileAssistantCopy)).toEqual(["assistantCopy"]);
    expect(mobileAssistantCopy.assistantCopy).toBe(
      sharedAssistantCopy.assistantCopy,
    );
  });

  it("does not put Shozik assets on SHO-383 result cards", () => {
    expect(surfaceCard).not.toContain("sit.svg");
    expect(surfaceCard).not.toContain("dig.svg");
    expect(collectionBlock).not.toContain("sit.svg");
    expect(collectionBlock).not.toContain("dig.svg");
    expect(aggregateCard).not.toContain("sit.svg");
    expect(aggregateCard).not.toContain("dig.svg");
    expect(aggregateBlock).not.toContain("sit.svg");
    expect(aggregateBlock).not.toContain("dig.svg");
    expect(entityCard).not.toContain("sit.svg");
    expect(entityCard).not.toContain("dig.svg");
  });
});

describe("assistant wait-state chrome (SHO-394)", () => {
  const waitLine = readFileSync(
    new URL("./assistant-wait-line.tsx", import.meta.url),
    "utf8",
  );
  const messageRow = readFileSync(
    new URL("./assistant-message-row.tsx", import.meta.url),
    "utf8",
  );

  it("replaces the leftover spinner and in-thread job timeline with one wait line", () => {
    expect(sheetView).not.toContain("ActivityIndicator");
    expect(sheetView).not.toContain("ListFooterComponent");
    expect(sheetView).not.toContain("AssistantTimeline");
    expect(messageRow).not.toContain("AssistantTimeline");
    expect(messageRow).toContain("AssistantWaitLine");
    expect(waitLine).toContain("accessibilityLiveRegion");
    expect(waitLine).toContain("polite");
    expect(waitLine).not.toContain("ActivityIndicator");
    expect(waitLine).not.toContain("job-labels");
  });

  it("renders the wait line as a chip with the dig pose on the left", () => {
    expect(messageRow).not.toContain("sit.svg");
    expect(messageRow).not.toContain("dig.svg");
    expect(messageRow).not.toContain("ShozikPoseMark");
    expect(waitLine).toContain("ShozikPoseMark");
    expect(waitLine).toContain('pose="dig"');
    expect(waitLine).toContain("SHOZIK_WAIT_POSE_SIZE");
    expect(SHOZIK_WAIT_POSE_SIZE).toBe(32);
    expect(waitLine).toContain("accentSoft");
    expect(waitLine).toContain('flexDirection: "row"');
    expect(waitLine).not.toContain("sit.svg");
    expect(waitLine).not.toContain("ActivityIndicator");
  });

  /**
   * There is no wait-gating question left to answer. The stored log holds
   * only settled messages, so the wait row is appended while a request is in
   * flight and hides nothing — the old path had to suppress a half-streamed
   * assistant message, and decide whether an open HITL card counted as "still
   * working".
   */
  it("takes the wait row from the thread reader, not from thread-wide pending", () => {
    const hook = readFileSync(
      new URL("./use-assistant-sheet.ts", import.meta.url),
      "utf8",
    );
    expect(hook).toContain("rows: conversation.rows");
    expect(hook.includes("assistantTurnIsWaiting")).toBe(false);
    expect(hook.includes("pendingConfirmation")).toBe(false);
  });
});

describe("assistantExampleChips", () => {
  it("keys each chip by its own text so a tap can send it", () => {
    expect(
      assistantExampleChips({
        examples: ["Замовлення за сьогодні", "Список клієнтів"],
        busy: false,
      }),
    ).toEqual([
      { key: "Замовлення за сьогодні", text: "Замовлення за сьогодні" },
      { key: "Список клієнтів", text: "Список клієнтів" },
    ]);
  });

  it("drops blanks and repeats rather than duplicating a key", () => {
    expect(
      assistantExampleChips({
        examples: ["Виторг", "  ", " Виторг ", ""],
        busy: false,
      }),
    ).toEqual([{ key: "Виторг", text: "Виторг" }]);
  });

  it("offers nothing while a turn is in flight", () => {
    expect(assistantExampleChips({ examples: ["Виторг"], busy: true })).toEqual(
      [],
    );
  });
});

describe("assistantReplyTone", () => {
  it("leaves an ordinary reply untoned", () => {
    expect(assistantReplyTone({ failed: false, hasOpenQuestion: false })).toBe(
      "reply",
    );
  });

  it("marks a reply that still carries an open question as clarify", () => {
    expect(assistantReplyTone({ failed: false, hasOpenQuestion: true })).toBe(
      "clarify",
    );
  });

  it("prefers error over clarify when the turn itself failed", () => {
    expect(assistantReplyTone({ failed: true, hasOpenQuestion: false })).toBe(
      "error",
    );
    expect(assistantReplyTone({ failed: true, hasOpenQuestion: true })).toBe(
      "error",
    );
  });
});

describe("assistant example chips and reply tones (SHO-748)", () => {
  const chips = readFileSync(
    new URL("./assistant-example-chips.tsx", import.meta.url),
    "utf8",
  );
  const messageRow = readFileSync(
    new URL("./assistant-message-row.tsx", import.meta.url),
    "utf8",
  );
  const hook = readFileSync(
    new URL("./use-assistant-sheet.ts", import.meta.url),
    "utf8",
  );

  const actionChip = readFileSync(
    new URL("../../../components/ui/action-chip.tsx", import.meta.url),
    "utf8",
  );

  it("sends the chip's own text on tap, from the empty state and the composer", () => {
    expect(chips).toContain("props.onSend(chip.text)");
    expect(chips).toContain("<ActionChip");
    expect(sheetView).toContain('layout="wrap"');
    expect(sheetView).toContain("model.sendExample");
    expect(composer).toContain('layout="scroll"');
    expect(composer).toContain("props.onSendExample");
    expect(hook).toContain("sendExample,");
  });

  it("leaves a typed draft alone when a chip is tapped", () => {
    const composerSend = hook.slice(
      hook.indexOf("const send = useCallback("),
      hook.indexOf("const sendExample = useCallback("),
    );
    const chipSend = hook.slice(
      hook.indexOf("const sendExample = useCallback("),
      hook.indexOf("const openHref = useCallback("),
    );
    expect(composerSend).toContain('setInput("")');
    expect(chipSend).toContain("void conversation.send(text)");
    expect(chipSend).not.toContain("setInput");
  });

  it("gives the shared chip capsule a full hit target", () => {
    expect(actionChip).toContain("minHeight: theme.hitTarget.min");
    expect(actionChip).toContain('justifyContent: "center"');
    expect(chips).toContain('accessibilityRole="list"');
    expect(chips).toContain("accessible={false}");
  });

  it("takes the chip text from the copy namespace in both locales", () => {
    const uk = assistantCopy("uk");
    const en = assistantCopy("en");
    expect(uk.examples).toHaveLength(4);
    expect(en.examples).toHaveLength(4);
    expect(uk.examples).not.toEqual(en.examples);
    expect(uk.examplesLabel.length).toBeGreaterThan(0);
    expect(en.examplesLabel.length).toBeGreaterThan(0);
  });

  it("draws the chip and the clarify/error tones from theme tokens", () => {
    expect(chips).not.toMatch(/#[0-9a-fA-F]{3}/);
    expect(messageRow).not.toMatch(/#[0-9a-fA-F]{3}/);
    expect(messageRow).toContain("assistantReplyTone");
    expect(messageRow).toContain("theme.colors.warning");
    expect(messageRow).toContain("theme.colors.destructive");
    expect(messageRow).toContain("theme.colors.destructiveSoft");
  });
});
