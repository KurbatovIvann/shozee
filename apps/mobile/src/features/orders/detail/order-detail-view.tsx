import type { ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import {
  CheckIcon,
  FileWarningIcon,
  MoreHorizontalIcon,
  PhoneIcon,
  UserIcon,
  WifiOffIcon,
} from "lucide-react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import {
  AppHeader,
  Banner,
  Button,
  EmptyState,
  IconButton,
  StatusPill,
} from "../../../components/ui";
import { OrderActionsSheet } from "./order-actions-sheet";
import { OrderLineRow } from "./order-line-row";
import type { OrderDetailModel } from "./use-order-detail";

export function OrderDetailView(model: OrderDetailModel) {
  const { copy } = model;
  const { theme } = useUnistyles();

  return (
    <SafeAreaView
      edges={["top", "bottom"]}
      accessibilityLabel={model.headerTitle}
      style={styles.screen}
    >
      <AppHeader
        title={model.headerTitle}
        subtitle={model.headerSubtitle}
        back={{
          onPress: model.goBack,
          accessibilityLabel: copy.detail.backLabel,
        }}
        actions={
          model.showActions ? (
            <IconButton
              variant="secondary"
              icon={
                <MoreHorizontalIcon
                  size={theme.iconSize.md}
                  color={theme.colors.foreground}
                />
              }
              accessibilityLabel={copy.detail.actionsLabel}
              onPress={model.openActions}
            />
          ) : undefined
        }
      />
      <OrderDetailBody model={model} />
      <OrderDetailPrimaryCta model={model} />
      <OrderActionsSheet
        visible={model.actionsVisible && model.state.kind === "ready"}
        copy={copy.detail}
        closeLabel={copy.closeSheet}
        cancelEnabled={model.cancelEnabled}
        pending={model.writePending}
        onClose={model.closeActions}
        onCancel={model.cancel}
      />
    </SafeAreaView>
  );
}

function OrderDetailPrimaryCta(props: { readonly model: OrderDetailModel }) {
  const { model } = props;
  const { copy } = model;
  const { theme } = useUnistyles();
  let label: string;
  let loading: boolean;
  let onPress: () => void;
  if (model.showConfirm) {
    label = copy.detail.confirmLabel;
    loading = model.confirmLoading;
    onPress = model.confirm;
  } else if (model.showStart) {
    label = copy.detail.startLabel;
    loading = model.startLoading;
    onPress = model.start;
  } else if (model.showComplete) {
    label = copy.detail.completeLabel;
    loading = model.completeLoading;
    onPress = model.complete;
  } else {
    return null;
  }
  return (
    <View style={styles.footerDock}>
      <View style={styles.footerCard}>
        <Button
          fullWidth
          loading={loading}
          icon={
            <CheckIcon
              size={theme.iconSize.sm}
              color={theme.colors.primaryForeground}
            />
          }
          label={label}
          onPress={onPress}
        />
      </View>
    </View>
  );
}

