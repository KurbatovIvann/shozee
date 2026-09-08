import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  assistantMarkdownHrefs,
  assistantMarkdownVisibleText,
  isSafeAssistantHref,
  openAssistantMarkdownHref,
  parseAssistantMarkdown,
} from "./assistant-markdown";

const ROW = readFileSync(
  new URL("../sheet/assistant-message-row.tsx", import.meta.url),
  "utf8",
);
const VIEW = readFileSync(
  new URL("../sheet/assistant-markdown-view.tsx", import.meta.url),
  "utf8",
);

const GFM_TABLE = `| Name | Qty |
| --- | --- |
| Macarons | 12 |
| Coffee | 2 |`;

describe("parseAssistantMarkdown", () => {
  it("parses Створив **#123** as bold #123, not literal asterisks", () => {
    const blocks = parseAssistantMarkdown("Створив **#123**");
    expect(blocks).toEqual([
      {
        type: "paragraph",
        children: [
          { type: "text", value: "Створив " },
          { type: "bold", children: [{ type: "text", value: "#123" }] },
        ],
      },
    ]);
    expect(assistantMarkdownVisibleText(blocks)).toBe("Створив #123");
    expect(JSON.stringify(blocks)).not.toContain("*");
  });

  it("parses a GFM pipe table into header and row cells, not a pipe soup string", () => {
    const blocks = parseAssistantMarkdown(GFM_TABLE);
    expect(blocks).toEqual([
      {
        type: "table",
        header: [
          [{ type: "text", value: "Name" }],
          [{ type: "text", value: "Qty" }],
        ],
        rows: [
          [
            [{ type: "text", value: "Macarons" }],
            [{ type: "text", value: "12" }],
          ],
          [[{ type: "text", value: "Coffee" }], [{ type: "text", value: "2" }]],
        ],
      },
    ]);
    const table = blocks[0];
    expect(table?.type).toBe("table");
    expect(JSON.stringify(blocks)).not.toContain("| Name | Qty |");
    expect(assistantMarkdownVisibleText(blocks)).toBe(
      "NameQtyMacarons12Coffee2",
    );
  });

  it("keeps an incomplete **bold tail visible and does not throw", () => {
    expect(() => parseAssistantMarkdown("Wait **bold")).not.toThrow();
    const blocks = parseAssistantMarkdown("Wait **bold");
    expect(blocks).toEqual([
      {
        type: "paragraph",
        children: [{ type: "text", value: "Wait **bold" }],
      },
    ]);
    const visible = assistantMarkdownVisibleText(blocks);
    expect(visible).toContain("Wait");
    expect(visible).toContain("bold");
    expect(visible).toContain("**");
  });

  it("renders leftover T1 {…} JSON as text without throwing", () => {
    const leftover = '{"kind":"spoken","text":"hi"}';
    expect(() => parseAssistantMarkdown(leftover)).not.toThrow();
    const blocks = parseAssistantMarkdown(leftover);
    expect(blocks).toEqual([
      {
        type: "paragraph",
        children: [{ type: "text", value: leftover }],
      },
    ]);
    expect(assistantMarkdownVisibleText(blocks)).toBe(leftover);
  });

  it("keeps *italic* and _italic_ as emphasis", () => {
    expect(parseAssistantMarkdown("say *please* now")).toEqual([
      {
        type: "paragraph",
        children: [
          { type: "text", value: "say " },
          { type: "italic", children: [{ type: "text", value: "please" }] },
          { type: "text", value: " now" },
        ],
      },
    ]);
    expect(parseAssistantMarkdown("say _please_ now")).toEqual([
      {
        type: "paragraph",
        children: [
          { type: "text", value: "say " },
          { type: "italic", children: [{ type: "text", value: "please" }] },
          { type: "text", value: " now" },
        ],
      },
    ]);
  });

  it("does not treat order_id underscores as italic", () => {
    const blocks = parseAssistantMarkdown("see order_id later");
    expect(blocks).toEqual([
      {
        type: "paragraph",
        children: [{ type: "text", value: "see order_id later" }],
      },
    ]);
  });

  it("parses unordered and ordered lists", () => {
    const blocks = parseAssistantMarkdown(
      "- one\n- two\n\n1. first\n2. second",
    );
    expect(blocks).toEqual([
      {
        type: "list",
        ordered: false,
        start: 1,
        items: [
          [{ type: "text", value: "one" }],
          [{ type: "text", value: "two" }],
        ],
      },
      {
        type: "list",
        ordered: true,
        start: 1,
        items: [
          [{ type: "text", value: "first" }],
          [{ type: "text", value: "second" }],
        ],
      },
    ]);
  });

  it("parses ATX headings without introducing extra type sizes in the AST", () => {
    expect(parseAssistantMarkdown("# One\n## Two\n### Three")).toEqual([
      {
        type: "heading",
        level: 1,
        children: [{ type: "text", value: "One" }],
      },
      {
        type: "heading",
        level: 2,
        children: [{ type: "text", value: "Two" }],
      },
      {
        type: "heading",
        level: 3,
        children: [{ type: "text", value: "Three" }],
      },
    ]);
  });

  it("keeps a single newline inside a paragraph as a line break", () => {
    expect(parseAssistantMarkdown("hello\nworld")).toEqual([
      {
        type: "paragraph",
        children: [{ type: "text", value: "hello\nworld" }],
      },
    ]);
  });

  it("keeps a streaming table header without a separator as paragraph text", () => {
    const blocks = parseAssistantMarkdown("| Name | Qty |");
    expect(blocks[0]?.type).toBe("paragraph");
    expect(assistantMarkdownVisibleText(blocks)).toBe("| Name | Qty |");
  });
});

