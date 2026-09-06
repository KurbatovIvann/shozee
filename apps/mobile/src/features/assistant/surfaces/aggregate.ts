/**
 * Localized aggregate view (SHO-473). Parse descriptors stay
 * unlocalized; this is what the aggregate block renders. Both layouts
 * reuse T4 collection row/column views — a new grouping key is data.
 */
import type {
  AssistantAggregateLayout,
  AssistantCollectionColumn,
} from "@showzy/validation/assistant-surfaces";

import type {
  AssistantCollectionColumnView,
  AssistantCollectionRowView,
} from "./collection";

export type AssistantAggregateSectionView = {
  readonly id: string;
  readonly heading: string;
  readonly rows: readonly AssistantCollectionRowView[];
};

export type AssistantAggregateGroupView = {
  readonly id: string;
  readonly head: AssistantCollectionRowView;
  readonly children: readonly AssistantCollectionRowView[];
};

export type AssistantAggregateSummaryView = {
  readonly layout: "summary";
  readonly groupingKey: string;
  readonly periodLabel: string | null;
  readonly headlineCountLabel: string;
  readonly headlineMoneyLabels: readonly string[];
  readonly sections: readonly AssistantAggregateSectionView[];
  readonly featured: AssistantCollectionRowView | null;
};

export type AssistantAggregateBreakdownView = {
  readonly layout: "breakdown";
  readonly groupingKey: string;
  readonly columns: readonly AssistantCollectionColumnView[];
  readonly groups: readonly AssistantAggregateGroupView[];
  readonly total: AssistantCollectionRowView | null;
};

export type AssistantAggregateView =
  | AssistantAggregateSummaryView
  | AssistantAggregateBreakdownView;

export function localizeAggregateColumns(
  columns: readonly AssistantCollectionColumn[],
): readonly AssistantCollectionColumnView[] {
  return columns.map((column) => ({
    id: column.id,
    label: column.label,
    width: column.width,
    alignment: column.alignment,
  }));
}

export function isAssistantAggregateLayout(
  value: unknown,
): value is AssistantAggregateLayout {
  return value === "summary" || value === "breakdown";
}
