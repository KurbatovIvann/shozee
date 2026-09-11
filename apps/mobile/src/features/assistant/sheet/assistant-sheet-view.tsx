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
import type { AssistantThreadRow } from "../thread/thread-rows";
import {
  assistantShozikPose,
  SHOZIK_EMPTY_POSE_SIZE,
  SHOZIK_HEADER_POSE_SIZE,
  SHOZIK_WAIT_POSE_SIZE,
} from "./assistant-chrome";
import { AssistantComposer } from "./assistant-composer";
import { AssistantMessageRow } from "./assistant-message-row";
import {
  ASSISTANT_THREAD_START,
  assistantThreadFollow,
} from "./assistant-thread-follow";
import { ShozikPoseMark } from "./shozik-pose-mark";

/**
 * One `busy` flag replaces `confirmationApplying`, `choiceApplying` and
 * `hasInFlightTools`. The stored log holds only settled messages, so there
 * is no per-row in-flight state to show; and only one request can run at a time,
 * so there is no per-card one either.
 *
 * `answer` replaces `confirm` and `selectChoice`. What a valid answer looks like
 * belongs to the question's kind, not to the screen.
 */
export type AssistantSheetViewModel = {
  readonly copy: AssistantCopy;
  readonly rows: readonly AssistantThreadRow[];
  readonly input: string;
  readonly changeInput: (value: string) => void;
  readonly send: () => void;
  readonly answer: (answer: unknown) => void;
  readonly dismiss: () => void;
  readonly openHref: (href: string) => void;
  readonly busy: boolean;
  readonly thinking: boolean;
  readonly canSend: boolean;
  readonly banner: string | null;
  /**
   * The thread is a window onto a longer conversation. Reaching its top asks
   * for the page before; nothing happens when there is none.
   */
  readonly loadOlder: () => void;
  readonly loadingOlder: boolean;
};

function keyExtractor(item: AssistantThreadRow): string {
  return item.id;
}

function itemType(item: AssistantThreadRow): string {
  if (item.role === "user") {
    return "user";
  }
  if (item.waiting) {
    return "assistant-wait";
  }
  if (item.surfaces.length > 0) {
    return "assistant-cards";
  }
  if (item.interaction !== null) {
    return "assistant-question";
  }
  return "assistant";
}

export function AssistantSheetView(model: AssistantSheetViewModel) {
  const { copy, rows } = model;
  const listRef = useRef<FlashListRef<AssistantThreadRow>>(null);
  const edgesRef = useRef(ASSISTANT_THREAD_START);

  // FlashList keeps an older page from moving what is on screen on its own;
  // this only decides when to bring the thread back down to its end.
  const followThread = useCallback(() => {
    const next = assistantThreadFollow(edgesRef.current, rows);
    edgesRef.current = next.edges;
    if (next.scrollToEnd) {
      listRef.current?.scrollToEnd({ animated: true });
    }
  }, [rows]);

  const renderItem: ListRenderItem<AssistantThreadRow> = useCallback(
    ({ item }) => (
      <AssistantMessageRow
        role={item.role}
        text={item.text}
        waiting={item.waiting}
        waitLines={copy.waitLines}
        waitIntervalMs={copy.waitIntervalMs}
        waitLabel={copy.waitLabel}
        surfaces={item.surfaces}
        failed={item.failed}
        failedLabel={copy.turnInterrupted}
        onOpenHref={model.openHref}
        interaction={item.interaction}
        applying={model.busy}
        interactionCopy={copy}
        onAnswer={model.answer}
        onDismiss={model.dismiss}
      />
    ),
    [copy, model.answer, model.busy, model.dismiss, model.openHref],
  );

  const showEmpty = model.rows.length === 0 && !model.thinking;
  const headerPose = assistantShozikPose({ thinking: model.thinking });

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
            data={rows}
            style={styles.list}
            keyExtractor={keyExtractor}
            renderItem={renderItem}
            getItemType={itemType}
            contentContainerStyle={styles.listContent}
            onContentSizeChange={followThread}
            onStartReached={model.loadOlder}
            ListHeaderComponent={
              // The same dig pose the wait line uses, not a spinner (SHO-394):
              // one mark for "Shozik is fetching", wherever it happens.
              model.loadingOlder ? (
                <View style={styles.older}>
                  <ShozikPoseMark pose="dig" size={SHOZIK_WAIT_POSE_SIZE} />
                </View>
              ) : null
            }
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
  older: {
    alignItems: "center",
    paddingVertical: theme.spacing.sm,
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
