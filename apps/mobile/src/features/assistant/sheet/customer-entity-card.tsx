import { memo } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { StatusPill } from "../../../components/ui";
import type { AssistantCustomerEntityCardView } from "../surfaces";

export const CustomerEntityCard = memo(function CustomerEntityCard(props: {
  readonly card: AssistantCustomerEntityCardView;
  readonly onOpenHref: (href: string) => void;
}) {
  const { card } = props;
  if (card.name === null) {
    return <Text style={styles.gone}>{card.goneLabel}</Text>;
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={card.name}
      onPress={() => {
        props.onOpenHref(card.href);
      }}
      style={({ pressed }) => [styles.body, pressed ? styles.pressed : null]}
    >
      <View style={styles.titleRow}>
        <Text numberOfLines={1} style={styles.title}>
          {card.name}
        </Text>
        {card.statusLabel !== null ? (
          <StatusPill label={card.statusLabel} tone={card.statusTone} />
        ) : null}
      </View>
      {card.detailRows.map((row) => (
        <Text key={row} numberOfLines={1} style={styles.detail}>
          {row}
        </Text>
      ))}
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
  gone: {
    color: theme.colors.mutedForeground,
    fontSize: theme.typography.sm.fontSize,
    lineHeight: theme.typography.sm.lineHeight,
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
  detail: {
    color: theme.colors.mutedForeground,
    fontSize: theme.typography.xs.fontSize,
    lineHeight: theme.typography.xs.lineHeight,
  },
}));
