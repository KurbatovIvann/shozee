import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import type { ConfirmationCardCopy } from "../../i18n/copy";
import { Button } from "./button";
import type { ConfirmDialogChoice } from "./confirm-dialog";
import type { ConfirmationCardView } from "./confirmation-card.model";
import { PreviewDetails } from "./preview-details";
import { Sheet } from "./sheet";

export function ConfirmationCard(props: {
  readonly visible: boolean;
  readonly view: ConfirmationCardView | null;
  readonly confirmDisabled: boolean;
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
              disabled={props.confirmDisabled}
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
        <PreviewDetails lines={view.lines} notes={view.notes} />
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
  footer: {
    flexDirection: "row",
    gap: theme.spacing.md,
  },
  footerSlot: {
    flex: 1,
  },
}));
