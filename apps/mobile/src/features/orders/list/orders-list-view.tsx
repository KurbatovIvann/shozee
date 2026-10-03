import { useCallback } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import {
  PlusIcon,
  SearchIcon,
  ShoppingBagIcon,
  SlidersHorizontalIcon,
  WifiOffIcon,
} from "lucide-react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import {
  AppHeader,
  Button,
  EmptyState,
  IconButton,
  ListRow,
  ListSurface,
  SearchField,
} from "../../../components/ui";
import { interpolate } from "../../../i18n/locale";
import { OrderRow, OrderRowSkeleton } from "./order-row";
import { OrdersFilterSheet } from "./orders-filter-sheet";
import {
  orderGroupHeaderLabel,
  orderListGroupEdge,
  type OrdersListEntry,
} from "./orders-list.presenter";
import type { OrdersListModel } from "./use-orders-list";

const SKELETON_ROWS = [0, 1, 2, 3, 4] as const;

export function OrdersListView(model: OrdersListModel) {
  const { theme } = useUnistyles();
  const { copy, openOrder, entries } = model;
  const filterActive = model.filterCount > 0;
  const filterLabel =
    model.filterCount > 0
      ? interpolate(copy.filterActiveLabel, {
          count: String(model.filterCount),
        })
      : copy.filterLabel;

  const renderItem: ListRenderItem<OrdersListEntry> = useCallback(
    ({ item, index }) => {
      if (item.type === "header") {
        return (
          <View style={styles.groupHeader}>
            <Text accessibilityRole="header" style={styles.groupHeaderLabel}>
              {orderGroupHeaderLabel(item.key, item.count, copy)}
            </Text>
          </View>
        );
      }
      const groupEdge = orderListGroupEdge(entries, index) ?? "middle";
      return (
        <ListRow groupEdge={groupEdge}>
          <OrderRow
            id={item.order.id}
            customerName={item.order.customerName}
            statusLabel={item.order.statusLabel}
            statusTone={item.order.statusTone}
            metaLabel={item.order.metaLabel}
            totalLabel={item.order.totalLabel}
            onPress={openOrder}
          />
        </ListRow>
      );
    },
    [copy, entries, openOrder],
  );

  return (
    <SafeAreaView
      edges={["top"]}
      accessibilityLabel={copy.title}
      style={styles.screen}
    >
      <AppHeader
        title={copy.title}
        subtitle={model.companyName}
        actions={
          model.showCreate ? (
            <IconButton
              icon={
                <PlusIcon
                  size={theme.iconSize.md}
                  color={theme.colors.primaryForeground}
                />
              }
              accessibilityLabel={copy.createLabel}
              onPress={model.openCreate}
            />
          ) : undefined
        }
      />
      <View style={styles.controls}>
        <View style={styles.searchSlot}>
          <SearchField
            value={model.searchText}
            onChangeText={model.changeSearch}
            placeholder={copy.searchPlaceholder}
            accessibilityLabel={copy.searchLabel}
            maxLength={model.searchMaxLength}
          />
        </View>
        <View>
          <IconButton
            variant={filterActive ? "primary" : "secondary"}
            icon={
              <SlidersHorizontalIcon
                size={theme.iconSize.sm}
                color={
                  filterActive
                    ? theme.colors.primaryForeground
                    : theme.colors.foreground
                }
              />
            }
            accessibilityLabel={filterLabel}
            onPress={model.openFilters}
          />
          {filterActive ? (
            <View style={styles.filterBadge} pointerEvents="none">
              <Text style={styles.filterBadgeLabel}>
                {String(model.filterCount)}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
      {filterActive ? (
        <View style={styles.chipRow}>
          {model.selectedFilterChips.map((chip) => (
            <View key={chip.key} style={styles.filterChip}>
              <Text style={styles.filterChipLabel}>{chip.label}</Text>
            </View>
          ))}
        </View>
      ) : null}
      <OrdersListBody model={model} renderItem={renderItem} />
      <OrdersFilterSheet
        visible={model.filterSheetVisible}
        copy={copy}
        selected={model.selectedStatuses}
        onClose={model.closeFilters}
        onToggle={model.toggleStatus}
        onReset={model.resetFilters}
      />
    </SafeAreaView>
  );
}

function OrdersListBody(props: {
  readonly model: OrdersListModel;
  readonly renderItem: ListRenderItem<OrdersListEntry>;
}) {
  const { model } = props;
  const { copy } = model;
  const { theme } = useUnistyles();
  const iconColor = theme.colors.mutedForeground;

  switch (model.state.kind) {
    case "loading":
      return (
        <View style={styles.skeletons} accessibilityLabel={copy.loadingLabel}>
          <ListSurface>
            {SKELETON_ROWS.map((index) => (
              <ListRow key={index} first={index === 0}>
                <OrderRowSkeleton />
              </ListRow>
            ))}
          </ListSurface>
        </View>
      );
    case "offline":
      return (
        <CenteredEmpty>
          <EmptyState
            icon={<WifiOffIcon size={theme.iconSize.md} color={iconColor} />}
            title={copy.empty.offlineTitle}
            description={copy.empty.offlineDescription}
            action={
              <Button
                variant="secondary"
                label={copy.empty.retry}
                onPress={model.retry}
              />
            }
          />
        </CenteredEmpty>
      );
    case "error":
      return (
        <CenteredEmpty>
          <EmptyState
            icon={<WifiOffIcon size={theme.iconSize.md} color={iconColor} />}
            title={copy.empty.errorTitle}
            description={copy.empty.errorDescription}
            action={
              <Button
                variant="secondary"
                label={copy.empty.retry}
                onPress={model.retry}
              />
            }
          />
        </CenteredEmpty>
      );
    case "empty-filtered":
      return (
        <CenteredEmpty>
          <EmptyState
            icon={<SearchIcon size={theme.iconSize.md} color={iconColor} />}
            title={copy.empty.filteredTitle}
            description={copy.empty.filteredDescription}
            action={
              <Button
                variant="secondary"
                label={copy.empty.reset}
                onPress={model.resetSearchAndFilters}
              />
            }
          />
        </CenteredEmpty>
      );
    case "empty-catalog":
      return (
        <CenteredEmpty>
          <EmptyState
            icon={
              <ShoppingBagIcon size={theme.iconSize.md} color={iconColor} />
            }
            title={copy.empty.catalogTitle}
            description={copy.empty.catalogDescription}
            action={
              model.showCreate ? (
                <Button
                  icon={
                    <PlusIcon
                      size={theme.iconSize.sm}
                      color={theme.colors.primaryForeground}
                    />
                  }
                  label={copy.empty.create}
                  onPress={model.openCreate}
                />
              ) : undefined
            }
          />
        </CenteredEmpty>
      );
    case "rows":
      return (
        <FlashList
          data={model.entries}
          style={styles.list}
          extraData={model.entries}
          keyExtractor={keyExtractor}
          getItemType={getItemType}
          renderItem={props.renderItem}
          stickyHeaderIndices={model.stickyHeaderIndices}
          ListFooterComponent={
            model.loadingMore ? (
              <ActivityIndicator
                accessibilityLabel={copy.loadingMoreLabel}
                color={theme.colors.activityIndicator.onBackground}
                style={styles.footerSpinner}
              />
            ) : null
          }
          onEndReached={model.loadMore}
          onEndReachedThreshold={0.5}
          refreshing={model.refreshing}
          onRefresh={model.refresh}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.listContent}
        />
      );
  }
}

function keyExtractor(entry: OrdersListEntry): string {
  return entry.type === "header" ? `header:${entry.key}` : entry.order.id;
}

function getItemType(
  entry: OrdersListEntry,
  index: number,
  extraData?: readonly OrdersListEntry[],
): string {
  if (entry.type === "header") {
    return "header";
  }
  const groupEdge =
    extraData === undefined
      ? "middle"
      : (orderListGroupEdge(extraData, index) ?? "middle");
  return `row:${groupEdge}`;
}

function CenteredEmpty({ children }: { readonly children: React.ReactNode }) {
  return <View style={styles.centered}>{children}</View>;
}

const styles = StyleSheet.create((theme) => ({
  screen: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.md,
  },
  searchSlot: {
    flex: 1,
    minWidth: 0,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.md,
  },
  filterChip: {
    backgroundColor: theme.colors.muted,
    borderRadius: theme.radii.full,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing["2xs"],
  },
  filterChipLabel: {
    color: theme.colors.foreground,
    fontSize: theme.typography["2xs"].fontSize,
    lineHeight: theme.typography["2xs"].lineHeight,
  },
  filterBadge: {
    position: "absolute",
    top: -theme.spacing["2xs"],
    right: -theme.spacing["2xs"],
    minWidth: theme.spacing.lg,
    height: theme.spacing.lg,
    paddingHorizontal: theme.spacing["2xs"],
    borderRadius: theme.radii.full,
    backgroundColor: theme.colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  filterBadgeLabel: {
    color: theme.colors.accentForeground,
    fontSize: theme.typography["2xs"].fontSize,
    lineHeight: theme.typography["2xs"].lineHeight,
    fontWeight: "600",
  },
  skeletons: {
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
  },
  centered: {
    flex: 1,
    justifyContent: "center",
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingBottom: theme.spacing["2xl"],
  },
  groupHeader: {
    backgroundColor: theme.colors.background,
    paddingHorizontal: theme.spacing.lg,
    // Class B: canvas py-2.5 (10) → spacing.sm (8). Own horizontal
    // padding — FlashList sticky headers drop contentContainerStyle.
    paddingVertical: theme.spacing.sm,
  },
  groupHeaderLabel: {
    color: theme.colors.icon.muted,
    fontSize: theme.typography.xs.fontSize,
    lineHeight: theme.typography.xs.lineHeight,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  footerSpinner: {
    paddingVertical: theme.spacing.lg,
  },
}));
