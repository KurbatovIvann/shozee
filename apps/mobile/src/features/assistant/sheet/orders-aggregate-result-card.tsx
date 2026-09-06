import { memo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { StatusPill } from "../../../components/ui";
import type { AssistantOrdersAggregateCardView } from "../surfaces";

/**
 * Live `orders_list_counts` body (SHO-370 / SHO-395 / SHO-469). Chrome
 * (empty, footnotes, CTA, Card) lives on `AssistantResultFrame`. Period,
 * totals, always-on status rows, optional product/customer section — not
 * a chart and not the orders list screen.
 */
export const OrdersAggregateResultCard = memo(
  function OrdersAggregateResultCard(props: {
    readonly card: AssistantOrdersAggregateCardView;
  }) {
    const { card } = props;
    const periodLabel = card.periodLabel;
    const showExtra = card.extraBuckets.length > 0;
    const showBuckets =
      card.emptyTitle === null && (card.statusBuckets.length > 0 || showExtra);

    return (
      <>
        {periodLabel !== null ? (
          <Text style={styles.period}>{periodLabel}</Text>
        ) : null}
        <Text style={styles.headline}>{card.orderCountLabel}</Text>
        {card.moneyLabels.length > 0 ? (
          <View style={styles.moneyColumn}>
            {card.moneyLabels.map((label) => (
              <Text key={label} style={styles.headlineMoney}>
                {label}
              </Text>
            ))}
          </View>
        ) : null}
        {showBuckets ? (
          <View style={styles.sections}>
            {card.statusBuckets.length > 0 ? (
              <View style={styles.rows}>
                {card.statusBuckets.map((bucket) => (
                  <AggregateBucketRow
                    key={bucket.id}
                    label={bucket.label}
                    orderCountLabel={bucket.orderCountLabel}
                    moneyLabels={bucket.moneyLabels}
                    quantityLabel={bucket.quantityLabel}
                    statusLabel={bucket.status !== null ? bucket.label : null}
                    statusTone={bucket.statusTone}
                  />
                ))}
              </View>
            ) : null}
            {showExtra ? (
              <View style={styles.rows}>
                {card.extraBuckets.map((bucket) => (
                  <AggregateBucketRow
                    key={bucket.id}
                    label={bucket.label}
                    orderCountLabel={bucket.orderCountLabel}
                    moneyLabels={bucket.moneyLabels}
                    quantityLabel={bucket.quantityLabel}
                    statusLabel={null}
                    statusTone={null}
                  />
                ))}
              </View>
            ) : null}
          </View>
        ) : null}
      </>
    );
  },
);

const AggregateBucketRow = memo(function AggregateBucketRow(props: {
  readonly label: string;
  readonly orderCountLabel: string;
  readonly moneyLabels: readonly string[];
  readonly quantityLabel: string | null;
  readonly statusLabel: string | null;
  readonly statusTone: AssistantOrdersAggregateCardView["statusBuckets"][number]["statusTone"];
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rowBody}>
        {props.statusLabel !== null && props.statusTone !== null ? (
          <StatusPill label={props.statusLabel} tone={props.statusTone} />
        ) : (
          <Text numberOfLines={2} style={styles.name}>
            {props.label}
          </Text>
        )}
        {props.quantityLabel !== null ? (
          <Text numberOfLines={1} style={styles.meta}>
            {props.quantityLabel}
          </Text>
        ) : null}
      </View>
      <View style={styles.metrics}>
        <Text style={styles.count}>{props.orderCountLabel}</Text>
        {props.moneyLabels.map((label) => (
          <Text key={label} numberOfLines={1} style={styles.total}>
            {label}
          </Text>
        ))}
      </View>
    </View>
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
  row: {
    minHeight: theme.hitTarget.min,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing["2xs"],
  },
  name: {
    color: theme.colors.foreground,
    fontSize: theme.typography.sm.fontSize,
    lineHeight: theme.typography.sm.lineHeight,
    fontWeight: "600",
  },
  meta: {
    color: theme.colors.mutedForeground,
    fontSize: theme.typography.xs.fontSize,
    lineHeight: theme.typography.xs.lineHeight,
  },
  metrics: {
    alignItems: "flex-end",
    gap: theme.spacing["2xs"],
  },
  count: {
    color: theme.colors.mutedForeground,
    fontSize: theme.typography.xs.fontSize,
    lineHeight: theme.typography.xs.lineHeight,
    fontVariant: ["tabular-nums"],
  },
  total: {
    color: theme.colors.foreground,
    fontSize: theme.typography.sm.fontSize,
    lineHeight: theme.typography.sm.lineHeight,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
}));
