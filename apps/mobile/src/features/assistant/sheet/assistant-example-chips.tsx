import { ScrollView, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { ActionChip, inertHorizontalScrollProps } from "../../../components/ui";
import type { AssistantExampleChip } from "./assistant-chrome";

export function AssistantExampleChips(props: {
  readonly chips: readonly AssistantExampleChip[];
  readonly layout: "scroll" | "wrap";
  readonly onSend: (text: string) => void;
}) {
  if (props.chips.length === 0) {
    return null;
  }

  const wrap = props.layout === "wrap";
  const items = props.chips.map((chip) => (
    <ActionChip
      key={chip.key}
      label={chip.text}
      shrink={wrap}
      onPress={() => {
        props.onSend(chip.text);
      }}
    />
  ));

  if (wrap) {
    return (
      <View accessible={false} accessibilityRole="list" style={styles.wrap}>
        {items}
      </View>
    );
  }

  return (
    <ScrollView
      {...inertHorizontalScrollProps}
      accessible={false}
      accessibilityRole="list"
      keyboardShouldPersistTaps="handled"
      style={styles.strip}
      contentContainerStyle={styles.stripContent}
    >
      {items}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  wrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: theme.spacing.sm,
  },
  strip: {
    flexGrow: 0,
  },
  stripContent: {
    flexDirection: "row",
    gap: theme.spacing.sm,
    paddingBottom: theme.spacing.sm,
  },
}));
