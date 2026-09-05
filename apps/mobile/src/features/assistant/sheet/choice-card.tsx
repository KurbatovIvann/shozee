import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { Button, Card } from "../../../components/ui";
import {
  claimedOptionLabel,
  type StaffAssistantChoiceCardEnvelope,
} from "../shared/choice";
import {
  choiceCardOfferedOptions,
  choiceCardRetryOptionId,
  type ChoiceAttemptedOption,
} from "../shared/choice-presenter";

export function ChoiceCard(props: {
  readonly title: string;
  readonly truncatedLabel: string | null;
  readonly expiredLabel: string;
  readonly claimedLabel: string;
  readonly retryLabel: string;
  readonly selectingLabel: string;
  readonly applying: boolean;
  readonly choice: StaffAssistantChoiceCardEnvelope;
  readonly attempted: ChoiceAttemptedOption | null;
  readonly onSelect: (optionId: string) => void;
}) {
  const retryOptionId = choiceCardRetryOptionId({
    choice: props.choice,
    attempted: props.attempted,
  });
  const offeredOptions = choiceCardOfferedOptions({
    choice: props.choice,
    attempted: props.attempted,
  });
  const claimed = props.choice.status === "claimed";
  const expired = props.choice.status === "expired";
  const pickerTappable =
    props.choice.status === "needs_choice" &&
    !props.applying &&
    retryOptionId === undefined;
  const selectedLabel =
    claimedOptionLabel(props.choice) ??
    (retryOptionId === undefined
      ? undefined
      : props.choice.options.find((option) => option.id === retryOptionId)
          ?.label);

  return (
    <Card>
      <View style={styles.body}>
        <Text style={styles.title}>{props.title}</Text>
        {props.truncatedLabel !== null && !claimed && !expired ? (
          <Text style={styles.note}>{props.truncatedLabel}</Text>
        ) : null}
        {expired ? <Text style={styles.note}>{props.expiredLabel}</Text> : null}
        {claimed ? <Text style={styles.note}>{props.claimedLabel}</Text> : null}
        {selectedLabel !== undefined && retryOptionId !== undefined ? (
          <Text style={styles.selected}>{selectedLabel}</Text>
        ) : null}
        {props.applying ? (
          <Text style={styles.applying}>{props.selectingLabel}</Text>
        ) : pickerTappable ? (
          <View style={styles.options}>
            {offeredOptions.map((option) => (
              <Button
                key={option.id}
                variant="secondary"
                fullWidth
                label={option.label}
                onPress={() => {
                  props.onSelect(option.id);
                }}
              />
            ))}
          </View>
        ) : retryOptionId !== undefined ? (
          <Button
            fullWidth
            label={props.retryLabel}
            onPress={() => {
              props.onSelect(retryOptionId);
            }}
          />
        ) : null}
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
  selected: {
    color: theme.colors.foreground,
    fontSize: theme.typography.sm.fontSize,
    lineHeight: theme.typography.sm.lineHeight,
    fontWeight: "600",
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
