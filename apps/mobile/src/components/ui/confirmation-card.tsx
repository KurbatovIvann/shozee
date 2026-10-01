import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import type { ConfirmationCardCopy } from "../../i18n/copy";
import { Button } from "./button";
import type { ConfirmDialogChoice } from "./confirm-dialog";
import type { ConfirmationCardView } from "./confirmation-card.model";
import { Sheet } from "./sheet";

export function ConfirmationCard(props: {
  readonly visible: boolean;
  readonly view: ConfirmationCardView | null;
  readonly copy: ConfirmationCardCopy;
  readonly onChoice: (choice: ConfirmDialogChoice) => void;
  readonly onHidden: () => void;
}) {
  const view = props.view;
  if (view === null) {
    return null;
  }
  return (
    <Sheet
      visible={props.visible}
      title={view.title}
      mode="content"
      closeAccessibilityLabel={props.copy.close}
      onClose={() => {
        props.onChoice("cancel");
      }}
      onHidden={props.onHidden}
      footer={
        <View style={styles.footer}>
          <View style={styles.footerSlot}>
            <Button
              label={props.copy.cancel}
              variant="secondary"
              fullWidth
              onPress={() => {
                props.onChoice("cancel");
              }}
            />
          </View>
          <View style={styles.footerSlot}>
            <Button
              label={props.copy.confirm}
              variant="primary"
              fullWidth
              onPress={() => {
                props.onChoice("confirm");
              }}
            />
          </View>
        </View>
      }
    >
      <View style={styles.body}>
        {view.summary !== null ? (
          <Text style={styles.summary}>{view.summary}</Text>
        ) : null}
        {view.lines.length > 0 ? (
          <View style={styles.lines}>
            {view.lines.map((line) => (
              <View key={`${line.label}:${line.value}`} style={styles.line}>
                <Text style={styles.lineLabel}>{line.label}</Text>
                <Text style={styles.lineValue}>{line.value}</Text>
              </View>
            ))}
          </View>
        ) : null}
        {view.notes.map((note) => (
          <View key={note} style={styles.note}>
            <Text style={styles.noteText}>{note}</Text>
          </View>
        ))}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing.md,
  },
  summary: {
    ...theme.typography.base,
    color: theme.colors.mutedForeground,
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
  footer: {
    flexDirection: "row",
    gap: theme.spacing.md,
  },
  footerSlot: {
    flex: 1,
  },
}));
