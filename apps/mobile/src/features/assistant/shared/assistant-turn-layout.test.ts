import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ASSISTANT_TURN_COLUMN_WIDTH,
  assistantTurnColumnLayout,
  assistantTurnResultStretch,
} from "./assistant-turn-layout";

const ROW = readFileSync(
  new URL("../sheet/assistant-message-row.tsx", import.meta.url),
  "utf8",
);
const SURFACE = readFileSync(
  new URL("../sheet/assistant-surface-card.tsx", import.meta.url),
  "utf8",
);
const COLLECTION = readFileSync(
  new URL("../sheet/assistant-collection-block.tsx", import.meta.url),
  "utf8",
);
const AGGREGATE = readFileSync(
  new URL("../sheet/orders-aggregate-result-card.tsx", import.meta.url),
  "utf8",
);
const AGGREGATE_BLOCK = readFileSync(
  new URL("../sheet/assistant-aggregate-block.tsx", import.meta.url),
  "utf8",
);
const CONFIRMATION = readFileSync(
  new URL("../sheet/confirmation-card.tsx", import.meta.url),
  "utf8",
);
const FRAME = readFileSync(
  new URL("../sheet/assistant-result-frame.tsx", import.meta.url),
  "utf8",
);

describe("assistantTurnColumnLayout", () => {
  it("gives the assistant column a definite width, not maxWidth-only shrink-wrap", () => {
    expect(ASSISTANT_TURN_COLUMN_WIDTH).toBe("92%");
    expect(assistantTurnColumnLayout.width).toBe("92%");
    expect(assistantTurnColumnLayout.alignItems).toBe("flex-start");
    expect("maxWidth" in assistantTurnColumnLayout).toBe(false);
  });

  it("stretches result Cards so nested flex:1 rows have a bounded parent", () => {
    expect(assistantTurnResultStretch.alignSelf).toBe("stretch");
    expect(assistantTurnResultStretch.width).toBe("100%");
    expect(assistantTurnResultStretch.minWidth).toBe(0);
  });
});

describe("assistant turn layout composition", () => {
  it("wraps a two-line model sentence above a list card without shrinking the column", () => {
    expect(ROW).toContain("assistantTurnColumnLayout");
    expect(ROW).toContain("assistantTurnResultStretch");
    expect(assistantTurnColumnLayout.width).toBe("92%");
    expect(ROW).toContain('maxWidth: "100%"');
    expect(ROW).not.toMatch(/assistantBubble[\s\S]{0,400}numberOfLines/);
    const textIndex = ROW.indexOf("{props.text}");
    const markdownIndex = ROW.indexOf("<AssistantMarkdownView");
    const cardIndex = ROW.indexOf("<AssistantSurfaceCard");
    expect(textIndex).toBeGreaterThan(0);
    expect(markdownIndex).toBeGreaterThan(textIndex);
    expect(cardIndex).toBeGreaterThan(markdownIndex);
    expect(ROW).toContain("AssistantMarkdownView");
  });

  it("applies the extracted column and stretch styles to every result Card", () => {
    expect(ROW).toContain("assistantTurnColumnLayout");
    expect(ROW).toContain("assistantTurnResultStretch");
    expect(ROW).not.toContain('maxWidth: "92%"');
    expect(ROW.match(/<AssistantTurnResult/g)?.length).toBe(3);
    expect(ROW).toContain("styles.resultStretch");
    expect(ROW).toContain("AssistantWaitLine");
    expect(ROW).not.toContain("AssistantTimeline");
    expect(ROW).toContain("AssistantSurfaceCard");
    expect(ROW).toContain("ConfirmationCard");
    expect(ROW).toContain("ChoiceCard");
  });

  it("renders result cards from surfaces[] instead of named card slots", () => {
    expect(ROW).toContain("surfaces");
    expect(ROW).toContain("onOpenHref");
    expect(ROW).toContain("AssistantSurfaceCard");
    expect(ROW.includes("listCard")).toBe(false);
    expect(ROW.includes("aggregateCard")).toBe(false);
    expect(ROW.includes("entityCards")).toBe(false);
    expect(ROW.includes("onOpenOrders")).toBe(false);
    expect(ROW.includes("onOpenOrder")).toBe(false);
  });

  it("leaves flex:1 on list/aggregate rows and HITL actions", () => {
    expect(SURFACE).toContain("AssistantCollectionBlock");
    expect(COLLECTION).toContain("flex: 1");
    expect(AGGREGATE).toContain("AssistantAggregateBlock");
    expect(AGGREGATE_BLOCK).toContain("AssistantCollectionResultRow");
    expect(FRAME).toContain("flex: 1");
    expect(CONFIRMATION).toContain("AssistantResultFrame");
  });
});
