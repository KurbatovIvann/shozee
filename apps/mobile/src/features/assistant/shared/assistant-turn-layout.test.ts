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
const LIST = readFileSync(
  new URL("../sheet/orders-list-result-card.tsx", import.meta.url),
  "utf8",
);
const AGGREGATE = readFileSync(
  new URL("../sheet/orders-aggregate-result-card.tsx", import.meta.url),
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
    expect(LIST).toContain("flex: 1");
    expect(AGGREGATE).toContain("flex: 1");
    expect(FRAME).toContain("flex: 1");
    expect(CONFIRMATION).toContain("AssistantResultFrame");
  });
});
