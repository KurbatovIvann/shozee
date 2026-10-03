import type { RefObject } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { SendHorizonalIcon } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import type { AssistantVoiceCopy } from "../../../i18n/assistant";
import { keyboardAppearance } from "../../../theme/tokens";
import {
  voiceComposerPlaceholder,
  voiceComposerValue,
  voiceMicActive,
  type VoiceMicMode,
} from "../voice/voice-composer";
import {
  assistantComposerSendVisible,
  type AssistantExampleChip,
} from "./assistant-chrome";
import { AssistantExampleChips } from "./assistant-example-chips";
import { AssistantMicButton } from "./mic-button";

export type AssistantComposerVoice = {
  readonly mode: VoiceMicMode;
  readonly partial: string;
  readonly countdown: string | null;
  readonly countdownLabel: string | null;
  readonly canPress: boolean;
  readonly copy: AssistantVoiceCopy;
  readonly onToggle: () => void;
  readonly onRetry: () => void;
  readonly onSettings: () => void;
};

export function AssistantComposer(props: {
  readonly inputRef: RefObject<TextInput | null>;
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
  readonly voice: AssistantComposerVoice | null;
}) {
  const { theme, rt } = useUnistyles();
  const voice = props.voice;
  const mode: VoiceMicMode = voice?.mode ?? "idle";
  const dictating = voiceMicActive(mode);
  const showSend = !dictating && assistantComposerSendVisible(props.value);
  const editable = props.editable && !dictating;
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
      {voice !== null && mode === "denied" ? (
        <VoiceNotice
          message={voice.copy.deniedMessage}
          actionLabel={voice.copy.deniedAction}
          onAction={voice.onSettings}
        />
      ) : null}
      {voice !== null && mode === "error" ? (
        <VoiceNotice
          message={voice.copy.errorMessage}
          actionLabel={voice.copy.retry}
          onAction={voice.onRetry}
        />
      ) : null}
      <View style={styles.row}>
        <TextInput
          ref={props.inputRef}
          value={voiceComposerValue({
            mode,
            partial: voice?.partial ?? "",
            typed: props.value,
          })}
          onChangeText={props.onChangeText}
          placeholder={
            voice === null
              ? props.placeholder
              : voiceComposerPlaceholder({
                  mode,
                  listening: voice.copy.listening,
                  recognizing: voice.copy.recognizing,
                  idle: props.placeholder,
                })
          }
          placeholderTextColor={theme.colors.icon.muted}
          accessibilityLabel={props.accessibilityLabel}
          editable={editable}
          returnKeyType="send"
          onSubmitEditing={props.onSend}
          style={styles.input}
          keyboardAppearance={keyboardAppearance(rt.themeName)}
        />
        {voice !== null && voice.countdown !== null ? (
          <Text
            style={styles.countdown}
            accessibilityLabel={voice.countdownLabel ?? voice.countdown}
          >
            {voice.countdown}
          </Text>
        ) : null}
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
        {voice !== null && !showSend ? (
          <AssistantMicButton
            mode={mode}
            label={dictating ? voice.copy.stop : voice.copy.start}
            disabled={!voice.canPress}
            onPress={voice.onToggle}
          />
        ) : null}
      </View>
    </>
  );
}

function VoiceNotice(props: {
  readonly message: string;
  readonly actionLabel: string;
  readonly onAction: () => void;
}) {
  return (
    <View style={styles.notice}>
      <Text style={styles.noticeText}>{props.message}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.actionLabel}
        onPress={props.onAction}
        style={({ pressed }) => [pressed ? styles.pressed : null]}
      >
        <Text style={styles.noticeAction}>{props.actionLabel}</Text>
      </Pressable>
    </View>
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
  countdown: {
    alignSelf: "center",
    color: theme.colors.mutedForeground,
    fontSize: theme.typography.sm.fontSize,
    lineHeight: theme.typography.sm.lineHeight,
    fontVariant: ["tabular-nums"],
  },
  notice: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.sm,
    paddingBottom: theme.spacing.sm,
  },
  noticeText: {
    flexShrink: 1,
    color: theme.colors.mutedForeground,
    fontSize: theme.typography.sm.fontSize,
    lineHeight: theme.typography.sm.lineHeight,
  },
  noticeAction: {
    color: theme.colors.accent,
    fontSize: theme.typography.sm.fontSize,
    lineHeight: theme.typography.sm.lineHeight,
    fontWeight: "600",
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
