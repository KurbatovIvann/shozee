import { memo, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { CheckIcon, ChevronRightIcon } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import {
  Button,
  resolveQuerySelectMode,
  SearchField,
  Sheet,
} from "../../../components/ui";
import { interpolate } from "../../../i18n/locale";
import { OrderThumbnail } from "../shared/order-thumbnail";
import {
  visibleProductSelectRows,
  type ProductSelectLevel,
  type ProductSelectRow,
  type ProductSelectVariantRow,
  type ProductVariantsLoadStatus,
} from "./product-select";

/**
 * Canvas `ProductSelectSheet`: multi-toggle, ink check, 44×44 thumbnail,
 * confirm footer. Variant drill-down replaces the product list in the
 * same Modal (SHO-249) — never a second Sheet. Closed sessions skip
 * catalog filter/map work (SHO-305). Sheet content mode already wraps
 * KeyboardAwareScrollView, so this list stays mapped `memo` rows rather
 * than a nested FlashList.
 */
export function ProductSelectSheet(props: {
  readonly visible: boolean;
  readonly sessionOpen: boolean;
  readonly level: ProductSelectLevel;
  readonly title: string;
  readonly variantsTitle: string;
  readonly searchPlaceholder: string;
  readonly searchLabel: string;
  readonly closeLabel: string;
  readonly backLabel: string;
  readonly emptyLabel: string;
  readonly variantsLoadingLabel: string;
  readonly variantsEmptyLabel: string;
  readonly variantsErrorLabel: string;
  readonly doneLabel: string;
  readonly thumbnailFailedLabel: string;
  readonly searchMaxLength: number;
  readonly selectedIds: ReadonlySet<string>;
  readonly selectedVariantIds: ReadonlySet<string>;
  readonly doneCount: number;
  readonly products: readonly ProductSelectRow[];
  readonly variants: readonly ProductSelectVariantRow[];
  readonly variantsStatus: ProductVariantsLoadStatus;
  readonly onClose: () => void;
  readonly onBack: () => void;
  readonly onToggle: (productId: string) => void;
  readonly onToggleVariant: (variantId: string) => void;
  readonly onConfirm: () => void;
  readonly query?: string | undefined;
  readonly onQueryChange?: ((value: string) => void) | undefined;
  readonly loadingMore?: boolean | undefined;
  readonly loadingMoreLabel?: string | undefined;
  readonly onEndReached?: (() => void) | undefined;
  readonly loadMoreLabel?: string | undefined;
}) {
  const { theme } = useUnistyles();
  const [localQuery, setLocalQuery] = useState("");
  const variantsOpen = props.level === "variants";
  const queryMode = resolveQuerySelectMode({
    query: props.query,
    onQueryChange: props.onQueryChange,
  });
  const serverFiltered = queryMode.controlled;
  const query = queryMode.controlled ? queryMode.query : localQuery;

  useEffect(() => {
    if (!props.sessionOpen && !serverFiltered) {
      setLocalQuery("");
    }
  }, [props.sessionOpen, serverFiltered]);

  function handleQueryChange(text: string): void {
    if (queryMode.controlled) {
      queryMode.onQueryChange(text);
      return;
    }
    setLocalQuery(text);
  }

  const filtered = useMemo(
    () =>
      visibleProductSelectRows({
        products: props.products,
        query,
        sessionOpen: props.sessionOpen,
        serverFiltered,
      }),
    [props.products, props.sessionOpen, query, serverFiltered],
  );

  return (
    <Sheet
      visible={props.visible}
      title={variantsOpen ? props.variantsTitle : props.title}
      onClose={props.onClose}
      mode="content"
      fullHeight
      closeAccessibilityLabel={props.closeLabel}
      back={
        variantsOpen
          ? {
              onPress: props.onBack,
              accessibilityLabel: props.backLabel,
            }
          : undefined
      }
      footer={
        <Button
          fullWidth
          label={interpolate(props.doneLabel, {
            count: String(props.doneCount),
          })}
          onPress={props.onConfirm}
        />
      }
    >
      {props.sessionOpen ? (
        variantsOpen ? (
          <VariantsLevel
            variants={props.variants}
            status={props.variantsStatus}
            selectedIds={props.selectedVariantIds}
            loadingLabel={props.variantsLoadingLabel}
            emptyLabel={props.variantsEmptyLabel}
            errorLabel={props.variantsErrorLabel}
            onToggle={props.onToggleVariant}
          />
        ) : (
          <>
            <SearchField
              value={query}
              onChangeText={handleQueryChange}
              placeholder={props.searchPlaceholder}
              accessibilityLabel={props.searchLabel}
              maxLength={props.searchMaxLength}
            />
            <View style={styles.list}>
              {filtered.length === 0 ? (
                <Text style={styles.empty}>{props.emptyLabel}</Text>
              ) : (
                filtered.map((product) => (
                  <ProductPickerRow
                    key={product.id}
                    id={product.id}
                    name={product.name}
                    hasVariants={product.hasVariants}
                    variantsLabel={product.variantsLabel}
                    thumbnailFileId={product.thumbnailFileId}
                    thumbnailUrl={product.thumbnailUrl}
                    thumbnailFailed={product.thumbnailFailed}
                    selected={props.selectedIds.has(product.id)}
                    failedLabel={props.thumbnailFailedLabel}
                    onPress={props.onToggle}
                  />
                ))
              )}
              {filtered.length > 0 && props.loadingMore === true ? (
                <ActivityIndicator
                  accessibilityLabel={props.loadingMoreLabel}
                  color={theme.colors.mutedForeground}
                />
              ) : null}
              {filtered.length > 0 &&
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
                  <Text style={styles.loadMoreLabel}>
                    {props.loadMoreLabel}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          </>
        )
      ) : null}
    </Sheet>
  );
}

function VariantsLevel(props: {
  readonly variants: readonly ProductSelectVariantRow[];
  readonly status: ProductVariantsLoadStatus;
  readonly selectedIds: ReadonlySet<string>;
  readonly loadingLabel: string;
  readonly emptyLabel: string;
  readonly errorLabel: string;
  readonly onToggle: (variantId: string) => void;
}) {
  if (props.status === "loading" || props.status === "idle") {
    return <Text style={styles.empty}>{props.loadingLabel}</Text>;
  }
  if (props.status === "error") {
    return <Text style={styles.empty}>{props.errorLabel}</Text>;
  }
  if (props.variants.length === 0) {
    return <Text style={styles.empty}>{props.emptyLabel}</Text>;
  }
  return (
    <View style={styles.list}>
      {props.variants.map((variant) => (
        <VariantPickerRow
          key={variant.id}
          id={variant.id}
          name={variant.name}
          selected={props.selectedIds.has(variant.id)}
          onPress={props.onToggle}
        />
      ))}
    </View>
  );
}

const ProductPickerRow = memo(function ProductPickerRow(props: {
  readonly id: string;
  readonly name: string;
  readonly hasVariants: boolean;
  readonly variantsLabel: string;
  readonly thumbnailFileId: string | null;
  readonly thumbnailUrl: string | null;
  readonly thumbnailFailed: boolean;
  readonly selected: boolean;
  readonly failedLabel: string;
  readonly onPress: (id: string) => void;
}) {
  const { theme } = useUnistyles();
  const showCheck = props.selected;
  const showChevron = props.hasVariants;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.name}
      accessibilityState={{ selected: props.selected }}
      onPress={() => {
        props.onPress(props.id);
      }}
      style={({ pressed }) => [
        styles.option,
        props.selected ? styles.optionSelected : null,
        pressed ? styles.pressed : null,
      ]}
    >
      <OrderThumbnail
        fileId={props.thumbnailFileId}
        url={props.thumbnailUrl}
        failed={props.thumbnailFailed}
        failedLabel={props.failedLabel}
      />
      <View style={styles.optionBody}>
        <Text style={styles.optionLabel}>{props.name}</Text>
        <Text style={styles.optionDescription}>{props.variantsLabel}</Text>
      </View>
      {showCheck ? (
        <View style={styles.check}>
          <CheckIcon
            size={theme.iconSize.sm}
            color={theme.colors.primaryForeground}
          />
        </View>
      ) : null}
      {showChevron ? (
        <ChevronRightIcon
          size={theme.iconSize.sm}
          color={theme.colors.mutedForeground}
        />
      ) : null}
    </Pressable>
  );
});

const VariantPickerRow = memo(function VariantPickerRow(props: {
  readonly id: string;
  readonly name: string;
  readonly selected: boolean;
  readonly onPress: (id: string) => void;
}) {
  const { theme } = useUnistyles();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.name}
      accessibilityState={{ selected: props.selected }}
      onPress={() => {
        props.onPress(props.id);
      }}
      style={({ pressed }) => [
        styles.option,
        props.selected ? styles.optionSelected : null,
        pressed ? styles.pressed : null,
      ]}
    >
      <View style={styles.optionBody}>
        <Text style={styles.optionLabel}>{props.name}</Text>
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
});

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
  optionDescription: {
    color: theme.colors.mutedForeground,
    fontSize: theme.typography.xs.fontSize,
    lineHeight: theme.typography.xs.lineHeight,
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
