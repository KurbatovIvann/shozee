import { useEffect } from "react";
import { Pressable, View } from "react-native";
import { MicIcon } from "lucide-react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import type { SubscribeVoiceLevel } from "../voice/use-voice-capture";
import {
  voiceMicActive,
  voiceRingScale,
  VOICE_RING_REST_SCALE,
  type VoiceMicMode,
} from "../voice/voice-composer";

const RING_RISE_MS = 90;

const RING_REST_MS = 220;

export function AssistantMicButton(props: {
  readonly mode: VoiceMicMode;
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
  readonly onLevel: SubscribeVoiceLevel | null;
}) {
  const { theme } = useUnistyles();
  const active = voiceMicActive(props.mode);
  const off = props.disabled || props.mode === "denied";
  const tint = active
    ? theme.colors.accentForeground
    : off
      ? theme.colors.icon.muted
      : theme.colors.primaryForeground;

  const scale = useSharedValue(VOICE_RING_REST_SCALE);
  const onLevel = props.onLevel;

  useEffect(() => {
    scale.value = withTiming(VOICE_RING_REST_SCALE, {
      duration: RING_REST_MS,
    });
    if (onLevel === null || !active) {
      return;
    }
    return onLevel((level) => {
      scale.value = withTiming(voiceRingScale({ active: true, level }), {
        duration: RING_RISE_MS,
      });
    });
  }, [active, onLevel, scale]);

  const ringStyle = useAnimatedStyle(() => ({
    opacity:
      scale.value <= VOICE_RING_REST_SCALE
        ? 0
        : Math.min(1, scale.value - VOICE_RING_REST_SCALE),
    transform: [{ scale: scale.value }],
  }));

  return (
    <View style={styles.slot}>
      <Animated.View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[styles.ring, ringStyle]}
      />
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
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  slot: {
    width: theme.hitTarget.min,
    height: theme.hitTarget.min,
    alignItems: "center",
    justifyContent: "center",
  },
  ring: {
    position: "absolute",
    width: theme.hitTarget.min,
    height: theme.hitTarget.min,
    borderRadius: theme.radii.full,
    borderWidth: 2,
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.accentSoft,
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
