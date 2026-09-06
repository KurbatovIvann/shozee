import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { SparklesIcon } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import { Button, Card, StatusPill } from "../../../components/ui";
import {
  ORIGIN_MARK_ICON_SIZE,
  type AssistantResultAction,
  type AssistantResultChip,
  type AssistantResultPill,
} from "./assistant-result-chrome";

/**
 * The one place assistant result-card chrome lives (SHO-469). A frame
 * with no block is a complete notice card (HITL / permission / failed
 * write). Blocks render as `children`.
 */
export function AssistantResultFrame(props: {
  readonly pill?: AssistantResultPill;
  readonly avatar?: ReactNode;
  readonly title?: string;
  readonly trailing?: string;
  readonly trailingBadge?: AssistantResultPill;
  readonly subtitle?: string;
  readonly chips?: readonly AssistantResultChip[];
  readonly body?: string;
  readonly emptyTitle?: string | null;
  readonly emptyDescription?: string | null;
  readonly footnotes?: readonly string[];
  readonly actions?: readonly AssistantResultAction[];
  readonly provisional?: boolean;
  readonly origin?: boolean;
  readonly originLabel?: string | null;
  readonly children?: ReactNode;
}) {
  const pill = props.pill;
  const avatar = props.avatar;
  const title = props.title;
  const trailing = props.trailing;
  const trailingBadge = props.trailingBadge;
  const subtitle = props.subtitle;
  const chips = props.chips ?? [];
  const body = props.body;
  const emptyTitle = props.emptyTitle ?? null;
  const emptyDescription = props.emptyDescription ?? null;
  const footnotes = props.footnotes ?? [];
  const actions = props.actions ?? [];
  const provisional = props.provisional === true;
  const origin = props.origin === true;
  const originLabel = props.originLabel ?? null;
  const hasHeader = avatar !== undefined || pill !== undefined;
  const hasTitleRow =
    title !== undefined ||
    trailing !== undefined ||
    trailingBadge !== undefined;
  const showOrigin = origin && !provisional;

  return (
    <Card provisional={provisional}>
      <View style={styles.body}>
        {hasHeader ? (
          <View style={styles.header}>
            {avatar !== undefined ? avatar : null}
            {pill !== undefined ? (
              <StatusPill label={pill.label} tone={pill.tone} size="md" />
            ) : null}
          </View>
        ) : null}
        {hasTitleRow ? (
          <View style={styles.titleRow}>
            {title !== undefined ? (
              <Text style={styles.title}>{title}</Text>
            ) : null}
            {trailingBadge !== undefined ? (
              <StatusPill
                label={trailingBadge.label}
                tone={trailingBadge.tone}
              />
            ) : null}
            {trailing !== undefined ? (
              <Text style={styles.trailing}>{trailing}</Text>
            ) : null}
          </View>
        ) : null}
        {subtitle !== undefined ? (
          <Text style={styles.subtitle}>{subtitle}</Text>
        ) : null}
        {chips.length > 0 ? (
          <View style={styles.chips}>
            {chips.map((chip) => (
              <StatusPill key={chip.key} label={chip.label} tone={chip.tone} />
            ))}
          </View>
        ) : null}
        {body !== undefined ? <Text style={styles.notice}>{body}</Text> : null}
        {props.children}
        {emptyTitle !== null ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>{emptyTitle}</Text>
            {emptyDescription !== null ? (
              <Text style={styles.emptyDescription}>{emptyDescription}</Text>
            ) : null}
          </View>
        ) : null}
        {footnotes.map((footnote) => (
          <Text key={footnote} style={styles.footnote}>
            {footnote}
          </Text>
        ))}
        {actions.length > 0 ? (
          <View style={styles.actions}>
            {actions.map((action) => (
              <View
                key={action.id}
                style={[
                  styles.action,
                  action.fullWidth === true ? styles.actionFullWidth : null,
                ]}
              >
                <Button
                  variant={action.variant ?? "primary"}
                  fullWidth
                  label={action.label}
                  onPress={action.onPress}
                />
              </View>
            ))}
          </View>
        ) : null}
        {showOrigin ? <OriginMark label={originLabel} /> : null}
      </View>
    </Card>
  );
}

function OriginMark(props: { readonly label: string | null }) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.origin}>
      <SparklesIcon
        size={ORIGIN_MARK_ICON_SIZE}
        color={theme.colors.icon.muted}
      />
      {props.label !== null ? (
        <Text style={styles.originLabel}>{props.label}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing.md,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: theme.spacing.md,
  },
  title: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.typography.base.fontSize,
    lineHeight: theme.typography.base.lineHeight,
    fontWeight: "600",
  },
  trailing: {
    flexShrink: 0,
    color: theme.colors.mutedForeground,
    fontSize: theme.typography.sm.fontSize,
    lineHeight: theme.typography.sm.lineHeight,
    fontWeight: "500",
    fontVariant: ["tabular-nums"],
  },
  subtitle: {
    color: theme.colors.mutedForeground,
    fontSize: theme.typography.xs.fontSize,
    lineHeight: theme.typography.xs.lineHeight,
  },
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.xs,
  },
  notice: {
    color: theme.colors.mutedForeground,
    fontSize: theme.typography.sm.fontSize,
    lineHeight: theme.typography.sm.lineHeight,
  },
  empty: {
    gap: theme.spacing.xs,
  },
  emptyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.typography.sm.fontSize,
    lineHeight: theme.typography.sm.lineHeight,
    fontWeight: "600",
  },
  emptyDescription: {
    color: theme.colors.mutedForeground,
    fontSize: theme.typography.xs.fontSize,
    lineHeight: theme.typography.xs.lineHeight,
  },
  footnote: {
    color: theme.colors.mutedForeground,
    fontSize: theme.typography.xs.fontSize,
    lineHeight: theme.typography.xs.lineHeight,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
  },
  action: {
    flex: 1,
  },
  actionFullWidth: {
    flexBasis: "100%",
  },
  origin: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.xs,
  },
  originLabel: {
    color: theme.colors.icon.muted,
    fontSize: theme.typography.xs.fontSize,
    lineHeight: theme.typography.xs.lineHeight,
  },
}));
