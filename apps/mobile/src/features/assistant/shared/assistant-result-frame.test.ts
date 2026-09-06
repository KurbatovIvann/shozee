import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assistantResultCta,
  assistantResultHandoff,
  assistantResultMarks,
  assistantResultMarksFromUnknown,
  ORIGIN_MARK_ICON_SIZE,
} from "../sheet/assistant-result-chrome";

const FRAME = readFileSync(
  new URL("../sheet/assistant-result-frame.tsx", import.meta.url),
  "utf8",
);
const CHROME = readFileSync(
  new URL("../sheet/assistant-result-chrome.ts", import.meta.url),
  "utf8",
);
const SURFACE = readFileSync(
  new URL("../sheet/assistant-surface-card.tsx", import.meta.url),
  "utf8",
);
const LIST = readFileSync(
  new URL("../sheet/orders-list-result-card.tsx", import.meta.url),
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
const ENTITY = readFileSync(
  new URL("../sheet/order-entity-card.tsx", import.meta.url),
  "utf8",
);
const CONFIRMATION = readFileSync(
  new URL("../sheet/confirmation-card.tsx", import.meta.url),
  "utf8",
);

function importsNamed(source: string, name: string): boolean {
  return new RegExp(`import\\s*\\{[^}]*\\b${name}\\b`).test(source);
}

describe("AssistantResultFrame notice card (SHO-469)", () => {
  it("renders a notice card (pill + title + body + actions) with no block", () => {
    expect(FRAME).toContain("readonly pill");
    expect(FRAME).toContain("readonly title");
    expect(FRAME).toContain("readonly body");
    expect(FRAME).toContain("readonly actions");
    expect(FRAME).toContain("readonly children");
    expect(CONFIRMATION).toContain("AssistantResultFrame");
    expect(CONFIRMATION).toContain("title={props.title}");
    expect(CONFIRMATION).toContain("body={props.summary}");
    expect(CONFIRMATION).toContain('id: "dismiss"');
    expect(CONFIRMATION).toContain('id: "confirm"');
    expect(CONFIRMATION).not.toContain("OrdersListResultCard");
    expect(CONFIRMATION).not.toContain("OrdersAggregateResultCard");
    expect(CONFIRMATION).not.toContain("OrderEntityCard");
    expect(importsNamed(CONFIRMATION, "Card")).toBe(false);
    expect(SURFACE).toContain("AssistantResultFrame");
    expect(SURFACE).toContain("AssistantSurfaceBlock");
    expect(SURFACE).toContain("AssistantCollectionBlock");
    expect(SURFACE).toContain('case "customers-list"');
    expect(SURFACE).toContain("switch (surface.kind)");
    expect(SURFACE).toContain("OrdersAggregateResultCard");
    expect(AGGREGATE).toContain("AssistantAggregateBlock");
  });

  it("puts empty state and CTA on the frame — card modules do not import Card", () => {
    expect(FRAME).toContain("emptyTitle");
    expect(FRAME).toContain("emptyDescription");
    expect(FRAME).toContain("<Button");
    expect(SURFACE).toContain("emptyTitle={empty.title}");
    expect(SURFACE).toContain("secondaryCta");
    expect(SURFACE).toContain('id: "cta"');
    expect(SURFACE).toContain('variant: "secondary"');
    expect(importsNamed(LIST, "Card")).toBe(false);
    expect(importsNamed(COLLECTION, "Card")).toBe(false);
    expect(COLLECTION).toContain("StatusPill");
    expect(COLLECTION).toContain("flex: 1");
    expect(importsNamed(AGGREGATE, "Card")).toBe(false);
    expect(AGGREGATE).not.toContain("StatusPill");
    expect(AGGREGATE).toContain("AssistantAggregateBlock");
    expect(importsNamed(ENTITY, "Card")).toBe(false);
    expect(importsNamed(CONFIRMATION, "Card")).toBe(false);
    expect(importsNamed(FRAME, "Card")).toBe(true);
    expect(LIST).not.toContain("<Button");
    expect(AGGREGATE).not.toContain("<Button");
    expect(LIST).not.toContain("emptyTitle");
    expect(ENTITY).not.toContain("emptyTitle");
  });
});

describe("assistant result provenance marks (SHO-469)", () => {
  it("renders nothing when the fields are absent", () => {
    expect(assistantResultMarks({})).toEqual({
      provisional: false,
      origin: false,
      originLabel: null,
    });
    expect(assistantResultMarksFromUnknown(null)).toEqual({
      provisional: false,
      origin: false,
      originLabel: null,
    });
    expect(assistantResultMarksFromUnknown("ai")).toEqual({
      provisional: false,
      origin: false,
      originLabel: null,
    });
    expect(FRAME).toContain("provisional={provisional}");
    expect(FRAME).toContain("const showOrigin = origin;");
    expect(FRAME).not.toContain("origin && !provisional");
    expect(FRAME).toContain("{showOrigin ? <OriginMark");
  });

  it("renders both marks when both flags are present", () => {
    expect(
      assistantResultMarks({
        provisional: true,
        origin: true,
        originLabel: "Шозік",
      }),
    ).toEqual({
      provisional: true,
      origin: true,
      originLabel: "Шозік",
    });
    expect(FRAME).toContain("<Card provisional={provisional}>");
    expect(FRAME).toContain("const showOrigin = origin;");
    expect(FRAME).toContain("{showOrigin ? <OriginMark");
    expect(FRAME).not.toContain("origin && !provisional");
    expect(assistantResultMarks({ origin: true })).toEqual({
      provisional: false,
      origin: true,
      originLabel: null,
    });
    expect(assistantResultMarks({ provisional: false, origin: false })).toEqual(
      {
        provisional: false,
        origin: false,
        originLabel: null,
      },
    );
    expect(FRAME).toContain("SparklesIcon");
    expect(FRAME).toContain("ORIGIN_MARK_ICON_SIZE");
    expect(ORIGIN_MARK_ICON_SIZE).toBe(12);
    expect(CHROME).toContain("provisional");
    expect(CHROME).toContain("originLabel");
    expect(CHROME).not.toContain("createdVia");
  });
});

describe("assistant result destination handoff (SHO-470)", () => {
  it("renders a handoff row for screen pointing at the declared route", () => {
    expect(assistantResultHandoff({ kind: "screen", href: "/orders" })).toEqual(
      { href: "/orders" },
    );
    expect(
      assistantResultHandoff({
        kind: "screen",
        href: "/orders/0f0e2d5c-4a1b-4c3d-9e8f-102938475601",
      }),
    ).toEqual({ href: "/orders/0f0e2d5c-4a1b-4c3d-9e8f-102938475601" });
    expect(FRAME).toContain("assistantResultHandoff");
    expect(FRAME).toContain("DestinationHandoff");
    expect(FRAME).toContain("handoff !== null");
    expect(FRAME).toContain("props.destination");
    expect(SURFACE).toContain("destination={surface.destination}");
    expect(SURFACE).toContain("handoffLabel={surface.handoffLabel}");
    expect(SURFACE).toContain("onOpenHref={onOpenHref}");
  });

  it("renders no handoff row for terminal (or document, or absent)", () => {
    expect(assistantResultHandoff({ kind: "terminal" })).toBeNull();
    expect(assistantResultHandoff({ kind: "document" })).toBeNull();
    expect(assistantResultHandoff(undefined)).toBeNull();
    expect(assistantResultHandoff(null)).toBeNull();
    expect(FRAME).not.toContain('destination = { kind: "terminal" }');
    expect(FRAME).not.toContain('kind: "terminal"');
    expect(CONFIRMATION).not.toContain("destination=");
    expect(CONFIRMATION).not.toContain("handoffLabel");
  });

  it("omits the T1 CTA when ctaHref equals the screen destination", () => {
    expect(
      assistantResultCta("Open orders", "/orders", {
        kind: "screen",
        href: "/orders",
      }),
    ).toBeNull();
    expect(
      assistantResultCta("Open orders", "/orders", {
        kind: "screen",
        href: "/orders/0f0e2d5c-4a1b-4c3d-9e8f-102938475601",
      }),
    ).toEqual({ label: "Open orders", href: "/orders" });
    expect(
      assistantResultCta("Open orders", "/orders", { kind: "terminal" }),
    ).toEqual({ label: "Open orders", href: "/orders" });
    expect(
      assistantResultCta("Open orders", "/orders", { kind: "document" }),
    ).toEqual({ label: "Open orders", href: "/orders" });
    expect(
      assistantResultCta(null, "/orders", { kind: "terminal" }),
    ).toBeNull();
    expect(SURFACE).toContain("assistantResultCta");
    expect(SURFACE).toContain("secondaryCta");
  });
});
