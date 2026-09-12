import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { CheckIcon, UserIcon } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { SearchField } from "./search-field";
import { Sheet } from "./sheet";
import {
  resolveOptionSelectListState,
  resolveQuerySelectMode,
  type OptionSelectItem,
} from "./option-select";

/**
 * Canvas `OptionSelectSheet`: full-height search + optional empty inherit
 * row, empty state, leading avatar, and multi-highlight via `selectedIds`.
 * `mode="content"` is the scrollable picker body without confirm-action chrome.
 * Feature policy (caps, copy, close-on-select callers) arrives via props.
 */
export function OptionSelectSheet(props: {
  readonly visible: boolean;
  readonly title: string;
  readonly searchPlaceholder: string;
  readonly searchLabel: string;
  readonly closeLabel: string;
  readonly value: string | null;
  readonly options: readonly OptionSelectItem[];
  readonly onClose: () => void;
  readonly onChange: (value: string | null) => void;
  readonly emptyOptionLabel?: string | undefined;
  readonly emptyLabel?: string | undefined;
  readonly searchMaxLength?: number | undefined;
  readonly selectedIds?: ReadonlySet<string> | undefined;
  readonly leading?: "user" | undefined;
  readonly query?: string | undefined;
  readonly onQueryChange?: ((value: string) => void) | undefined;
  readonly loadingMore?: boolean | undefined;
  readonly loadingMoreLabel?: string | undefined;
  readonly onEndReached?: (() => void) | undefined;
  readonly loadMoreLabel?: string | undefined;
}) {
  const { theme } = useUnistyles();
  const [localQuery, setLocalQuery] = useState("");
  const queryMode = resolveQuerySelectMode({
    query: props.query,
    onQueryChange: props.onQueryChange,
  });
  const serverFiltered = queryMode.controlled;
  const query = queryMode.controlled ? queryMode.query : localQuery;

  useEffect(() => {
    if (!props.visible && !serverFiltered) {
      setLocalQuery("");
    }
  }, [props.visible, serverFiltered]);

  function handleQueryChange(text: string): void {
    if (queryMode.controlled) {
      queryMode.onQueryChange(text);
      return;
    }
    setLocalQuery(text);
  }

  const listState = resolveOptionSelectListState({
    options: props.options,
    query,
    serverFiltered,
    loadingMore: props.loadingMore === true,
  });
  const emptyOptionLabel = props.emptyOptionLabel;
  const emptyLabel =
    props.emptyLabel != null && props.emptyLabel.length > 0
      ? props.emptyLabel
      : null;

  function choose(next: string | null): void {
    props.onChange(next);
    props.onClose();
  }

  return (
    <Sheet
      visible={props.visible}
      title={props.title}
      onClose={props.onClose}
      mode="content"
      fullHeight
      closeAccessibilityLabel={props.closeLabel}
    >
      <SearchField
        value={query}
        onChangeText={handleQueryChange}
        placeholder={props.searchPlaceholder}
        accessibilityLabel={props.searchLabel}
        {...(typeof props.searchMaxLength === "number"
          ? { maxLength: props.searchMaxLength }
          : {})}
      />
      <View style={styles.list}>
        {emptyOptionLabel != null && emptyOptionLabel.length > 0 ? (
          <OptionRow
            label={emptyOptionLabel}
            selected={props.value === null}
            onPress={() => {
              choose(null);
            }}
          />
        ) : null}
        {listState.kind === "loading" ? (
          <ActivityIndicator
            accessibilityLabel={props.loadingMoreLabel}
            color={theme.colors.mutedForeground}
          />
        ) : listState.kind === "empty" ? (
          emptyLabel !== null ? (
            <Text style={styles.empty}>{emptyLabel}</Text>
          ) : null
        ) : (
          listState.items.map((option) => (
            <OptionRow
              key={option.id}
              label={option.name}
              description={option.description}
              selected={
                props.selectedIds !== undefined
                  ? props.selectedIds.has(option.id)
                  : option.id === props.value
              }
              leading={props.leading}
              onPress={() => {
                choose(option.id);
              }}
            />
          ))
        )}
        {listState.kind === "items" && props.loadingMore === true ? (
          <ActivityIndicator
            accessibilityLabel={props.loadingMoreLabel}
            color={theme.colors.mutedForeground}
          />
        ) : null}
        {listState.kind === "items" &&
        props.loadingMore !== true &&
        props.onEndReached !== undefined &&
        props.loadMoreLabel !== undefined ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={props.loadMoreLabel}
            onPress={props.onEndReached}
            style={({ pressed }) => [
              styles.loadMore,
              pressed ? styles.pressed : null,
            ]}
          >
            <Text style={styles.loadMoreLabel}>{props.loadMoreLabel}</Text>
          </Pressable>
        ) : null}
      </View>
    </Sheet>
  );
}

