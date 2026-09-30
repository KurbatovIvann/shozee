import { Pressable, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { chipCapsule, chipPressed } from "./chip-capsule";

export function ActionChip(props: {
  readonly label: string;
  readonly shrink: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      style={({ pressed }) => [
        props.shrink ? styles.chipShrink : styles.chip,
        pressed ? styles.pressed : null,
      ]}
    >
      <Text numberOfLines={1} style={styles.label}>
        {props.label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  chip: chipCapsule({
    theme,
    paddingHorizontal: theme.spacing.md,
    shrink: false,
  }),
  chipShrink: chipCapsule({
    theme,
    paddingHorizontal: theme.spacing.md,
    shrink: true,
  }),
  label: {
    flexShrink: 1,
    color: theme.colors.mutedForeground,
    fontSize: theme.typography.sm.fontSize,
    lineHeight: theme.typography.sm.lineHeight,
  },
  pressed: chipPressed(theme),
}));
