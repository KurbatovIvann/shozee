import { memo } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { StatusPill } from "../../../components/ui";
import type {
  AssistantCollectionColumnView,
  AssistantCollectionView,
} from "../surfaces/collection";

export type AssistantCollectionCellLayout = "inline" | "stacked";

/**
 * Shared collection row (SHO-472 / SHO-473). List collection and the
 * aggregate block both render this — do not fork a second column/row
 * primitive for breakdown.
 */
export const AssistantCollectionResultRow = memo(
  function AssistantCollectionResultRow(props: {
    readonly title: string;
    readonly badge: string | null;
    readonly badgeTone: AssistantCollectionView["rows"][number]["badgeTone"];
    readonly meta: string | null;
    readonly cells: readonly string[];
    readonly href: string | null;
    readonly onOpenHref: (href: string) => void;
    readonly cellLayout?: AssistantCollectionCellLayout;
    readonly indent?: boolean;
  }) {
    const stacked = props.cellLayout === "stacked";
    const accessibilityLabel =
      props.title.length > 0 ? props.title : (props.meta ?? props.badge ?? "");
    const body = (
      <>
        <View style={styles.rowBody}>
          <View style={styles.nameRow}>
            {props.title.length > 0 ? (
              <Text numberOfLines={stacked ? 2 : 1} style={styles.name}>
                {props.title}
              </Text>
            ) : null}
            {props.badge !== null ? (
              <StatusPill label={props.badge} tone={props.badgeTone} />
            ) : null}
          </View>
          {props.meta !== null ? (
            <Text numberOfLines={1} style={styles.meta}>
              {props.meta}
            </Text>
          ) : null}
        </View>
        {stacked ? (
          <View style={styles.metrics}>
            {props.cells.map((cell, index) => (
              <Text
                key={`${cell}:${String(index)}`}
                numberOfLines={1}
                style={index === 0 ? styles.count : styles.total}
              >
                {cell}
              </Text>
            ))}
          </View>
        ) : (
          props.cells.map((cell, index) => (
            <Text
              key={`${cell}:${String(index)}`}
              numberOfLines={1}
              style={styles.total}
            >
              {cell}
            </Text>
          ))
        )}
      </>
    );

    const rowStyle = [styles.row, props.indent === true ? styles.indent : null];

    if (props.href === null) {
      return <View style={rowStyle}>{body}</View>;
    }

    const href = props.href;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        onPress={() => {
          props.onOpenHref(href);
        }}
        style={({ pressed }) => [...rowStyle, pressed ? styles.pressed : null]}
      >
        {body}
      </Pressable>
    );
  },
);

export const AssistantCollectionColumnHeaders = memo(
  function AssistantCollectionColumnHeaders(props: {
    readonly columns: readonly AssistantCollectionColumnView[];
  }) {
    const showHeaders = props.columns.some((column) => column.label.length > 0);
    if (!showHeaders) {
      return null;
    }
    return (
      <View style={styles.headerRow}>
        {props.columns.map((column) => (
          <Text
            key={column.id}
            numberOfLines={1}
            style={[
              column.width === "flex" ? styles.headerFlex : styles.headerAuto,
              column.alignment === "end" ? styles.headerEnd : null,
            ]}
          >
            {column.label}
          </Text>
        ))}
      </View>
    );
  },
);

/**
 * Generic list-shaped assistant block (SHO-472). Driven by a localized
 * collection descriptor. Orders-list and customers-list both render
 * here — do not copy this file and swap columns.
 */
export const AssistantCollectionBlock = memo(
  function AssistantCollectionBlock(props: {
    readonly collection: AssistantCollectionView;
    readonly onOpenHref: (href: string) => void;
  }) {
    const { collection, onOpenHref } = props;

    return (
      <View
        style={[
          styles.rows,
          collection.surface === "inset" ? styles.inset : null,
        ]}
      >
        <AssistantCollectionColumnHeaders columns={collection.columns} />
        {collection.rows.map((row) => (
          <AssistantCollectionResultRow
            key={row.id}
            title={row.title}
            badge={row.badge}
            badgeTone={row.badgeTone}
            meta={row.meta}
            cells={row.cells}
            href={row.href}
            onOpenHref={onOpenHref}
          />
        ))}
      </View>
    );
  },
);

const styles = StyleSheet.create((theme) => ({
  rows: {
    gap: theme.spacing.xs,
  },
  inset: {
    backgroundColor: theme.colors.muted,
    borderRadius: theme.radii.md,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
  },
  headerFlex: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.mutedForeground,
    fontSize: theme.typography.xs.fontSize,
    lineHeight: theme.typography.xs.lineHeight,
    fontWeight: "500",
  },
  headerAuto: {
    flexShrink: 0,
    color: theme.colors.mutedForeground,
    fontSize: theme.typography.xs.fontSize,
    lineHeight: theme.typography.xs.lineHeight,
    fontWeight: "500",
  },
  headerEnd: {
    textAlign: "right",
  },
  row: {
    minHeight: theme.hitTarget.min,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
  },
  indent: {
    paddingLeft: theme.spacing.md,
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.muted,
  },
  pressed: {
    opacity: theme.pressedOpacity,
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing["2xs"],
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing.xs,
  },
  name: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.typography.sm.fontSize,
    lineHeight: theme.typography.sm.lineHeight,
    fontWeight: "600",
  },
  meta: {
    color: theme.colors.mutedForeground,
    fontSize: theme.typography.xs.fontSize,
    lineHeight: theme.typography.xs.lineHeight,
  },
  metrics: {
    alignItems: "flex-end",
    gap: theme.spacing["2xs"],
  },
  count: {
    color: theme.colors.mutedForeground,
    fontSize: theme.typography.xs.fontSize,
    lineHeight: theme.typography.xs.lineHeight,
    fontVariant: ["tabular-nums"],
  },
  total: {
    color: theme.colors.foreground,
    fontSize: theme.typography.sm.fontSize,
    lineHeight: theme.typography.sm.lineHeight,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
}));
