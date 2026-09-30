import { Pressable, TextInput, View } from "react-native";
import { SendHorizonalIcon } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { keyboardAppearance } from "../../../theme/tokens";
import {
  assistantComposerSendVisible,
  type AssistantExampleChip,
} from "./assistant-chrome";
import { AssistantExampleChips } from "./assistant-example-chips";

export function AssistantComposer(props: {
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly onSend: () => void;
  readonly placeholder: string;
  readonly accessibilityLabel: string;
  readonly sendLabel: string;
  readonly editable: boolean;
  readonly canSend: boolean;
  readonly exampleChips: readonly AssistantExampleChip[];
  readonly onSendExample: (text: string) => void;
}) {
  const { theme, rt } = useUnistyles();
  const showSend = assistantComposerSendVisible(props.value);
  const sendColor = props.canSend
    ? theme.colors.accentForeground
    : theme.colors.icon.muted;

  return (
    <>
      <AssistantExampleChips
        chips={props.exampleChips}
        layout="scroll"
        onSend={props.onSendExample}
      />
      <View style={styles.row}>
        <TextInput
          value={props.value}
          onChangeText={props.onChangeText}
          placeholder={props.placeholder}
          placeholderTextColor={theme.colors.icon.muted}
          accessibilityLabel={props.accessibilityLabel}
          editable={props.editable}
          returnKeyType="send"
          onSubmitEditing={props.onSend}
          style={styles.input}
          keyboardAppearance={keyboardAppearance(rt.themeName)}
        />
        {showSend ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={props.sendLabel}
            disabled={!props.canSend}
            onPress={props.onSend}
            style={({ pressed }) => [
              styles.send,
              props.canSend ? styles.sendReady : styles.sendDisabled,
              pressed && props.canSend ? styles.pressed : null,
            ]}
          >
            <SendHorizonalIcon size={theme.iconSize.sm} color={sendColor} />
          </Pressable>
        ) : null}
      </View>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: theme.spacing.sm,
  },
  input: {
    flex: 1,
    minHeight: theme.hitTarget.min,
    maxHeight: theme.hitTarget.lg * 2,
    borderRadius: theme.radii.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.inputFill,
    color: theme.colors.foreground,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    fontSize: theme.typography.base.fontSize,
    lineHeight: theme.typography.base.lineHeight,
  },
  send: {
    width: theme.hitTarget.min,
    height: theme.hitTarget.min,
    borderRadius: theme.radii.full,
    alignItems: "center",
    justifyContent: "center",
  },
  sendReady: {
    backgroundColor: theme.colors.accent,
    ...theme.shadows.accent,
  },
  sendDisabled: {
    backgroundColor: theme.colors.muted,
  },
  pressed: {
    opacity: theme.pressedOpacity,
  },
}));