function OptionRow(props: {
  readonly label: string;
  readonly description?: string | undefined;
  readonly selected: boolean;
  readonly leading?: "user" | undefined;
  readonly onPress: () => void;
}) {
  const { theme } = useUnistyles();
  const description =
    props.description != null && props.description.length > 0
      ? props.description
      : null;
  const a11yLabel =
    description !== null ? `${props.label}, ${description}` : props.label;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
      accessibilityState={{ selected: props.selected }}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.option,
        props.selected ? styles.optionSelected : null,
        pressed ? styles.pressed : null,
      ]}
    >
      {props.leading === "user" ? (
        <View style={styles.avatar}>
          <UserIcon size={theme.iconSize.md} color={theme.colors.accent} />
        </View>
      ) : null}
      <View style={styles.optionBody}>
        <Text style={styles.optionLabel}>{props.label}</Text>
        {description !== null ? (
          <Text style={styles.optionDescription}>{description}</Text>
        ) : null}
      </View>
      {props.selected ? (
        <View style={styles.check}>
          <CheckIcon
            size={theme.iconSize.sm}
            color={theme.colors.primaryForeground}
          />
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    gap: theme.spacing.sm,
  },
  empty: {
    color: theme.colors.mutedForeground,
    fontSize: theme.typography.sm.fontSize,
    lineHeight: theme.typography.sm.lineHeight,
    paddingVertical: theme.spacing.md,
  },
  option: {
    minHeight: theme.hitTarget.row - theme.spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    borderRadius: theme.radii.lg,
    ...theme.squircle,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.md,
  },
  avatar: {
    width: theme.hitTarget.min,
    height: theme.hitTarget.min,
    borderRadius: theme.radii.full,
    backgroundColor: theme.colors.accentSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  optionSelected: {
    borderColor: theme.colors.foreground,
    backgroundColor: theme.colors.inputFill,
  },
  optionBody: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing["2xs"],
  },
  optionLabel: {
    color: theme.colors.foreground,
    fontSize: theme.typography.base.fontSize,
    lineHeight: theme.typography.base.lineHeight,
    fontWeight: "600",
  },
  check: {
    // Canvas h-7 (28) — Class B from spacing, not a raw pixel.
    width: theme.spacing["2xl"] + theme.spacing.xs,
    height: theme.spacing["2xl"] + theme.spacing.xs,
    borderRadius: theme.radii.full,
    backgroundColor: theme.colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  optionDescription: {
    color: theme.colors.mutedForeground,
    fontSize: theme.typography.xs.fontSize,
    lineHeight: theme.typography.xs.lineHeight,
  },
  pressed: {
    opacity: 0.85,
  },
  loadMore: {
    minHeight: theme.hitTarget.min,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing.sm,
  },
  loadMoreLabel: {
    color: theme.colors.accent,
    fontSize: theme.typography.sm.fontSize,
    lineHeight: theme.typography.sm.lineHeight,
    fontWeight: "600",
  },
}));
