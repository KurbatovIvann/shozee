import { useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import type {
  AssistantPreview,
  AssistantPreviewLevel,
} from "@showzy/validation/assistant-chat";

import { PreviewDetails } from "../../../components/ui";
import { AssistantResultFrame } from "./assistant-result-frame";
import {
  assistantPreviewCardModel,
  type AssistantPreviewCardCopy,
} from "./preview-card-model";

export function PreviewCard(props: {
  readonly interactionId: string;
  readonly revision: number;
  readonly summary: string;
  readonly preview: AssistantPreview;
  readonly also: readonly AssistantPreview[];
  readonly level: AssistantPreviewLevel;
  readonly applying: boolean;
  readonly copy: AssistantPreviewCardCopy;
  readonly onConfirm: () => void;
  readonly onDismiss: () => void;
}) {
  const [armedKey, setArmedKey] = useState<string | null>(null);
  const model = assistantPreviewCardModel({
    interactionId: props.interactionId,
    revision: props.revision,
    summary: props.summary,
    preview: props.preview,
    also: props.also,
    level: props.level,
    applying: props.applying,
    armedKey,
    copy: props.copy,
  });
  const primary = model.primary;

  return (
    <AssistantResultFrame
      pill={{
        label: model.eyebrow,
        tone: model.strong ? "danger" : "action",
      }}
      title={model.title}
      {...(model.summary === null ? {} : { body: model.summary })}
      actions={
        primary === null || model.dismissLabel === null
          ? []
          : [
              {
                id: "dismiss",
                label: model.dismissLabel,
                variant: "secondary",
                onPress: props.onDismiss,
              },
              {
                id: "confirm",
                label: primary.label,
                variant: primary.danger ? "danger" : "primary",
                onPress: () => {
                  if (primary.arms) {
                    setArmedKey(model.presentationKey);
                    return;
                  }
                  props.onConfirm();
                },
              },
            ]
      }
    >
      {model.warning !== null ? (
        <View style={styles.warning}>
          <Text style={styles.warningText}>{model.warning}</Text>
        </View>
      ) : null}
      {model.blocks.map((block, index) => (
        <View key={block.key} style={styles.block}>
          {block.caption !== null ? (
            <Text style={styles.caption}>{block.caption}</Text>
          ) : null}
          {index > 0 ? (
            <Text style={styles.blockTitle}>{block.title}</Text>
          ) : null}
          <PreviewDetails lines={block.lines} notes={block.notes} />
        </View>
      ))}
      {model.applyingLabel !== null ? (
        <Text style={styles.applying}>{model.applyingLabel}</Text>
      ) : null}
    </AssistantResultFrame>
  );
}

const styles = StyleSheet.create((theme) => ({
  warning: {
    backgroundColor: theme.colors.destructiveSoft,
    borderRadius: theme.radii.md,
    ...theme.squircle,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  warningText: {
    ...theme.typography.sm,
    color: theme.colors.destructive,
    fontWeight: "600",
  },
  block: {
    gap: theme.spacing.sm,
  },
  caption: {
    ...theme.typography.xs,
    color: theme.colors.mutedForeground,
    fontWeight: "600",
  },
  blockTitle: {
    ...theme.typography.sm,
    color: theme.colors.foreground,
    fontWeight: "600",
  },
  applying: {
    ...theme.typography.sm,
    color: theme.colors.mutedForeground,
    textAlign: "center",
    paddingVertical: theme.spacing.sm,
  },
}));
