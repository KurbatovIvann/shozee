import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export type PreviewDetailLine = {
  readonly label: string;
  readonly value: string;
};

export function PreviewDetails(props: {
  readonly lines: readonly PreviewDetailLine[];
  readonly notes: readonly string[];
}) {
  if (props.lines.length === 0 && props.notes.length === 0) {
    return null;
  }
  return (
    <View style={styles.details}>
      {props.lines.length > 0 ? (
        <View style={styles.lines}>
          {props.lines.map((line, index) => (
            <View
              key={`${String(index)}:${line.label}:${line.value}`}
              style={styles.line}
            >
              <Text style={styles.lineLabel}>{line.label}</Text>
              <Text style={styles.lineValue}>{line.value}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {props.notes.map((note, index) => (
        <View key={`${String(index)}:${note}`} style={styles.note}>
          <Text style={styles.noteText}>{note}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  details: {
    gap: theme.spacing.md,
  },
  lines: {
    backgroundColor: theme.colors.inputFill,
    borderRadius: theme.radii.lg,
    ...theme.squircle,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  line: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing.md,
  },
  lineLabel: {
    flexShrink: 0,
    maxWidth: "50%",
    ...theme.typography.sm,
    color: theme.colors.mutedForeground,
  },
  lineValue: {
    flex: 1,
    textAlign: "right",
    ...theme.typography.base,
    color: theme.colors.cardForeground,
  },
  note: {
    backgroundColor: theme.colors.accentSoft,
    borderRadius: theme.radii.md,
    ...theme.squircle,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  noteText: {
    ...theme.typography.sm,
    color: theme.colors.accentFg,
  },
}));
