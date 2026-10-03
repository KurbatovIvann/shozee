import { useEffect } from "react";
import {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import type { SubscribeVoiceLevel } from "../voice/use-voice-capture";
import {
  voiceRingMotion,
  voiceRingOpacity,
  voiceRingScale,
  VOICE_RING_REST_SCALE,
} from "../voice/voice-composer";

const RING_RISE_MS = 90;

const RING_REST_MS = 220;

export function useMicLevelRing(input: {
  readonly active: boolean;
  readonly onLevel: SubscribeVoiceLevel;
}) {
  const motion = voiceRingMotion(useReducedMotion());
  const scale = useSharedValue(VOICE_RING_REST_SCALE);
  const glow = useSharedValue(0);
  const { active, onLevel } = input;

  useEffect(() => {
    if (!active) {
      scale.set(withTiming(VOICE_RING_REST_SCALE, { duration: RING_REST_MS }));
      glow.set(withTiming(0, { duration: RING_REST_MS }));
      return;
    }
    if (motion === "opacity") {
      scale.set(withTiming(VOICE_RING_REST_SCALE, { duration: RING_REST_MS }));
    }
    return onLevel((level) => {
      glow.set(withTiming(voiceRingOpacity(level), { duration: RING_RISE_MS }));
      if (motion === "opacity") {
        return;
      }
      scale.set(withTiming(voiceRingScale(level), { duration: RING_RISE_MS }));
    });
  }, [active, glow, motion, onLevel, scale]);

  return useAnimatedStyle(() => ({
    opacity: glow.get(),
    transform: [{ scale: scale.get() }],
  }));
}
