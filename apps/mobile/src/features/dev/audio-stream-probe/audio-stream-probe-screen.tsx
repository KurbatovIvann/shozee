import { ScrollView, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { SafeAreaView } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";

import { Button } from "../../../components/ui";
import { useAudioStreamProbe } from "./use-audio-stream-probe";

export function AudioStreamProbeScreen() {
  const probe = useAudioStreamProbe();

  return (
    <SafeAreaView edges={["top", "bottom"]} style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>expo-audio AudioStream probe</Text>
        <View style={styles.actions}>
          <Button
            label={probe.running ? "Running" : "Start"}
            onPress={probe.start}
            disabled={probe.running}
          />
          <Button
            label="Stop"
            variant="secondary"
            onPress={probe.stop}
            disabled={!probe.running}
          />
          <Button
            label="Copy"
            variant="ghost"
            onPress={() => {
              void Clipboard.setStringAsync(probe.report);
            }}
          />
        </View>
        <Text selectable style={styles.report}>
          {probe.report}
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: theme.spacing.lg, gap: theme.spacing.sm },
  title: { ...theme.typography.title, color: theme.colors.foreground },
  actions: {
    flexDirection: "row",
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.md,
  },
  report: {
    ...theme.typography.sm,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.card,
    borderRadius: theme.radii.md,
    padding: theme.spacing.md,
  },
}));
