import { memo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import {
  assistantTurnColumnLayout,
  assistantTurnResultStretch,
} from "../shared/assistant-turn-layout";
import type {
  ChoiceAttemptedOption,
  PendingChoice,
} from "../shared/choice-presenter";
import { assistantSurfaceKey, type AssistantSurface } from "../surfaces";
import { AssistantSurfaceCard } from "./assistant-surface-card";
import { AssistantWaitLine } from "./assistant-wait-line";
import { ChoiceCard } from "./choice-card";
import { ConfirmationCard } from "./confirmation-card";

export const AssistantMessageRow = memo(function AssistantMessageRow(props: {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly waiting: boolean;
  readonly waitLines: readonly string[];
  readonly waitIntervalMs: number;
  readonly waitLabel: string;
  readonly surfaces: readonly AssistantSurface[];
  readonly onOpenHref: (href: string) => void;
  readonly confirmationSummary: string | null;
  readonly confirmationTitle: string;
  readonly confirmLabel: string;
  readonly dismissLabel: string;
  readonly confirmingLabel: string;
  readonly confirmationApplying: boolean;
  readonly onConfirm: () => void;
  readonly onDismiss: () => void;
  readonly choice: PendingChoice | null;
  readonly choiceTitle: string;
  readonly choiceTruncatedLabel: string | null;
  readonly choiceExpiredLabel: string;
  readonly choiceClaimedLabel: string;
  readonly choiceRetryLabel: string;
  readonly choiceSelectingLabel: string;
  readonly choiceApplying: boolean;
  readonly choiceAttempted: ChoiceAttemptedOption | null;
  readonly onSelectChoice: (optionId: string) => void;
}) {
  const isUser = props.role === "user";
  const confirmationSummary = props.confirmationSummary;
  const choice = props.choice;

  return (
    <View style={isUser ? styles.userWrap : styles.assistantWrap}>
      {props.waiting ? (
        <AssistantWaitLine
          lines={props.waitLines}
          intervalMs={props.waitIntervalMs}
          accessibilityLabel={props.waitLabel}
        />
      ) : null}
      {!props.waiting && props.text.length > 0 ? (
        <Text style={isUser ? styles.userBubble : styles.assistantBubble}>
          {props.text}
        </Text>
      ) : null}
      {!props.waiting
        ? props.surfaces.map((surface) => (
            <AssistantTurnResult key={assistantSurfaceKey(surface)}>
              <AssistantSurfaceCard
                surface={surface}
                onOpenHref={props.onOpenHref}
              />
            </AssistantTurnResult>
          ))
        : null}
      {!props.waiting && confirmationSummary !== null ? (
        <AssistantTurnResult>
          <ConfirmationCard
            title={props.confirmationTitle}
            summary={confirmationSummary}
            confirmLabel={props.confirmLabel}
            dismissLabel={props.dismissLabel}
            confirmingLabel={props.confirmingLabel}
            applying={props.confirmationApplying}
            onConfirm={props.onConfirm}
            onDismiss={props.onDismiss}
          />
        </AssistantTurnResult>
      ) : null}
      {!props.waiting && choice !== null ? (
        <AssistantTurnResult>
          <ChoiceCard
            title={props.choiceTitle}
            truncatedLabel={props.choiceTruncatedLabel}
            expiredLabel={props.choiceExpiredLabel}
            claimedLabel={props.choiceClaimedLabel}
            retryLabel={props.choiceRetryLabel}
            selectingLabel={props.choiceSelectingLabel}
            applying={props.choiceApplying}
            choice={choice}
            attempted={props.choiceAttempted}
            onSelect={props.onSelectChoice}
          />
        </AssistantTurnResult>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  userWrap: {
    alignItems: "flex-end",
    gap: theme.spacing.sm,
    marginBottom: theme.spacing.md,
  },
  assistantWrap: {
    ...assistantTurnColumnLayout,
    gap: theme.spacing.sm,
    marginBottom: theme.spacing.md,
  },
  resultStretch: {
    ...assistantTurnResultStretch,
  },
  userBubble: {
    maxWidth: "80%",
    color: theme.colors.primaryForeground,
    backgroundColor: theme.colors.primary,
    overflow: "hidden",
    borderRadius: theme.radii.lg,
    borderBottomRightRadius: theme.radii.sm,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm + theme.spacing["2xs"],
    fontSize: theme.typography.sm.fontSize,
    lineHeight: theme.typography.sm.lineHeight,
  },
  assistantBubble: {
    color: theme.colors.foreground,
    backgroundColor: theme.colors.card,
    overflow: "hidden",
    borderRadius: theme.radii.lg,
    borderBottomLeftRadius: theme.radii.sm,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm + theme.spacing["2xs"],
    fontSize: theme.typography.sm.fontSize,
    lineHeight: theme.typography.sm.lineHeight,
    ...theme.shadows.sm,
  },
}));

function AssistantTurnResult(props: { readonly children: ReactNode }) {
  return <View style={styles.resultStretch}>{props.children}</View>;
}
