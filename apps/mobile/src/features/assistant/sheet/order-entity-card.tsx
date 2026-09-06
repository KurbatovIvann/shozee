import { memo } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { StatusPill } from "../../../components/ui";
import type { AssistantOrderEntityCardView } from "../surfaces";

/**
 * Thin live `orders.get` / `orders.create` body (SHO-369 / SHO-469).
 * Card chrome lives on `AssistantResultFrame`. Title, status, customer,
 * and total stay here so gap (xs) and the pressable hit target do not
 * jump onto the frame title row. T4 hydrates the same card.
 */
export const OrderEntityCard = memo(function OrderEntityCard(props: {
  readonly card: AssistantOrderEntityCardView;
  readonly onOpenHref: (href: string) => void;
}) {
  const { card } = props;
  const title =
    card.orderNumberLabel.length > 0 ? card.orderNumberLabel : card.orderId;
  const accessibilityLabel =
    card.customerName !== null && card.customerName.length > 0
      ? card.customerName
      : title;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={() => {
        props.onOpenHref(card.href);
      }}
      style={({ pressed }) => [styles.body, pressed ? styles.pressed : null]}
    >
      <View style={styles.titleRow}>
        <Text numberOfLines={1} style={styles.title}>
          {title}
        </Text>
        {card.statusLabel !== null ? (
          <StatusPill label={card.statusLabel} tone={card.statusTone} />
        ) : null}
      </View>
      {card.customerName !== null ? (
        <Text numberOfLines={1} style={styles.customer}>
          {card.customerName}
        </Text>
      ) : null}
      {card.totalLabel !== null ? (
        <Text numberOfLines={1} style={styles.total}>
          {card.totalLabel}
        </Text>
      ) : null}
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing.xs,
  },
  pressed: {
    opacity: theme.pressedOpacity,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing.xs,
  },
  title: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.typography.sm.fontSize,
    lineHeight: theme.typography.sm.lineHeight,
    fontWeight: "600",
  },
  customer: {
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
