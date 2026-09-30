import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import type { AssistantExampleChip } from "./assistant-chrome";

export function AssistantExampleChips(props: {
  readonly chips: readonly AssistantExampleChip[];
  readonly label: string;
  readonly layout: "scroll" | "wrap";
  readonly onSend: (text: string) => void;
}) {
  if (props.chips.length === 0) {
    return null;
  }

  const items = props.chips.map((chip) => (
    <Pressable
      key={chip.key}
      accessibilityRole="button"
      accessibilityLabel={chip.text}
      onPress={() => {
        props.onSend(chip.text);
      }}
      style={({ pressed }) => [styles.chip, pressed ? styles.pressed : null]}
    >
      <Text numberOfLines={1} style={styles.chipLabel}>
        {chip.text}
      </Text>
    </Pressable>
  ));

  if (props.layout === "wrap") {
    return (
      <View accessibilityLabel={props.label} style={styles.wrap}>
        {items}
      </View>
    );
  }

  return (
    <ScrollView
      horizontal
      accessibilityLabel={props.label}
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      style={styles.strip}
      contentContainerStyle={styles.stripContent}
    >
      {items}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  wrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: theme.spacing.sm,
  },
  strip: {
    flexGrow: 0,
  },
  stripContent: {
    flexDirection: "row",
    gap: theme.spacing.sm,
    paddingBottom: theme.spacing.sm,
  },
  chip: {
    borderRadius: theme.radii.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  chipLabel: {
    color: theme.colors.mutedForeground,
    fontSize: theme.typography.sm.fontSize,
    lineHeight: theme.typography.sm.lineHeight,
  },
  pressed: {
    opacity: theme.pressedOpacity,
  },
}));