describe("assistant markdown links", () => {
  it("parses [label](href) and only http(s) call onOpenHref", () => {
    const blocks = parseAssistantMarkdown(
      "See [orders](https://showzy.test/orders) and [nope](javascript:alert(1)) and [plain](http://example.com).",
    );
    expect(assistantMarkdownHrefs(blocks)).toEqual([
      "https://showzy.test/orders",
      "javascript:alert(1)",
      "http://example.com",
    ]);

    const opened: string[] = [];
    const onOpenHref = vi.fn((href: string) => {
      opened.push(href);
    });
    openAssistantMarkdownHref("https://showzy.test/orders", onOpenHref);
    openAssistantMarkdownHref("http://example.com", onOpenHref);
    openAssistantMarkdownHref("javascript:alert(1)", onOpenHref);
    openAssistantMarkdownHref("JAVASCRIPT:void(0)", onOpenHref);
    openAssistantMarkdownHref("/orders/1", onOpenHref);
    openAssistantMarkdownHref("HTTPS://showzy.test/safe", onOpenHref);
    expect(opened).toEqual([
      "https://showzy.test/orders",
      "http://example.com",
      "HTTPS://showzy.test/safe",
    ]);
    expect(isSafeAssistantHref("javascript:alert(1)")).toBe(false);
    expect(isSafeAssistantHref("https://showzy.test/orders")).toBe(true);
  });
});

describe("assistant markdown bubble wiring (SHO-525)", () => {
  it("keeps user-role bubbles as plain Text so **not bold** stays literal", () => {
    expect(ROW).toContain("isUser ? (");
    expect(ROW).toContain(
      "<Text style={styles.userBubble}>{props.text}</Text>",
    );
    expect(ROW).not.toContain("parseAssistantMarkdown(props.text)");
    const userBranch = ROW.slice(
      ROW.indexOf("isUser ? ("),
      ROW.indexOf(") : ("),
    );
    expect(userBranch).toContain("{props.text}");
    expect(userBranch).not.toContain("AssistantMarkdownView");
    expect(userBranch).not.toContain("parseAssistantMarkdown");
  });

  it("renders assistant lists and tables without leaking a string outside Text", () => {
    const blocks = parseAssistantMarkdown(`- one\n- two\n\n${GFM_TABLE}`);
    expect(blocks.some((block) => block.type === "list")).toBe(true);
    expect(blocks.some((block) => block.type === "table")).toBe(true);

    expect(ROW).toContain("AssistantMarkdownView");
    expect(ROW).toContain("onOpenHref={props.onOpenHref}");
    expect(VIEW).toContain('case "list"');
    expect(VIEW).toContain('case "table"');
    expect(VIEW).toContain("ScrollView");
    expect(VIEW).toContain("horizontal");
    expect(VIEW).toContain("<Text>{node.value}</Text>");
    expect(VIEW).toContain("<Text style={styles.listMarker}>");
    expect(VIEW).not.toMatch(/<View[^>]*>\s*\{node\.value\}/);
    expect(VIEW).not.toMatch(/<View[^>]*>\s*\{item\}/);
    expect(VIEW).not.toMatch(/<ScrollView[^>]*>\s*\{/);
    expect(VIEW).toContain("MarkdownInlines");
    expect(VIEW).toContain("theme.typography.sm");
    expect(VIEW).not.toContain("theme.typography.xl");
    expect(VIEW).not.toContain("theme.typography.lg");
    expect(VIEW).not.toContain("WebView");
    expect(VIEW).not.toContain("dangerouslySetInnerHTML");
  });

  it("opens only http(s) from the markdown view", () => {
    expect(VIEW).toContain("isSafeAssistantHref");
    expect(VIEW).toContain("openAssistantMarkdownHref");
    expect(VIEW).toContain("onOpenHref");
    expect(VIEW).not.toContain("javascript:");
  });
});
