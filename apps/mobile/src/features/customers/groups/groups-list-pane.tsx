import { useCallback, type ReactNode } from "react";
import { ActivityIndicator, View } from "react-native";
import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import {
  LayersIcon,
  PlusIcon,
  SearchIcon,
  WifiOffIcon,
} from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import {
  Button,
  EmptyState,
  ListRow,
  ListSurface,
} from "../../../components/ui";
import { EntityCardSkeleton } from "../shared/entity-card";
import { GroupRow } from "./group-row";
import type { GroupsListModel, GroupsListRow } from "./use-groups-list";

const SKELETON_ROWS = [0, 1, 2] as const;

export function GroupsListPane(props: {
  readonly model: GroupsListModel;
  readonly openCreate: () => void;
}) {
  const { model, openCreate } = props;
  const { copy } = model;

  const onRemove = useCallback(
    (id: string) => {
      void model.remove(id);
    },
    [model.remove],
  );

  const renderItem: ListRenderItem<GroupsListRow> = useCallback(
    ({ item, index }) => (
      <ListRow first={index === 0}>
        <GroupRow
          id={item.id}
          name={item.name}
          description={item.description}
          membersLabel={item.membersLabel}
          priceListName={item.priceListName}
          editLabel={copy.editLabel}
          deleteA11y={item.deleteA11y}
          canEdit={model.canEdit}
          disabled={model.writesPending}
          onEdit={model.openEdit}
          onRemove={onRemove}
        />
      </ListRow>
    ),
    [
      copy.editLabel,
      model.canEdit,
      model.writesPending,
      model.openEdit,
      onRemove,
    ],
  );

  return (
    <GroupsListBody
      model={model}
      openCreate={openCreate}
      renderItem={renderItem}
    />
  );
}

function GroupsListBody(props: {
  readonly model: GroupsListModel;
  readonly openCreate: () => void;
  readonly renderItem: ListRenderItem<GroupsListRow>;
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
                <EntityCardSkeleton />
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
    case "empty-search":
      return (
        <CenteredEmpty>
          <EmptyState
            icon={<SearchIcon size={theme.iconSize.md} color={iconColor} />}
            title={copy.empty.groupsSearchTitle}
            description={copy.empty.groupsSearchDescription}
            action={
              <Button
                variant="secondary"
                label={copy.empty.reset}
                onPress={model.resetSearch}
              />
            }
          />
        </CenteredEmpty>
      );
    case "empty-catalog":
      return (
        <CenteredEmpty>
          <EmptyState
            icon={<LayersIcon size={theme.iconSize.md} color={iconColor} />}
            title={copy.empty.groupsTitle}
            description={copy.empty.groupsDescription}
            action={
              model.canCreate ? (
                <Button
                  icon={
                    <PlusIcon
                      size={theme.iconSize.sm}
                      color={theme.colors.primaryForeground}
                    />
                  }
                  label={copy.empty.groupsCreate}
                  onPress={props.openCreate}
                />
              ) : undefined
            }
          />
        </CenteredEmpty>
      );
    case "rows":
      return (
        <View style={styles.rowsPane}>
          <View style={styles.surfacePane}>
            <ListSurface style={styles.surfaceFill}>
              <FlashList
                data={model.rows}
                style={styles.list}
                keyExtractor={keyExtractor}
                renderItem={props.renderItem}
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
            </ListSurface>
          </View>
        </View>
      );
  }
}

function keyExtractor(row: GroupsListRow): string {
  return row.id;
}

function CenteredEmpty({ children }: { readonly children: ReactNode }) {
  return <View style={styles.centered}>{children}</View>;
}

const styles = StyleSheet.create((theme) => ({
  skeletons: {
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
  },
  centered: {
    flex: 1,
    justifyContent: "center",
  },
  rowsPane: {
    flex: 1,
  },
  surfacePane: {
    flex: 1,
    paddingHorizontal: theme.spacing.lg,
  },
  surfaceFill: {
    flex: 1,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingBottom: theme.spacing["2xl"],
  },
  footerSpinner: {
    paddingVertical: theme.spacing.lg,
  },
}));
