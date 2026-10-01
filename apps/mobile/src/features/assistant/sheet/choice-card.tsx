import { Pressable, Text, View } from "react-native";
import { CheckIcon } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import type { AssistantInteraction } from "@showzy/validation/assistant-chat";

import { Button, Card } from "../../../components/ui";
import {
  assistantChoiceCardModel,
  type AssistantChoiceCardCopy,
  type AssistantChoiceRow,
} from "./choice-card-model";

export type AssistantChoiceInteraction = Extract<
  AssistantInteraction,
  { kind: "choice" }
>;

export function ChoiceCard(props: {
  readonly interaction: AssistantChoiceInteraction;
  readonly applying: boolean;
  readonly answeredOptionId: string | null;
  readonly copy: AssistantChoiceCardCopy;
  readonly onPick: (optionId: string) => void;
  readonly onCompose: () => void;
  readonly onDismiss: () => void;
}) {
  const { applying, answeredOptionId, interaction } = props;

  const model = assistantChoiceCardModel({
    subject: interaction.subject,
    options: interaction.options,
    optionsTruncated: interaction.optionsTruncated,
    nearest: interaction.nearest,
    problem: interaction.problem,
    applying,
    answeredOptionId,
    copy: props.copy,
  });

  return (
    <Card>
      <View style={styles.body}>
        {model.eyebrow !== null ? (
          <Text style={styles.eyebrow}>{model.eyebrow}</Text>
        ) : null}
        <Text style={styles.title}>{model.title}</Text>
        {model.problem !== null ? (
          <View style={styles.problem}>
            <Text style={styles.problemText}>{model.problem}</Text>
          </View>
        ) : null}
        <View style={styles.options}>
          {model.rows.map((row) => (
            <ChoiceOptionRow
              key={row.optionId}
              row={row}
              chosenLabel={model.chosenLabel}
              onPick={() => {
                props.onPick(row.optionId);
              }}
            />
          ))}
        </View>
        {model.footnotes.map((footnote) => (
          <Text key={footnote} style={styles.footnote}>
            {footnote}
          </Text>
        ))}
        {model.composeLabel !== null && model.dismissLabel !== null ? (
          <View style={styles.actions}>
            <View style={styles.action}>
              <Button
                variant="secondary"
                fullWidth
                label={model.dismissLabel}
                onPress={props.onDismiss}
              />
            </View>
            <View style={styles.action}>
              <Button
                variant="secondary"
                fullWidth
                label={model.composeLabel}
                onPress={props.onCompose}
              />
            </View>
          </View>
        ) : null}
      </View>
    </Card>
  );
}

function ChoiceOptionRow(props: {
  readonly row: AssistantChoiceRow;
  readonly chosenLabel: string;
  readonly onPick: () => void;
}) {
  const { theme } = useUnistyles();
  const { row } = props;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        row.detail === null ? row.label : `${row.label} · ${row.detail}`
      }
      accessibilityState={{ disabled: !row.tappable, selected: row.chosen }}
      disabled={!row.tappable}
      onPress={props.onPick}
      style={({ pressed }) => [
        styles.option,
        row.chosen ? styles.optionChosen : null,
        pressed && row.tappable ? styles.pressed : null,
      ]}
    >
      <View style={row.create ? styles.markCreate : styles.mark}>
        <Text style={row.create ? styles.markCreateText : styles.markText}>
          {row.mark}
        </Text>
      </View>
      <View style={styles.optionBody}>
        <Text style={styles.optionLabel}>{row.label}</Text>
        {row.detail !== null ? (
          <Text style={styles.optionDetail}>{row.detail}</Text>
        ) : null}
      </View>
      {row.chosen ? (
        <CheckIcon
          size={theme.iconSize.sm}
          color={theme.colors.success}
          accessibilityLabel={props.chosenLabel}
        />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing.sm,
  },
  eyebrow: {
    color: theme.colors.accentFg,
    fontSize: theme.typography.xs.fontSize,
    lineHeight: theme.typography.xs.lineHeight,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.typography.base.fontSize,
    lineHeight: theme.typography.base.lineHeight,
    fontWeight: "600",
  },
  problem: {
    backgroundColor: theme.colors.destructiveSoft,
    borderRadius: theme.radii.md,
    ...theme.squircle,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  problemText: {
    color: theme.colors.destructive,
    fontSize: theme.typography.sm.fontSize,
    lineHeight: theme.typography.sm.lineHeight,
    fontWeight: "500",
  },
  options: {
    gap: theme.spacing.sm,
  },
  option: {
    minHeight: theme.hitTarget.min,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    borderRadius: theme.radii.md,
    ...theme.squircle,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  optionChosen: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.accentSoft,
  },
  pressed: {
    opacity: theme.pressedOpacity,
  },
  mark: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    borderRadius: theme.radii.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.muted,
  },
  markText: {
    color: theme.colors.mutedForeground,
    fontSize: theme.typography.xs.fontSize,
    lineHeight: theme.typography.xs.lineHeight,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  markCreate: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    borderRadius: theme.radii.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.accentSoft,
  },
  markCreateText: {
    color: theme.colors.accentFg,
    fontSize: theme.typography.xs.fontSize,
    lineHeight: theme.typography.xs.lineHeight,
    fontWeight: "700",
  },
  optionBody: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing["2xs"],
  },
  optionLabel: {
    color: theme.colors.foreground,
    fontSize: theme.typography.sm.fontSize,
    lineHeight: theme.typography.sm.lineHeight,
    fontWeight: "600",
  },
  optionDetail: {
    color: theme.colors.mutedForeground,
    fontSize: theme.typography.xs.fontSize,
    lineHeight: theme.typography.xs.lineHeight,
  },
  footnote: {
    color: theme.colors.mutedForeground,
    fontSize: theme.typography.xs.fontSize,
    lineHeight: theme.typography.xs.lineHeight,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
  },
  action: {
    flex: 1,
  },
}));
