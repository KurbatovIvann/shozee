import { View } from "react-native";
import { Image } from "expo-image";
import { StyleSheet } from "react-native-unistyles";

import sitMark from "../../../../assets/sit.svg";
import listenMark from "../../../../assets/listen.svg";
import digMark from "../../../../assets/dig.svg";
import type { AssistantShozikPose } from "./assistant-chrome";

const poseSource = {
  sit: sitMark,
  listen: listenMark,
  dig: digMark,
} as const;

/**
 * Local Shozik artwork for conversation chrome. Header and first-run
 * empty use sit/dig; the in-thread wait chip uses `dig.svg` while the
 * live turn is in flight. Do not hotlink Magic Patterns CDN images.
 */
export function ShozikPoseMark(props: {
  readonly pose: AssistantShozikPose;
  readonly size: number;
}) {
  return (
    <View
      style={[styles.clip, { width: props.size, height: props.size }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Image
        source={poseSource[props.pose]}
        style={{ width: props.size, height: props.size }}
        contentFit="contain"
        accessible={false}
        accessibilityIgnoresInvertColors
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  clip: {
    overflow: "hidden",
    borderRadius: theme.radii.full,
  },
}));
