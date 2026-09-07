/**
 * Shared aggregate descriptor for assistant result surfaces (SHO-473 /
 * SHO-499). Two declared layouts: `summary` (headline + grouping) and
 * `breakdown` (column headers + grouping). A new cut is data
 * (`groupingKey`, headline, columns). A new layout is a design decision
 * that enters this closed set. Do not add a third layout here.
 *
 * The descriptor guarantees layout and grouping; the client builds the
 * rows. Parse does not carry display strings. `orders-aggregate` parses
 * onto `summary`. `breakdown` is proven with fixtures — not a second
 * live domain surface.
 */
import type { AssistantCollectionColumn } from "./collection.js";
import type { AssistantMoneyMinor } from "./helpers.js";

export const ASSISTANT_AGGREGATE_LAYOUTS = ["summary", "breakdown"] as const;

export type AssistantAggregateLayout =
  (typeof ASSISTANT_AGGREGATE_LAYOUTS)[number];

export type AssistantAggregateSummaryDescriptor = {
  readonly layout: "summary";
  readonly groupingKey: string;
  readonly headlineCount: number;
  readonly headlineGross: readonly AssistantMoneyMinor[];
};

export type AssistantAggregateBreakdownDescriptor = {
  readonly layout: "breakdown";
  readonly groupingKey: string;
  readonly columns: readonly AssistantCollectionColumn[];
};

export type AssistantAggregateDescriptor =
  AssistantAggregateSummaryDescriptor | AssistantAggregateBreakdownDescriptor;

export function assistantAggregateSummary(args: {
  readonly groupingKey: string;
  readonly headlineCount: number;
  readonly headlineGross: readonly AssistantMoneyMinor[];
}): AssistantAggregateSummaryDescriptor {
  return {
    layout: "summary",
    groupingKey: args.groupingKey,
    headlineCount: args.headlineCount,
    headlineGross: args.headlineGross,
  };
}

export function assistantAggregateBreakdown(args: {
  readonly groupingKey: string;
  readonly columns: readonly AssistantCollectionColumn[];
}): AssistantAggregateBreakdownDescriptor {
  return {
    layout: "breakdown",
    groupingKey: args.groupingKey,
    columns: args.columns,
  };
}