function OrderDetailBody(props: { readonly model: OrderDetailModel }) {
  const { model } = props;
  const { copy } = model;
  const { theme } = useUnistyles();
  const iconColor = theme.colors.mutedForeground;

  switch (model.state.kind) {
    case "loading":
      return (
        <View
          style={styles.skeletons}
          accessibilityLabel={copy.detail.loadingLabel}
        >
          <View style={styles.skeletonCard} />
          <View style={styles.skeletonCard} />
          <View style={styles.skeletonCard} />
        </View>
      );
    case "offline":
      return (
        <CenteredEmpty>
          <EmptyState
            icon={<WifiOffIcon size={theme.iconSize.md} color={iconColor} />}
            title={copy.detail.offlineTitle}
            description={copy.detail.offlineDescription}
            action={
              <Button
                variant="secondary"
                label={copy.detail.retry}
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
            title={copy.detail.errorTitle}
            description={copy.detail.errorDescription}
            action={
              <Button
                variant="secondary"
                label={copy.detail.retry}
                onPress={model.retry}
              />
            }
          />
        </CenteredEmpty>
      );
    case "not-found":
      return (
        <CenteredEmpty>
          <EmptyState
            icon={
              <FileWarningIcon size={theme.iconSize.md} color={iconColor} />
            }
            title={copy.detail.notFoundTitle}
            description={copy.detail.notFoundDescription}
            action={
              <Button
                variant="secondary"
                label={copy.detail.notFoundAction}
                onPress={model.goBack}
              />
            }
          />
        </CenteredEmpty>
      );
    case "ready":
      if (model.order === null) {
        return null;
      }
      return <OrderDetailReady model={model} />;
  }
}

function OrderDetailReady(props: { readonly model: OrderDetailModel }) {
  const { model } = props;
  const { copy } = model;
  const { theme } = useUnistyles();
  const order = model.order;
  if (order === null) {
    return null;
  }

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.statusRow}>
        <StatusPill
          size="md"
          label={order.statusLabel}
          tone={order.statusTone}
        />
      </View>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{copy.detail.customerTitle}</Text>
        <View style={styles.card}>
          <View style={styles.customerRow}>
            <View style={styles.customerIcon}>
              <UserIcon
                size={theme.iconSize.sm}
                color={theme.colors.mutedForeground}
              />
            </View>
            <View style={styles.customerBody}>
              <Text numberOfLines={1} style={styles.customerName}>
                {order.customerName}
              </Text>
              {order.showPhoneIcon ? (
                <View style={styles.phoneRow}>
                  <View style={styles.phoneIcon} accessibilityElementsHidden>
                    <PhoneIcon
                      size={theme.iconSize.sm}
                      color={theme.colors.icon.muted}
                    />
                  </View>
                  {order.customerPhone !== null ? (
                    <Text numberOfLines={1} style={styles.customerPhone}>
                      {order.customerPhone}
                    </Text>
                  ) : null}
                </View>
              ) : null}
            </View>
          </View>
        </View>
      </View>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{copy.detail.linesTitle}</Text>
        <View style={styles.card}>
          <View style={styles.lineList}>
            {order.lines.map((line) => (
              <OrderLineRow
                key={line.itemId}
                title={line.title}
                metaLabel={line.metaLabel}
                grossLabel={line.grossLabel}
                thumbnailFileId={line.thumbnailFileId}
                thumbnailUrl={line.thumbnailUrl}
                thumbnailFailed={line.thumbnailFailed}
                thumbnailFailedLabel={copy.detail.thumbnailUnavailable}
              />
            ))}
          </View>
          <View style={styles.dueRow}>
            <Text style={styles.dueLabel}>{copy.detail.dueLabel}</Text>
            <Text style={styles.dueValue}>{order.dueLabel}</Text>
          </View>
        </View>
      </View>
      {order.comment !== null ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{copy.detail.commentTitle}</Text>
          <View style={styles.card}>
            <Text style={styles.comment}>{order.comment}</Text>
          </View>
        </View>
      ) : null}
      {model.statusBanner !== null && model.statusBanner.length > 0 ? (
        <Banner message={model.statusBanner} />
      ) : null}
    </ScrollView>
  );
}

function CenteredEmpty({ children }: { readonly children: ReactNode }) {
  return <View style={styles.centered}>{children}</View>;
}

const styles = StyleSheet.create((theme) => ({
  screen: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.xl,
    gap: theme.spacing.lg,
  },
  statusRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing.sm,
  },
  section: {
    gap: theme.spacing.sm,
  },
  sectionTitle: {
    paddingHorizontal: theme.spacing.xs,
    color: theme.colors.mutedForeground,
    fontSize: theme.typography.xs.fontSize,
    lineHeight: theme.typography.xs.lineHeight,
    fontWeight: "600",
  },
  card: {
    backgroundColor: theme.colors.card,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radii.card,
    ...theme.squircle,
    padding: theme.spacing.md,
    gap: theme.spacing.md,
    ...theme.shadows.sm,
  },
  customerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    minHeight: theme.hitTarget.min,
  },
  customerIcon: {
    width: theme.hitTarget.min,
    height: theme.hitTarget.min,
    borderRadius: theme.radii.full,
    backgroundColor: theme.colors.muted,
    alignItems: "center",
    justifyContent: "center",
  },
  customerBody: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing["2xs"],
  },
  customerName: {
    color: theme.colors.foreground,
    fontSize: theme.typography.base.fontSize,
    lineHeight: theme.typography.base.lineHeight,
    fontWeight: "500",
  },
  customerPhone: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.mutedForeground,
    fontSize: theme.typography.xs.fontSize,
    lineHeight: theme.typography.xs.lineHeight,
  },
  phoneRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing.sm,
  },
  phoneIcon: {
    marginTop: theme.spacing["2xs"],
  },
  lineList: {
    gap: theme.spacing.sm,
  },
  dueRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.lg,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing.md,
  },
  dueLabel: {
    color: theme.colors.foreground,
    fontSize: theme.typography.lg.fontSize,
    lineHeight: theme.typography.lg.lineHeight,
    fontWeight: "600",
  },
  dueValue: {
    color: theme.colors.foreground,
    fontSize: theme.typography.lg.fontSize,
    lineHeight: theme.typography.lg.lineHeight,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  comment: {
    color: theme.colors.foreground,
    fontSize: theme.typography.sm.fontSize,
    lineHeight: theme.typography.sm.lineHeight,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
  },
  footerDock: {
    backgroundColor: theme.colors.background,
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.md,
    paddingBottom: theme.spacing.md,
  },
  footerCard: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
    borderRadius: theme.radii.card,
    ...theme.squircle,
    padding: theme.spacing.md,
    ...theme.shadows.sm,
  },
  centered: {
    flex: 1,
    justifyContent: "center",
  },
  skeletons: {
    gap: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
  },
  skeletonCard: {
    height: theme.hitTarget.row,
    borderRadius: theme.radii.card,
    ...theme.squircle,
    backgroundColor: theme.colors.skeleton,
  },
}));
