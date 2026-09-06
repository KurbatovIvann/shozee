/**
 * Shared aggregate descriptor for assistant result surfaces (SHO-473).
 * Two declared layouts: `summary` (flat sections + headline) and
 * `breakdown` (two-level table + totals). A new cut is data (`groupingKey`,
 * section/column labels). A new layout is a design decision that enters
 * this closed set. Do not add a third layout here.
 *
 * Rows and columns reuse T4 collection primitives. `orders-aggregate`
 * parses onto `summary`. `breakdown` is proven with fixtures — not a
 * second live domain surface.
 */
import type {
  AssistantCollectionColumn,
  AssistantCollectionRow,
} from "./collection.js";
import type { AssistantMoneyMinor } from "./helpers.js";

export const ASSISTANT_AGGREGATE_LAYOUTS = ["summary", "breakdown"] as const;

export type AssistantAggregateLayout =
  (typeof ASSISTANT_AGGREGATE_LAYOUTS)[number];

export type AssistantAggregateSection = {
  readonly id: string;
  readonly heading: string;
  readonly rows: readonly AssistantCollectionRow[];
};

export type AssistantAggregateGroup = {
  readonly id: string;
  readonly head: AssistantCollectionRow;
  readonly children: readonly AssistantCollectionRow[];
};

export type AssistantAggregateSummaryDescriptor = {
  readonly layout: "summary";
  readonly groupingKey: string;
  readonly headlineCount: number;
  readonly headlineGross: readonly AssistantMoneyMinor[];
  readonly sections: readonly AssistantAggregateSection[];
  readonly featured: AssistantCollectionRow | null;
};

export type AssistantAggregateBreakdownDescriptor = {
  readonly layout: "breakdown";
  readonly groupingKey: string;
  readonly columns: readonly AssistantCollectionColumn[];
  readonly groups: readonly AssistantAggregateGroup[];
  readonly total: AssistantCollectionRow | null;
};

export type AssistantAggregateDescriptor =
  | AssistantAggregateSummaryDescriptor
  | AssistantAggregateBreakdownDescriptor;

export function assistantAggregateSummary(args: {
  readonly groupingKey: string;
  readonly headlineCount: number;
  readonly headlineGross: readonly AssistantMoneyMinor[];
  readonly sections: readonly AssistantAggregateSection[];
  readonly featured: AssistantCollectionRow | null;
}): AssistantAggregateSummaryDescriptor {
  return {
    layout: "summary",
    groupingKey: args.groupingKey,
    headlineCount: args.headlineCount,
    headlineGross: args.headlineGross,
    sections: args.sections,
    featured: args.featured,
  };
}

export function assistantAggregateBreakdown(args: {
  readonly groupingKey: string;
  readonly columns: readonly AssistantCollectionColumn[];
  readonly groups: readonly AssistantAggregateGroup[];
  readonly total: AssistantCollectionRow | null;
}): AssistantAggregateBreakdownDescriptor {
  return {
    layout: "breakdown",
    groupingKey: args.groupingKey,
    columns: args.columns,
    groups: args.groups,
    total: args.total,
  };
}
