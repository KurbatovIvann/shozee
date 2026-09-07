import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assistantResultCta,
  assistantResultHandoff,
  assistantResultMarks,
  ORIGIN_MARK_ICON_SIZE,
} from "../sheet/assistant-result-chrome";
import type { AssistantResultMarksCarrier } from "../surfaces";

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
const MARKS = readFileSync(
  new URL("../surfaces/marks.ts", import.meta.url),
  "utf8",
);
const CARD_VIEWS = [
  "customers-list",
  "order-entity",
  "orders-aggregate",
  "orders-list",
].map((name) =>
  readFileSync(new URL(`../surfaces/${name}.ts`, import.meta.url), "utf8"),
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

  it("fails the build on an unhandled surface kind instead of an empty frame (SHO-498)", () => {
    // The block switch is what decides whether a card appears at all. A
    // fifth registered kind must not compile into a silent empty frame:
    // the declared return type refuses `undefined`, and the `never`
    // assignment after the switch names the kind tsc could not place.
    expect(SURFACE).toContain("}): ReactElement | null {");
    expect(SURFACE).toContain("const unhandledSurfaceKind: never = surface;");
    expect(SURFACE).toContain("return unhandledSurfaceKind;");
    expect(SURFACE).not.toContain("default:");
  });

  it("routes both list kinds through one spelling of the collection block (SHO-498)", () => {
    expect(SURFACE).toContain('case "orders-list":');
    expect(SURFACE).toContain('case "customers-list":');
    expect(SURFACE.match(/<AssistantCollectionBlock/g)?.length).toBe(1);
    expect(SURFACE).not.toContain("OrdersListResultCard");
  });

  it("puts empty state and CTA on the frame — card modules do not import Card", () => {
    expect(FRAME).toContain("emptyTitle");
    expect(FRAME).toContain("emptyDescription");
    expect(FRAME).toContain("<Button");
    expect(SURFACE).toContain("emptyTitle={empty.title}");
    expect(SURFACE).toContain("secondaryCta");
    expect(SURFACE).toContain('id: "cta"');
    expect(SURFACE).toContain('variant: "secondary"');
    expect(importsNamed(COLLECTION, "Card")).toBe(false);
    expect(COLLECTION).toContain("StatusPill");
    expect(COLLECTION).toContain("flex: 1");
    expect(importsNamed(AGGREGATE, "Card")).toBe(false);
    expect(AGGREGATE).not.toContain("StatusPill");
    expect(AGGREGATE).toContain("AssistantAggregateBlock");
    expect(importsNamed(ENTITY, "Card")).toBe(false);
    expect(importsNamed(CONFIRMATION, "Card")).toBe(false);
    expect(importsNamed(FRAME, "Card")).toBe(true);
    expect(COLLECTION).not.toContain("<Button");
    expect(AGGREGATE).not.toContain("<Button");
    expect(COLLECTION).not.toContain("emptyTitle");
    expect(ENTITY).not.toContain("emptyTitle");
  });
});

describe("assistant result provenance marks (SHO-469 / SHO-497)", () => {
  it("renders nothing when the view declares no marks", () => {
    const unmarked: AssistantResultMarksCarrier = {};
    expect(assistantResultMarks(unmarked)).toEqual({
      provisional: false,
      origin: false,
      originLabel: null,
    });
    expect(assistantResultMarks({})).toEqual({
      provisional: false,
      origin: false,
      originLabel: null,
    });
    expect(FRAME).toContain("provisional={provisional}");
    expect(FRAME).toContain("const showOrigin = origin;");
    expect(FRAME).not.toContain("origin && !provisional");
    expect(FRAME).toContain("{showOrigin ? <OriginMark");
  });

  it("renders both marks when the view declares them", () => {
    const marked: AssistantResultMarksCarrier = {
      marks: { provisional: true, origin: true, originLabel: "Шозік" },
    };
    expect(assistantResultMarks(marked)).toEqual({
      provisional: true,
      origin: true,
      originLabel: "Шозік",
    });
    expect(
      assistantResultMarks({
        marks: { provisional: false, origin: true, originLabel: null },
      }),
    ).toEqual({ provisional: false, origin: true, originLabel: null });
    expect(FRAME).toContain("<Card provisional={provisional}>");
    expect(FRAME).toContain("const showOrigin = origin;");
    expect(FRAME).toContain("{showOrigin ? <OriginMark");
    expect(FRAME).not.toContain("origin && !provisional");
    expect(FRAME).toContain("SparklesIcon");
    expect(FRAME).toContain("ORIGIN_MARK_ICON_SIZE");
    expect(ORIGIN_MARK_ICON_SIZE).toBe(12);
    expect(CHROME).toContain("provisional");
    expect(CHROME).toContain("originLabel");
    expect(CHROME).not.toContain("createdVia");
  });

  it("makes a mark that is not the declared field a compile error", () => {
    // Each of these compiled before SHO-497 and read as a silent `false`:
    // the reader took `value: object` and probed string keys.
    // @ts-expect-error SHO-497: loose flags are not the `marks` field.
    const looseFlags: AssistantResultMarksCarrier = { origin: true };
    // @ts-expect-error SHO-497: a misspelled mark field does not compile.
    const misspelled: AssistantResultMarksCarrier = { mark: null };
    // @ts-expect-error SHO-497: an unknown value is not a card view.
    const notAView: AssistantResultMarksCarrier = "ai";
    expect(assistantResultMarks(looseFlags)).toEqual({
      provisional: false,
      origin: false,
      originLabel: null,
    });
    expect(misspelled).toBeDefined();
    expect(notAView).toBe("ai");
    expect(CHROME).not.toContain("assistantResultMarksFromUnknown");
    expect(CHROME).not.toContain("value: object");
    expect(CHROME).toContain("view.marks ?? EMPTY_MARKS");
  });

  it("declares the field on every card view and fills it nowhere", () => {
    for (const source of CARD_VIEWS) {
      expect(source).toContain("readonly marks?: AssistantResultMarks;");
      expect(source).not.toContain("marks: {");
    }
    expect(MARKS).toContain("No surface produces marks today");
    expect(MARKS).toContain("SHO-464");
    expect(MARKS).toContain("createdVia");
    expect(MARKS).toContain("vouchedBy");
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
