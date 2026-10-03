import { Pressable } from "react-native";
import { MicIcon } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { voiceMicActive, type VoiceMicMode } from "../voice/voice-composer";

export function AssistantMicButton(props: {
  readonly mode: VoiceMicMode;
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  const { theme } = useUnistyles();
  const active = voiceMicActive(props.mode);
  const off = props.disabled || props.mode === "denied";
  const tint = active
    ? theme.colors.accentForeground
    : off
      ? theme.colors.icon.muted
      : theme.colors.primaryForeground;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled, selected: active }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.button,
        active ? styles.buttonActive : styles.buttonIdle,
        off ? styles.buttonOff : null,
        pressed ? styles.pressed : null,
      ]}
    >
      <MicIcon size={theme.iconSize.md} color={tint} />
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  button: {
    width: theme.hitTarget.min,
    height: theme.hitTarget.min,
    borderRadius: theme.radii.full,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonIdle: {
    backgroundColor: theme.colors.primary,
  },
  buttonActive: {
    backgroundColor: theme.colors.accent,
    ...theme.shadows.accent,
  },
  buttonOff: {
    backgroundColor: theme.colors.muted,
  },
  pressed: {
    opacity: theme.pressedOpacity,
  },
}));
