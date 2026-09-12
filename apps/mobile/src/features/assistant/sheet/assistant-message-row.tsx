import { memo, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import {
  assistantTurnColumnLayout,
  assistantTurnResultStretch,
} from "../shared/assistant-turn-layout";
import type { AssistantInteraction } from "@showzy/validation/assistant-chat";

import { assistantSurfaceKey, type AssistantSurface } from "../surfaces";
import { AssistantMarkdownView } from "./assistant-markdown-view";
import { AssistantSurfaceCard } from "./assistant-surface-card";
import { AssistantWaitLine } from "./assistant-wait-line";
import { InteractionCard, type InteractionCardCopy } from "./interaction-card";

export const AssistantMessageRow = memo(function AssistantMessageRow(props: {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly waiting: boolean;
  readonly waitLines: readonly string[];
  readonly waitIntervalMs: number;
  readonly waitLabel: string;
  readonly surfaces: readonly AssistantSurface[];
  /**
   * The turn ended before the assistant answered. Rendered under whatever it
   * did produce, because the cards above are real: a card with no reply and no
   * explanation is how a person decides to ask for the same order twice.
   */
  readonly failed: boolean;
  readonly failedLabel: string;
  readonly interrupted: boolean;
  readonly interruptedLabel: string;
  readonly continueLabel: string;
  readonly onContinue: () => void;
  readonly onOpenHref: (href: string) => void;
  /** Present only while it is answerable. There is no closed-question card. */
  readonly interaction: AssistantInteraction | null;
  readonly applying: boolean;
  readonly interactionCopy: InteractionCardCopy;
  readonly onAnswer: (answer: unknown) => void;
  readonly onDismiss: () => void;
}) {
  const isUser = props.role === "user";
  const interaction = props.interaction;

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
        isUser ? (
          <Text style={styles.userBubble}>{props.text}</Text>
        ) : (
          <View style={styles.assistantBubble}>
            <AssistantMarkdownView
              text={props.text}
              onOpenHref={props.onOpenHref}
            />
          </View>
        )
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
      {!props.waiting && props.failed ? (
        <Text style={styles.failedNote}>{props.failedLabel}</Text>
      ) : null}
      {!props.waiting && props.interrupted ? (
        <View style={styles.interruptedRow}>
          <Text style={styles.failedNote}>{props.interruptedLabel}</Text>
          <Pressable onPress={props.onContinue}>
            <Text style={styles.continueLabel}>{props.continueLabel}</Text>
          </Pressable>
        </View>
      ) : null}
      {!props.waiting && interaction !== null ? (
        <AssistantTurnResult>
          <InteractionCard
            interaction={interaction}
            applying={props.applying}
            copy={props.interactionCopy}
            onAnswer={props.onAnswer}
            onDismiss={props.onDismiss}
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
  failedNote: {
    maxWidth: "100%",
    color: theme.colors.mutedForeground,
    fontSize: theme.typography.xs.fontSize,
    lineHeight: theme.typography.xs.lineHeight,
  },
  interruptedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
  },
  continueLabel: {
    color: theme.colors.primary,
    fontSize: theme.typography.xs.fontSize,
    lineHeight: theme.typography.xs.lineHeight,
    fontWeight: "600",
  },
  assistantBubble: {
    maxWidth: "100%",
    backgroundColor: theme.colors.card,
    overflow: "hidden",
    borderRadius: theme.radii.lg,
    borderBottomLeftRadius: theme.radii.sm,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm + theme.spacing["2xs"],
    ...theme.shadows.sm,
  },
}));

function AssistantTurnResult(props: { readonly children: ReactNode }) {
  return <View style={styles.resultStretch}>{props.children}</View>;
}
