import { memo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import type { AssistantSearchResultsCardView } from "../surfaces/search-results";
import { AssistantCollectionResultRow } from "./assistant-collection-block";

/**
 * Grouped search-results block (SHO-535). Section headings plus the
 * shared collection row primitive. Do not add a second Card/Button
 * chrome — the frame owns empty + footnotes.
 */
export const AssistantSearchResultsBlock = memo(
  function AssistantSearchResultsBlock(props: {
    readonly card: AssistantSearchResultsCardView;
    readonly onOpenHref: (href: string) => void;
  }) {
    const { card, onOpenHref } = props;
    return (
      <View style={styles.sections}>
        {card.groups.map((group) => (
          <View key={group.entityType} style={styles.group}>
            <Text style={styles.heading}>{group.heading}</Text>
            {group.truncatedLabel !== null ? (
              <Text style={styles.note}>{group.truncatedLabel}</Text>
            ) : null}
            {group.emptyLabel !== null ? (
              <Text style={styles.note}>{group.emptyLabel}</Text>
            ) : (
              group.collection.rows.map((row) => (
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
              ))
            )}
          </View>
        ))}
      </View>
    );
  },
);

const styles = StyleSheet.create((theme) => ({
  sections: {
    gap: theme.spacing.md,
  },
  group: {
    gap: theme.spacing.xs,
  },
  heading: {
    color: theme.colors.mutedForeground,
    fontSize: theme.typography.xs.fontSize,
    lineHeight: theme.typography.xs.lineHeight,
    fontWeight: "500",
  },
  note: {
    color: theme.colors.mutedForeground,
    fontSize: theme.typography.xs.fontSize,
    lineHeight: theme.typography.xs.lineHeight,
  },
}));
