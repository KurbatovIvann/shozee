import { Pressable, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export function ActionChip(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [styles.chip, pressed ? styles.pressed : null]}
    >
      <Text numberOfLines={1} style={styles.label}>
        {props.label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  chip: {
    flexShrink: 0,
    minHeight: theme.hitTarget.min,
    justifyContent: "center",
    borderRadius: theme.radii.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    paddingHorizontal: theme.spacing.md,
  },
  label: {
    color: theme.colors.mutedForeground,
    fontSize: theme.typography.sm.fontSize,
    lineHeight: theme.typography.sm.lineHeight,
  },
  pressed: {
    opacity: theme.pressedOpacity,
  },
}));
