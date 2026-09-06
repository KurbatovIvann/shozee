import { memo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import type { AssistantAggregateView } from "../surfaces/aggregate";
import type { AssistantCollectionRowView } from "../surfaces/collection";
import {
  AssistantCollectionColumnHeaders,
  AssistantCollectionResultRow,
} from "./assistant-collection-block";

/**
 * One aggregate block, two declared layouts (SHO-473). `summary` is
 * period → headline → flat sections. `breakdown` is a two-level table
 * with a totals row. Rows and column headers are T4 collection
 * primitives — do not add a third layout or a second row type.
 */
export const AssistantAggregateBlock = memo(
  function AssistantAggregateBlock(props: {
    readonly aggregate: AssistantAggregateView;
    readonly onOpenHref: (href: string) => void;
  }) {
    const { aggregate, onOpenHref } = props;
    switch (aggregate.layout) {
      case "summary":
        return (
          <SummaryAggregateLayout
            aggregate={aggregate}
            onOpenHref={onOpenHref}
          />
        );
      case "breakdown":
        return (
          <BreakdownAggregateLayout
            aggregate={aggregate}
            onOpenHref={onOpenHref}
          />
        );
    }
  },
);

const SummaryAggregateLayout = memo(function SummaryAggregateLayout(props: {
  readonly aggregate: Extract<AssistantAggregateView, { layout: "summary" }>;
  readonly onOpenHref: (href: string) => void;
}) {
  const { aggregate, onOpenHref } = props;
  const periodLabel = aggregate.periodLabel;
  const featured = aggregate.featured;
  const showSections = aggregate.sections.some(
    (section) => section.rows.length > 0,
  );

  return (
    <>
      {periodLabel !== null ? (
        <Text style={styles.period}>{periodLabel}</Text>
      ) : null}
      <Text style={styles.headline}>{aggregate.headlineCountLabel}</Text>
      {aggregate.headlineMoneyLabels.length > 0 ? (
        <View style={styles.moneyColumn}>
          {aggregate.headlineMoneyLabels.map((label) => (
            <Text key={label} style={styles.headlineMoney}>
              {label}
            </Text>
          ))}
        </View>
      ) : null}
      {showSections ? (
        <View style={styles.sections}>
          {aggregate.sections.map((section) =>
            section.rows.length === 0 ? null : (
              <View key={section.id} style={styles.rows}>
                {section.heading.length > 0 ? (
                  <Text style={styles.sectionHeading}>{section.heading}</Text>
                ) : null}
                {section.rows.map((row) => (
                  <AggregateCollectionRow
                    key={row.id}
                    row={row}
                    cellLayout="stacked"
                    onOpenHref={onOpenHref}
                  />
                ))}
              </View>
            ),
          )}
        </View>
      ) : null}
      {featured !== null ? (
        <AggregateCollectionRow
          row={featured}
          cellLayout="stacked"
          onOpenHref={onOpenHref}
        />
      ) : null}
    </>
  );
});

const BreakdownAggregateLayout = memo(function BreakdownAggregateLayout(props: {
  readonly aggregate: Extract<AssistantAggregateView, { layout: "breakdown" }>;
  readonly onOpenHref: (href: string) => void;
}) {
  const { aggregate, onOpenHref } = props;
  const total = aggregate.total;

  return (
    <View style={styles.rows}>
      <AssistantCollectionColumnHeaders columns={aggregate.columns} />
      {aggregate.groups.map((group) => (
        <View key={group.id} style={styles.group}>
          <AggregateCollectionRow row={group.head} onOpenHref={onOpenHref} />
          {group.children.map((child) => (
            <AggregateCollectionRow
              key={child.id}
              row={child}
              indent
              onOpenHref={onOpenHref}
            />
          ))}
        </View>
      ))}
      {total !== null ? (
        <View style={styles.totalRow}>
          <AggregateCollectionRow row={total} onOpenHref={onOpenHref} />
        </View>
      ) : null}
    </View>
  );
});

const AggregateCollectionRow = memo(function AggregateCollectionRow(props: {
  readonly row: AssistantCollectionRowView;
  readonly onOpenHref: (href: string) => void;
  readonly cellLayout?: "inline" | "stacked";
  readonly indent?: boolean;
}) {
  const { row, onOpenHref, cellLayout, indent } = props;
  return (
    <AssistantCollectionResultRow
      title={row.title}
      badge={row.badge}
      badgeTone={row.badgeTone}
      meta={row.meta}
      cells={row.cells}
      href={row.href}
      onOpenHref={onOpenHref}
      {...(cellLayout !== undefined ? { cellLayout } : {})}
      {...(indent !== undefined ? { indent } : {})}
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  period: {
    color: theme.colors.mutedForeground,
    fontSize: theme.typography.xs.fontSize,
    lineHeight: theme.typography.xs.lineHeight,
  },
  headline: {
    color: theme.colors.foreground,
    fontSize: theme.typography.sm.fontSize,
    lineHeight: theme.typography.sm.lineHeight,
    fontWeight: "600",
  },
  moneyColumn: {
    gap: theme.spacing["2xs"],
  },
  headlineMoney: {
    color: theme.colors.foreground,
    fontSize: theme.typography.sm.fontSize,
    lineHeight: theme.typography.sm.lineHeight,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  sections: {
    gap: theme.spacing.md,
  },
  rows: {
    gap: theme.spacing.xs,
  },
  sectionHeading: {
    color: theme.colors.mutedForeground,
    fontSize: theme.typography.xs.fontSize,
    lineHeight: theme.typography.xs.lineHeight,
    fontWeight: "500",
  },
  group: {
    gap: theme.spacing["2xs"],
    paddingTop: theme.spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.muted,
  },
  totalRow: {
    paddingTop: theme.spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.muted,
  },
}));
