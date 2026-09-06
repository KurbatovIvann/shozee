import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { AssistantResultFrame } from "./assistant-result-frame";

export function ConfirmationCard(props: {
  readonly title: string;
  readonly summary: string;
  readonly confirmLabel: string;
  readonly dismissLabel: string;
  readonly confirmingLabel: string;
  readonly applying: boolean;
  readonly onConfirm: () => void;
  readonly onDismiss: () => void;
}) {
  return (
    <AssistantResultFrame
      title={props.title}
      body={props.summary}
      actions={
        props.applying
          ? []
          : [
              {
                id: "dismiss",
                label: props.dismissLabel,
                variant: "secondary",
                onPress: props.onDismiss,
              },
              {
                id: "confirm",
                label: props.confirmLabel,
                onPress: props.onConfirm,
              },
            ]
      }
    >
      {props.applying ? (
        <Text style={styles.applying}>{props.confirmingLabel}</Text>
      ) : null}
    </AssistantResultFrame>
  );
}

const styles = StyleSheet.create((theme) => ({
  applying: {
    color: theme.colors.mutedForeground,
    fontSize: theme.typography.sm.fontSize,
    lineHeight: theme.typography.sm.lineHeight,
    textAlign: "center",
    paddingVertical: theme.spacing.sm,
  },
}));
