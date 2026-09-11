/**
 * The card for an open question, whichever kind it is.
 *
 * It renders what the question says and nothing else. The card it replaces took
 * the wire envelope and called three presenter functions to work out whether the
 * picker was still tappable, which option to offer as a retry, and whether a
 * `claimed` or `expired` status should show a note instead — protocol reasoning
 * inside a component, needed because the client had to guess what the server had
 * already done with a tap.
 *
 * None of that has a place here. A question that appears is answerable, because
 * the only source of one is the server's open pause; a question that has been
 * answered, dropped or expired simply is not in the window. A refused tap comes
 * back with the current question, so there is no retry state to hold either.
 */
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import type { AssistantInteraction } from "@showzy/validation/assistant-chat";

import { Button, Card } from "../../../components/ui";
import { ConfirmationCard } from "./confirmation-card";

export type InteractionCardCopy = {
  readonly choiceTitle: string;
  readonly choiceTruncated: string;
  readonly choiceSelecting: string;
  readonly confirmationTitle: string;
  readonly confirmLabel: string;
  readonly confirmingLabel: string;
  readonly dismissLabel: string;
};

export function InteractionCard(props: {
  readonly interaction: AssistantInteraction;
  /** A request is in flight. The same flag for every card: only one can run. */
  readonly applying: boolean;
  readonly copy: InteractionCardCopy;
  /** The shape belongs to the kind; the server checks it against that kind. */
  readonly onAnswer: (answer: unknown) => void;
  readonly onDismiss: () => void;
}) {
  const { interaction, copy } = props;

  if (interaction.kind === "confirmation") {
    return (
      <ConfirmationCard
        title={copy.confirmationTitle}
        summary={interaction.summary}
        confirmLabel={copy.confirmLabel}
        dismissLabel={copy.dismissLabel}
        confirmingLabel={copy.confirmingLabel}
        applying={props.applying}
        onConfirm={() => {
          // The only answer this kind has. Saying no is dropping the question.
          props.onAnswer({ approved: true });
        }}
        onDismiss={props.onDismiss}
      />
    );
  }

  return (
    <Card>
      <View style={styles.body}>
        <Text style={styles.title}>
          {interaction.subject.length > 0
            ? interaction.subject
            : copy.choiceTitle}
        </Text>
        {interaction.optionsTruncated ? (
          <Text style={styles.note}>{copy.choiceTruncated}</Text>
        ) : null}
        {props.applying ? (
          <Text style={styles.applying}>{copy.choiceSelecting}</Text>
        ) : (
          <View style={styles.options}>
            {interaction.options.map((option) => (
              <Button
                key={option.optionId}
                variant="secondary"
                fullWidth
                label={
                  option.detail === undefined
                    ? option.label
                    : `${option.label} · ${option.detail}`
                }
                onPress={() => {
                  props.onAnswer({ optionId: option.optionId });
                }}
              />
            ))}
          </View>
        )}
        {props.applying ? null : (
          <Button
            variant="secondary"
            fullWidth
            label={copy.dismissLabel}
            onPress={props.onDismiss}
          />
        )}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing.md,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.typography.base.fontSize,
    lineHeight: theme.typography.base.lineHeight,
    fontWeight: "600",
  },
  note: {
    color: theme.colors.mutedForeground,
    fontSize: theme.typography.sm.fontSize,
    lineHeight: theme.typography.sm.lineHeight,
  },
  applying: {
    color: theme.colors.mutedForeground,
    fontSize: theme.typography.sm.fontSize,
    lineHeight: theme.typography.sm.lineHeight,
    textAlign: "center",
    paddingVertical: theme.spacing.sm,
  },
  options: {
    gap: theme.spacing.sm,
  },
}));
