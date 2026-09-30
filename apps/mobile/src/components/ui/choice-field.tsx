import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { chipCapsule, chipPressed } from "./chip-capsule";
import { inertHorizontalScrollProps } from "./inert-horizontal-scroll";

/**
 * Canvas `ChoiceField`: a horizontally scrollable chip row for a single
 * choice. Not the same as `SegmentedTabs` (pill track): chips are
 * separate capsules; the selected one is ink-filled. List filters use
 * 44pt chips (mp-to-mobile.md hit targets).
 */
export function ChoiceField<K extends string>(props: {
  readonly options: ReadonlyArray<{ readonly key: K; readonly label: string }>;
  readonly selected: K;
  readonly onSelect: (key: K) => void;
  readonly label?: string;
  readonly disabled?: boolean;
}) {
  return (
    <View>
      {props.label !== undefined && props.label.length > 0 ? (
        <Text style={styles.label}>{props.label}</Text>
      ) : null}
      <ScrollView
        {...inertHorizontalScrollProps}
        style={styles.scroll}
        contentContainerStyle={styles.chips}
      >
        {props.options.map((option) => {
          const selected = option.key === props.selected;
          return (
            <Pressable
              key={option.key}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={option.label}
              disabled={props.disabled}
              onPress={() => {
                props.onSelect(option.key);
              }}
              style={({ pressed }) => [
                styles.chip,
                selected ? styles.chipSelected : null,
                pressed && !selected ? styles.pressed : null,
              ]}
            >
              <Text
                style={selected ? styles.chipLabelSelected : styles.chipLabel}
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  label: {
    color: theme.colors.mutedForeground,
    fontSize: theme.typography.xs.fontSize,
    lineHeight: theme.typography.xs.lineHeight,
    fontWeight: "500",
    marginBottom: theme.spacing.sm,
  },
  scroll: {
    flexGrow: 0,
    backgroundColor: "transparent",
  },
  chips: {
    flexGrow: 0,
    flexDirection: "row",
    gap: theme.spacing.sm,
  },
  chip: {
    ...chipCapsule({
      theme,
      paddingHorizontal: theme.spacing.lg,
      shrink: false,
    }),
  },
  chipSelected: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primary,
  },
  pressed: { ...chipPressed(theme) },
  chipLabel: {
    color: theme.colors.foreground,
    fontSize: theme.typography.sm.fontSize,
    lineHeight: theme.typography.sm.lineHeight,
    fontWeight: "500",
  },
  chipLabelSelected: {
    color: theme.colors.primaryForeground,
    fontSize: theme.typography.sm.fontSize,
    lineHeight: theme.typography.sm.lineHeight,
    fontWeight: "500",
  },
}));
