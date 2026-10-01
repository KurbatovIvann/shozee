import { memo } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { StatusPill } from "../../../components/ui";
import type { AssistantEntityCardView } from "../surfaces";

export const EntityCard = memo(function EntityCard(props: {
  readonly card: AssistantEntityCardView;
  readonly onOpenHref: (href: string) => void;
}) {
  const { card } = props;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={card.title}
      onPress={() => {
        props.onOpenHref(card.href);
      }}
      style={({ pressed }) => [styles.body, pressed ? styles.pressed : null]}
    >
      <View style={styles.titleRow}>
        <Text numberOfLines={1} style={styles.title}>
          {card.title}
        </Text>
        {card.statusLabel !== null ? (
          <StatusPill label={card.statusLabel} tone={card.statusTone} />
        ) : null}
      </View>
      {card.subtitle !== null ? (
        <Text numberOfLines={1} style={styles.subtitle}>
          {card.subtitle}
        </Text>
      ) : null}
      {card.detailLabel !== null ? (
        <Text numberOfLines={1} style={styles.detail}>
          {card.detailLabel}
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
  subtitle: {
    color: theme.colors.mutedForeground,
    fontSize: theme.typography.xs.fontSize,
    lineHeight: theme.typography.xs.lineHeight,
  },
  detail: {
    color: theme.colors.foreground,
    fontSize: theme.typography.sm.fontSize,
    lineHeight: theme.typography.sm.lineHeight,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
}));
