import { useCallback, useRef } from "react";
import { Text, View } from "react-native";
import {
  FlashList,
  type FlashListRef,
  type ListRenderItem,
} from "@shopify/flash-list";
import { WifiOffIcon } from "lucide-react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { SafeAreaView } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { AppHeader, Banner, EmptyState } from "../../../components/ui";
import type { AssistantCopy } from "../../../i18n/assistant";
import type { AssistantVisibleRow } from "../shared/chat-rows";
import type { ChoiceAttemptedOption } from "../shared/choice-presenter";
import {
  assistantShozikPose,
  SHOZIK_EMPTY_POSE_SIZE,
  SHOZIK_HEADER_POSE_SIZE,
} from "./assistant-chrome";
import { AssistantComposer } from "./assistant-composer";
import { AssistantMessageRow } from "./assistant-message-row";
import { ShozikPoseMark } from "./shozik-pose-mark";

export type AssistantSheetViewModel = {
  readonly copy: AssistantCopy;
  readonly rows: readonly AssistantVisibleRow[];
  readonly input: string;
  readonly changeInput: (value: string) => void;
  readonly send: () => void;
  readonly confirm: () => void;
  readonly dismiss: () => void;
  readonly selectChoice: (optionId: string) => void;
  readonly openHref: (href: string) => void;
  readonly busy: boolean;
  readonly thinking: boolean;
  readonly hasInFlightTools: boolean;
  readonly confirmationApplying: boolean;
  readonly choiceApplying: boolean;
  readonly choiceAttempted: ChoiceAttemptedOption | null;
  readonly canSend: boolean;
  readonly banner: string | null;
};

function keyExtractor(item: AssistantVisibleRow): string {
  return item.id;
}

function itemType(item: AssistantVisibleRow): string {
  if (item.role === "user") {
    return "user";
  }
  if (item.waiting) {
    return "assistant-wait";
  }
  if (item.surfaces.length > 0) {
    return "assistant-cards";
  }
  if (item.confirmation !== null) {
    return "assistant-confirm";
  }
  if (item.choice !== null) {
    return "assistant-choice";
  }
  return "assistant";
}

export function AssistantSheetView(model: AssistantSheetViewModel) {
  const { copy } = model;
  const listRef = useRef<FlashListRef<AssistantVisibleRow>>(null);

  const renderItem: ListRenderItem<AssistantVisibleRow> = useCallback(
    ({ item }) => (
      <AssistantMessageRow
        role={item.role}
        text={item.text}
        waiting={item.waiting}
        waitLines={copy.waitLines}
        waitIntervalMs={copy.waitIntervalMs}
        waitLabel={copy.waitLabel}
        surfaces={item.surfaces}
        onOpenHref={model.openHref}
        confirmationSummary={
          item.confirmation === null ? null : item.confirmation.summary
        }
        confirmationTitle={copy.confirmationTitle}
        confirmLabel={copy.confirmLabel}
        dismissLabel={copy.dismissLabel}
        confirmingLabel={copy.confirmingLabel}
        confirmationApplying={model.confirmationApplying}
        onConfirm={model.confirm}
        onDismiss={model.dismiss}
        choice={item.choice}
        choiceTitle={
          item.choice?.productName !== undefined &&
          item.choice.productName.length > 0
            ? item.choice.productName
            : copy.choiceTitle
        }
        choiceTruncatedLabel={
          item.choice?.status === "needs_choice" && item.choice.optionsTruncated
            ? item.choice.choiceKind === "product" ||
              item.choice.choiceKind === "customer"
              ? copy.choiceTruncatedMatch
              : copy.choiceTruncated
            : null
        }
        choiceExpiredLabel={copy.choiceExpired}
        choiceClaimedLabel={copy.choiceClaimed}
        choiceRetryLabel={copy.choiceRetry}
        choiceSelectingLabel={copy.choiceSelecting}
        choiceApplying={model.choiceApplying}
        choiceAttempted={model.choiceAttempted}
        onSelectChoice={model.selectChoice}
      />
    ),
    [
      copy.choiceClaimed,
      copy.choiceExpired,
      copy.choiceRetry,
      copy.choiceSelecting,
      copy.choiceTitle,
      copy.choiceTruncated,
      copy.choiceTruncatedMatch,
      copy.confirmLabel,
      copy.confirmationTitle,
      copy.confirmingLabel,
      copy.dismissLabel,
      copy.waitIntervalMs,
      copy.waitLabel,
      copy.waitLines,
      model.choiceApplying,
      model.choiceAttempted,
      model.confirm,
      model.confirmationApplying,
      model.dismiss,
      model.openHref,
      model.selectChoice,
    ],
  );

  const showEmpty = model.rows.length === 0 && !model.thinking;
  const headerPose = assistantShozikPose({
    thinking: model.thinking,
    hasInFlightTools: model.hasInFlightTools,
  });

  return (
    <SafeAreaView
      edges={["top"]}
      accessibilityLabel={copy.sheetTitle}
      style={styles.screen}
    >
      <KeyboardAvoidingView style={styles.flex} behavior="padding">
        <AppHeader
          title={copy.sheetTitle}
          leading={
            <ShozikPoseMark pose={headerPose} size={SHOZIK_HEADER_POSE_SIZE} />
          }
        />
        {model.banner !== null ? (
          <View style={styles.banner}>
            <Banner message={model.banner} />
          </View>
        ) : null}
        {showEmpty ? (
          <View style={styles.empty}>
            <ShozikPoseMark pose="sit" size={SHOZIK_EMPTY_POSE_SIZE} />
            <Text style={styles.emptyTitle}>{copy.emptyTitle}</Text>
            <Text style={styles.emptyDescription}>{copy.emptyDescription}</Text>
          </View>
        ) : (
          <FlashList
            ref={listRef}
            data={model.rows}
            style={styles.list}
            keyExtractor={keyExtractor}
            renderItem={renderItem}
            getItemType={itemType}
            contentContainerStyle={styles.listContent}
            onContentSizeChange={() => {
              listRef.current?.scrollToEnd({ animated: true });
            }}
          />
        )}
        <View style={styles.composer}>
          <AssistantComposer
            value={model.input}
            onChangeText={model.changeInput}
            onSend={model.send}
            placeholder={copy.inputPlaceholder}
            accessibilityLabel={copy.inputLabel}
            sendLabel={copy.sendLabel}
            editable={!model.busy}
            canSend={model.canSend}
          />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export function AssistantUnavailableView(props: {
  readonly title: string;
  readonly description: string;
}) {
  const { theme } = useUnistyles();
  return (
    <SafeAreaView edges={["top"]} style={styles.screen}>
      <View style={styles.unavailable}>
        <EmptyState
          icon={
            <WifiOffIcon
              size={theme.iconSize.md}
              color={theme.colors.mutedForeground}
            />
          }
          title={props.title}
          description={props.description}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  flex: {
    flex: 1,
  },
  banner: {
    paddingHorizontal: theme.spacing.lg,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
  },
  composer: {
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.md,
    backgroundColor: theme.colors.card,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  unavailable: {
    flex: 1,
    justifyContent: "center",
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.md,
    paddingHorizontal: theme.spacing["2xl"],
  },
  emptyTitle: {
    color: theme.colors.foreground,
    textAlign: "center",
    fontSize: theme.typography.xl.fontSize,
    lineHeight: theme.typography.xl.lineHeight,
    fontWeight: "600",
  },
  emptyDescription: {
    color: theme.colors.mutedForeground,
    textAlign: "center",
    fontSize: theme.typography.sm.fontSize,
    lineHeight: theme.typography.sm.lineHeight,
  },
}));
