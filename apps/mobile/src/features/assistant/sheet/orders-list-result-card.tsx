import { memo } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { StatusPill } from "../../../components/ui";
import type { AssistantOrdersListCardView } from "../surfaces";

/**
 * Live `orders_list_page` rows (SHO-369 / SHO-469). Chrome (chips, empty,
 * footnotes, CTA, Card) lives on `AssistantResultFrame`. Feature body —
 * not the orders list screen or its virtualized row.
 */
export const OrdersListResultCard = memo(function OrdersListResultCard(props: {
  readonly card: AssistantOrdersListCardView;
  readonly onOpenHref: (href: string) => void;
}) {
  const { card } = props;

  return (
    <View style={styles.rows}>
      {card.rows.map((row) => (
        <ListResultRow
          key={row.orderId}
          href={row.href}
          customerName={row.customerName}
          statusLabel={row.statusLabel}
          statusTone={row.statusTone}
          metaLabel={row.metaLabel}
          totalLabel={row.totalLabel}
          onOpenHref={props.onOpenHref}
        />
      ))}
    </View>
  );
});

const ListResultRow = memo(function ListResultRow(props: {
  readonly href: string;
  readonly customerName: string;
  readonly statusLabel: string | null;
  readonly statusTone: AssistantOrdersListCardView["rows"][number]["statusTone"];
  readonly metaLabel: string;
  readonly totalLabel: string | null;
  readonly onOpenHref: (href: string) => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        props.customerName.length > 0 ? props.customerName : props.metaLabel
      }
      onPress={() => {
        props.onOpenHref(props.href);
      }}
      style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
    >
      <View style={styles.rowBody}>
        <View style={styles.nameRow}>
          <Text numberOfLines={1} style={styles.name}>
            {props.customerName}
          </Text>
          {props.statusLabel !== null ? (
            <StatusPill label={props.statusLabel} tone={props.statusTone} />
          ) : null}
        </View>
        {props.metaLabel.length > 0 ? (
          <Text numberOfLines={1} style={styles.meta}>
            {props.metaLabel}
          </Text>
        ) : null}
      </View>
      {props.totalLabel !== null ? (
        <Text numberOfLines={1} style={styles.total}>
          {props.totalLabel}
        </Text>
      ) : null}
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => ({
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
  pressed: {
    opacity: theme.pressedOpacity,
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing["2xs"],
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing.xs,
  },
  name: {
    flexShrink: 1,
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
  total: {
    color: theme.colors.foreground,
    fontSize: theme.typography.sm.fontSize,
    lineHeight: theme.typography.sm.lineHeight,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
}));
