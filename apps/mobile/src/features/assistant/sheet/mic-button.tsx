import { useEffect } from "react";
import { Pressable, View } from "react-native";
import { MicIcon, MicOffIcon } from "lucide-react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import type { VoiceLevelListener } from "../voice/use-voice-capture";
import { voiceMicActive, type VoiceMicMode } from "../voice/voice-composer";

const RING_MS = 120;
const RING_GAIN = 0.35;
const RING_REDUCED_SCALE = 1.08;

export function AssistantMicButton(props: {
  readonly mode: VoiceMicMode;
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
  readonly onLevel: (listener: VoiceLevelListener) => () => void;
}) {
  const { theme } = useUnistyles();
  const reduceMotion = useReducedMotion();
  const level = useSharedValue(0);
  const active = voiceMicActive(props.mode);
  const onLevel = props.onLevel;

  useEffect(() => {
    if (!active || reduceMotion) {
      level.set(0);
      return;
    }
    return onLevel((next) => {
      level.set(withTiming(next, { duration: RING_MS }));
    });
  }, [active, level, onLevel, reduceMotion]);

  const ringStyle = useAnimatedStyle(() => ({
    transform: [
      {
        scale: reduceMotion ? RING_REDUCED_SCALE : 1 + level.get() * RING_GAIN,
      },
    ],
  }));

  const denied = props.mode === "denied";
  const tint = active
    ? theme.colors.accentForeground
    : denied || props.disabled
      ? theme.colors.icon.muted
      : theme.colors.primaryForeground;

  return (
    <View style={styles.wrap}>
      {active ? <Animated.View style={[styles.ring, ringStyle]} /> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.label}
        accessibilityState={{ disabled: props.disabled, selected: active }}
        disabled={props.disabled}
        onPress={props.onPress}
        style={({ pressed }) => [
          styles.button,
          active ? styles.buttonActive : styles.buttonIdle,
          props.disabled || denied ? styles.buttonOff : null,
          pressed ? styles.pressed : null,
        ]}
      >
        {denied ? (
          <MicOffIcon size={theme.iconSize.md} color={tint} />
        ) : (
          <MicIcon size={theme.iconSize.md} color={tint} />
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  wrap: {
    position: "relative",
  },
  ring: {
    position: "absolute",
    top: -4,
    left: -4,
    right: -4,
    bottom: -4,
    borderRadius: theme.radii.full,
    borderWidth: 2,
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.accentSoft,
    pointerEvents: "none",
  },
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
