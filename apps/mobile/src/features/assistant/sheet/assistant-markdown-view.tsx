import { useMemo, type ReactElement } from "react";
import {
  ScrollView,
  Text,
  View,
  type StyleProp,
  type TextStyle,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";

import {
  isSafeAssistantHref,
  openAssistantMarkdownHref,
  parseAssistantMarkdown,
  type MarkdownBlock,
  type MarkdownInline,
} from "../shared/assistant-markdown";

export function AssistantMarkdownView(props: {
  readonly text: string;
  readonly onOpenHref: (href: string) => void;
}) {
  const { text, onOpenHref } = props;
  const blocks = useMemo(() => parseAssistantMarkdown(text), [text]);

  if (blocks.length === 0) {
    return (
      <Text style={styles.paragraph}>
        <Text>{text}</Text>
      </Text>
    );
  }

  return (
    <View style={styles.stack}>
      {blocks.map((block, index) => (
        <MarkdownBlockView key={index} block={block} onOpenHref={onOpenHref} />
      ))}
    </View>
  );
}

function MarkdownBlockView(props: {
  readonly block: MarkdownBlock;
  readonly onOpenHref: (href: string) => void;
}): ReactElement {
  const { block, onOpenHref } = props;
  switch (block.type) {
    case "paragraph":
      return (
        <MarkdownInlines
          nodes={block.children}
          onOpenHref={onOpenHref}
          style={styles.paragraph}
        />
      );
    case "heading":
      return (
        <MarkdownInlines
          nodes={block.children}
          onOpenHref={onOpenHref}
          style={headingStyle(block.level)}
        />
      );
    case "list":
      return (
        <View style={styles.list}>
          {block.items.map((item, itemIndex) => (
            <View key={itemIndex} style={styles.listItem}>
              <Text style={styles.listMarker}>
                {block.ordered
                  ? `${String(block.start + itemIndex)}.`
                  : "\u2022"}
              </Text>
              <View style={styles.listBody}>
                <MarkdownInlines
                  nodes={item}
                  onOpenHref={onOpenHref}
                  style={styles.paragraph}
                />
              </View>
            </View>
          ))}
        </View>
      );
    case "table":
      return (
        <ScrollView
          horizontal
          nestedScrollEnabled
          bounces={false}
          style={styles.tableScroll}
        >
          <View style={styles.table}>
            <View style={styles.tableHeaderRow}>
              {block.header.map((cell, cellIndex) => (
                <View key={cellIndex} style={styles.tableCell}>
                  <MarkdownInlines
                    nodes={cell}
                    onOpenHref={onOpenHref}
                    style={styles.tableHeaderText}
                  />
                </View>
              ))}
            </View>
            {block.rows.map((row, rowIndex) => (
              <View key={rowIndex} style={styles.tableRow}>
                {row.map((cell, cellIndex) => (
                  <View key={cellIndex} style={styles.tableCell}>
                    <MarkdownInlines
                      nodes={cell}
                      onOpenHref={onOpenHref}
                      style={styles.paragraph}
                    />
                  </View>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      );
  }
  const unhandledBlock: never = block;
  return unhandledBlock;
}

function MarkdownInlines(props: {
  readonly nodes: readonly MarkdownInline[];
  readonly onOpenHref: (href: string) => void;
  readonly style: StyleProp<TextStyle>;
}): ReactElement {
  return (
    <Text style={props.style}>
      {props.nodes.map((node, index) => (
        <MarkdownInlineView
          key={index}
          node={node}
          onOpenHref={props.onOpenHref}
        />
      ))}
    </Text>
  );
}

function MarkdownInlineView(props: {
  readonly node: MarkdownInline;
  readonly onOpenHref: (href: string) => void;
}): ReactElement {
  const { node, onOpenHref } = props;
  switch (node.type) {
    case "text":
      return <Text>{node.value}</Text>;
    case "code":
      return <Text style={styles.code}>{node.value}</Text>;
    case "bold":
      return (
        <Text style={styles.bold}>
          {node.children.map((child, index) => (
            <MarkdownInlineView
              key={index}
              node={child}
              onOpenHref={onOpenHref}
            />
          ))}
        </Text>
      );
    case "italic":
      return (
        <Text style={styles.italic}>
          {node.children.map((child, index) => (
            <MarkdownInlineView
              key={index}
              node={child}
              onOpenHref={onOpenHref}
            />
          ))}
        </Text>
      );
    case "link": {
      const href = node.href;
      const openable = isSafeAssistantHref(href);
      return (
        <Text
          accessibilityRole={openable ? "link" : "text"}
          onPress={
            openable
              ? () => {
                  openAssistantMarkdownHref(href, onOpenHref);
                }
              : undefined
          }
          style={openable ? styles.link : undefined}
        >
          {node.children.map((child, index) => (
            <MarkdownInlineView
              key={index}
              node={child}
              onOpenHref={onOpenHref}
            />
          ))}
        </Text>
      );
    }
  }
  const unhandledInline: never = node;
  return unhandledInline;
}

function headingStyle(level: 1 | 2 | 3) {
  if (level === 1) {
    return styles.heading1;
  }
  if (level === 2) {
    return styles.heading2;
  }
  return styles.heading3;
}

const styles = StyleSheet.create((theme) => ({
  stack: {
    gap: theme.spacing.sm,
  },
  paragraph: {
    color: theme.colors.foreground,
    fontSize: theme.typography.sm.fontSize,
    lineHeight: theme.typography.sm.lineHeight,
  },
  heading1: {
    color: theme.colors.foreground,
    fontSize: theme.typography.sm.fontSize,
    lineHeight: theme.typography.sm.lineHeight,
    fontWeight: "700",
  },
  heading2: {
    color: theme.colors.foreground,
    fontSize: theme.typography.sm.fontSize,
    lineHeight: theme.typography.sm.lineHeight,
    fontWeight: "600",
  },
  heading3: {
    color: theme.colors.mutedForeground,
    fontSize: theme.typography.sm.fontSize,
    lineHeight: theme.typography.sm.lineHeight,
    fontWeight: "600",
  },
  bold: {
    fontWeight: "700",
  },
  italic: {
    fontStyle: "italic",
  },
  code: {
    color: theme.colors.foreground,
    backgroundColor: theme.colors.muted,
    fontSize: theme.typography.sm.fontSize,
    lineHeight: theme.typography.sm.lineHeight,
    borderRadius: theme.radii.sm,
    ...theme.squircle,
    paddingHorizontal: theme.spacing["2xs"],
  },
  link: {
    color: theme.colors.accentFg,
    textDecorationLine: "underline",
  },
  list: {
    gap: theme.spacing.xs,
  },
  listItem: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing.xs,
  },
  listMarker: {
    color: theme.colors.mutedForeground,
    fontSize: theme.typography.sm.fontSize,
    lineHeight: theme.typography.sm.lineHeight,
  },
  listBody: {
    flex: 1,
    minWidth: 0,
  },
  tableScroll: {
    alignSelf: "stretch",
  },
  table: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radii.sm,
    ...theme.squircle,
    overflow: "hidden",
  },
  tableHeaderRow: {
    flexDirection: "row",
    backgroundColor: theme.colors.muted,
  },
  tableRow: {
    flexDirection: "row",
  },
  tableCell: {
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
    flexShrink: 0,
  },
  tableHeaderText: {
    color: theme.colors.foreground,
    fontSize: theme.typography.sm.fontSize,
    lineHeight: theme.typography.sm.lineHeight,
    fontWeight: "600",
  },
}));
