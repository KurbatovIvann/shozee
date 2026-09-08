/**
 * Closed markdown subset for staff assistant bubbles (SHO-525).
 * Streaming-safe: unclosed markers stay visible as plain text.
 */

export type MarkdownInline =
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "bold"; readonly children: readonly MarkdownInline[] }
  | { readonly type: "italic"; readonly children: readonly MarkdownInline[] }
  | { readonly type: "code"; readonly value: string }
  | {
      readonly type: "link";
      readonly href: string;
      readonly children: readonly MarkdownInline[];
    };

export type MarkdownBlock =
  | { readonly type: "paragraph"; readonly children: readonly MarkdownInline[] }
  | {
      readonly type: "heading";
      readonly level: 1 | 2 | 3;
      readonly children: readonly MarkdownInline[];
    }
  | {
      readonly type: "list";
      readonly ordered: boolean;
      readonly start: number;
      readonly items: readonly (readonly MarkdownInline[])[];
    }
  | {
      readonly type: "table";
      readonly header: readonly (readonly MarkdownInline[])[];
      readonly rows: readonly (readonly (readonly MarkdownInline[])[])[];
    };

const HEADING_LINE = /^(#{1,3}) (.+)$/;
const UNORDERED_LINE = /^([-*+]) (.+)$/;
const ORDERED_LINE = /^(\d+)\. (.+)$/;
const TABLE_SEPARATOR_CELL = /^:?-{3,}:?$/;

export function isSafeAssistantHref(href: string): boolean {
  const trimmed = href.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return false;
  }
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function openAssistantMarkdownHref(
  href: string,
  onOpenHref: (href: string) => void,
): void {
  if (isSafeAssistantHref(href)) {
    onOpenHref(href);
  }
}

export function parseAssistantMarkdown(
  source: string,
): readonly MarkdownBlock[] {
  const lines = source.split(/\r?\n/);
  const blocks: MarkdownBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) {
      break;
    }
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }
    const table = tryParseTable(lines, index);
    if (table !== null) {
      blocks.push(table.block);
      index = table.nextIndex;
      continue;
    }
    const heading = tryParseHeading(line);
    if (heading !== null) {
      blocks.push(heading);
      index += 1;
      continue;
    }
    const list = tryParseList(lines, index);
    if (list !== null) {
      blocks.push(list.block);
      index = list.nextIndex;
      continue;
    }
    const paragraph = parseParagraph(lines, index);
    blocks.push(paragraph.block);
    index = paragraph.nextIndex;
  }
  return blocks;
}

export function assistantMarkdownVisibleText(
  blocks: readonly MarkdownBlock[],
): string {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "paragraph":
      case "heading":
        walkInlines(block.children, parts);
        break;
      case "list":
        for (const item of block.items) {
          walkInlines(item, parts);
        }
        break;
      case "table":
        for (const cell of block.header) {
          walkInlines(cell, parts);
        }
        for (const row of block.rows) {
          for (const cell of row) {
            walkInlines(cell, parts);
          }
        }
        break;
    }
  }
  return parts.join("");
}

export function assistantMarkdownHrefs(
  blocks: readonly MarkdownBlock[],
): readonly string[] {
  const hrefs: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "paragraph":
      case "heading":
        collectHrefs(block.children, hrefs);
        break;
      case "list":
        for (const item of block.items) {
          collectHrefs(item, hrefs);
        }
        break;
      case "table":
        for (const cell of block.header) {
          collectHrefs(cell, hrefs);
        }
        for (const row of block.rows) {
          for (const cell of row) {
            collectHrefs(cell, hrefs);
          }
        }
        break;
    }
  }
  return hrefs;
}

function walkInlines(nodes: readonly MarkdownInline[], parts: string[]): void {
  for (const node of nodes) {
    switch (node.type) {
      case "text":
      case "code":
        parts.push(node.value);
        break;
      case "bold":
      case "italic":
      case "link":
        walkInlines(node.children, parts);
        break;
    }
  }
}

function collectHrefs(nodes: readonly MarkdownInline[], hrefs: string[]): void {
  for (const node of nodes) {
    switch (node.type) {
      case "link":
        hrefs.push(node.href);
        collectHrefs(node.children, hrefs);
        break;
      case "bold":
      case "italic":
        collectHrefs(node.children, hrefs);
        break;
      case "text":
      case "code":
        break;
    }
  }
}

function tryParseHeading(line: string): MarkdownBlock | null {
  const match = HEADING_LINE.exec(line);
  if (match === null) {
    return null;
  }
  const hashes = match[1];
  const content = match[2];
  if (hashes === undefined || content === undefined) {
    return null;
  }
  const level = hashes.length;
  if (level !== 1 && level !== 2 && level !== 3) {
    return null;
  }
  return {
    type: "heading",
    level,
    children: parseInlines(content),
  };
}

function tryParseList(
  lines: readonly string[],
  start: number,
): { readonly block: MarkdownBlock; readonly nextIndex: number } | null {
  const first = lines[start];
  if (first === undefined) {
    return null;
  }
  const unordered = UNORDERED_LINE.exec(first);
  const ordered = ORDERED_LINE.exec(first);
  if (unordered === null && ordered === null) {
    return null;
  }
  const isOrdered = ordered !== null;
  const startNumber = isOrdered ? Number.parseInt(ordered[1] ?? "1", 10) : 1;
  const items: (readonly MarkdownInline[])[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || line.trim().length === 0) {
      break;
    }
    if (tryParseHeading(line) !== null || isTableSeparator(line)) {
      break;
    }
    if (isOrdered) {
      const item = ORDERED_LINE.exec(line);
      if (item === null || item[2] === undefined) {
        break;
      }
      items.push(parseInlines(item[2]));
    } else {
      const item = UNORDERED_LINE.exec(line);
      if (item === null || item[2] === undefined) {
        break;
      }
      items.push(parseInlines(item[2]));
    }
    index += 1;
  }
  if (items.length === 0) {
    return null;
  }
  return {
    block: {
      type: "list",
      ordered: isOrdered,
      start: Number.isFinite(startNumber) ? startNumber : 1,
      items,
    },
    nextIndex: index,
  };
}

function tryParseTable(
  lines: readonly string[],
  start: number,
): { readonly block: MarkdownBlock; readonly nextIndex: number } | null {
  const headerLine = lines[start];
  const separatorLine = lines[start + 1];
  if (headerLine === undefined || separatorLine === undefined) {
    return null;
  }
  if (!headerLine.includes("|") || !isTableSeparator(separatorLine)) {
    return null;
  }
  const headerCells = splitTableRow(headerLine);
  const separatorCells = splitTableRow(separatorLine);
  if (headerCells.length === 0 || separatorCells.length === 0) {
    return null;
  }
  const width = headerCells.length;
  const header = headerCells.map((cell) => parseInlines(cell));
  const rows: (readonly (readonly MarkdownInline[])[])[] = [];
  let index = start + 2;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || line.trim().length === 0) {
      break;
    }
    if (!line.includes("|")) {
      break;
    }
    if (tryParseHeading(line) !== null) {
      break;
    }
    const cells = splitTableRow(line);
    const padded: string[] = [];
    for (let cellIndex = 0; cellIndex < width; cellIndex += 1) {
      padded.push(cells[cellIndex] ?? "");
    }
    rows.push(padded.map((cell) => parseInlines(cell)));
    index += 1;
  }
  return {
    block: { type: "table", header, rows },
    nextIndex: index,
  };
}

function parseParagraph(
  lines: readonly string[],
  start: number,
): { readonly block: MarkdownBlock; readonly nextIndex: number } {
  const chunk: string[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || line.trim().length === 0) {
      break;
    }
    if (tryParseHeading(line) !== null) {
      break;
    }
    if (UNORDERED_LINE.test(line) || ORDERED_LINE.test(line)) {
      break;
    }
    if (
      line.includes("|") &&
      index + 1 < lines.length &&
      isTableSeparator(lines[index + 1] ?? "")
    ) {
      break;
    }
    chunk.push(line);
    index += 1;
  }
  return {
    block: {
      type: "paragraph",
      children: parseInlines(chunk.join("\n")),
    },
    nextIndex: index,
  };
}

function isTableSeparator(line: string): boolean {
  if (!line.includes("|") || !line.includes("-")) {
    return false;
  }
  const cells = splitTableRow(line);
  if (cells.length === 0) {
    return false;
  }
  return cells.every((cell) => TABLE_SEPARATOR_CELL.test(cell.trim()));
}

function splitTableRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) {
    body = body.slice(1);
  }
  if (body.endsWith("|")) {
    body = body.slice(0, -1);
  }
  if (body.length === 0) {
    return [];
  }
  return body.split("|").map((cell) => cell.trim());
}

function parseInlines(input: string): MarkdownInline[] {
  const nodes: MarkdownInline[] = [];
  let index = 0;

  const pushText = (value: string): void => {
    if (value.length === 0) {
      return;
    }
    const last = nodes[nodes.length - 1];
    if (last?.type === "text") {
      nodes[nodes.length - 1] = { type: "text", value: last.value + value };
      return;
    }
    nodes.push({ type: "text", value });
  };

  while (index < input.length) {
    const rest = input.slice(index);
    const previous = index === 0 ? undefined : input[index - 1];

    if (rest.startsWith("`")) {
      const close = rest.indexOf("`", 1);
      if (close === -1) {
        pushText(rest);
        break;
      }
      const inner = rest.slice(1, close);
      if (inner.length === 0) {
        pushText("`");
        index += 1;
        continue;
      }
      nodes.push({ type: "code", value: inner });
      index += close + 1;
      continue;
    }

    if (rest.startsWith("[")) {
      const link = tryParseLink(rest);
      if (link !== null) {
        nodes.push(link.node);
        index += link.consumed;
        continue;
      }
      pushText("[");
      index += 1;
      continue;
    }

    if (rest.startsWith("**")) {
      const close = rest.indexOf("**", 2);
      if (close === -1) {
        pushText(rest);
        break;
      }
      const inner = rest.slice(2, close);
      if (inner.length === 0) {
        pushText("**");
        index += 2;
        continue;
      }
      nodes.push({ type: "bold", children: parseInlines(inner) });
      index += close + 2;
      continue;
    }

    if (rest.startsWith("*") && canOpenEmphasis(previous, rest[1])) {
      const close = findStarItalicClose(rest);
      if (close === null) {
        pushText(rest);
        break;
      }
      nodes.push({
        type: "italic",
        children: parseInlines(rest.slice(1, close)),
      });
      index += close + 1;
      continue;
    }

    if (
      rest.startsWith("_") &&
      rest[1] !== "_" &&
      canOpenEmphasis(previous, rest[1])
    ) {
      const close = findUnderscoreItalicClose(rest);
      if (close === null) {
        pushText(rest);
        break;
      }
      if (close < 0) {
        pushText("_");
        index += 1;
        continue;
      }
      nodes.push({
        type: "italic",
        children: parseInlines(rest.slice(1, close)),
      });
      index += close + 1;
      continue;
    }

    const nextSpecial = rest.search(/[`*_[]/);
    if (nextSpecial === -1) {
      pushText(rest);
      break;
    }
    if (nextSpecial === 0) {
      pushText(rest[0] ?? "");
      index += 1;
      continue;
    }
    pushText(rest.slice(0, nextSpecial));
    index += nextSpecial;
  }

  return nodes;
}

function tryParseLink(
  rest: string,
): { readonly node: MarkdownInline; readonly consumed: number } | null {
  const closeLabel = rest.indexOf("]");
  if (closeLabel <= 1) {
    return null;
  }
  if (rest[closeLabel + 1] !== "(") {
    return null;
  }
  const closeUrl = findBalancedClose(rest, closeLabel + 1);
  if (closeUrl === -1) {
    return null;
  }
  const label = rest.slice(1, closeLabel);
  const href = rest.slice(closeLabel + 2, closeUrl).trim();
  if (label.length === 0 || href.length === 0) {
    return null;
  }
  return {
    node: {
      type: "link",
      href,
      children: parseInlines(label),
    },
    consumed: closeUrl + 1,
  };
}

function findBalancedClose(input: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < input.length; index += 1) {
    const ch = input[index];
    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function findStarItalicClose(rest: string): number | null {
  for (let index = 1; index < rest.length; index += 1) {
    if (rest[index] !== "*") {
      continue;
    }
    if (rest[index + 1] === "*") {
      index += 1;
      continue;
    }
    const inner = rest.slice(1, index);
    if (inner.length === 0) {
      return null;
    }
    return index;
  }
  return null;
}

function findUnderscoreItalicClose(rest: string): number | null {
  for (let index = 1; index < rest.length; index += 1) {
    if (rest[index] !== "_") {
      continue;
    }
    const inner = rest.slice(1, index);
    if (inner.length === 0) {
      return -1;
    }
    const next = rest[index + 1];
    if (isWordChar(next)) {
      continue;
    }
    return index;
  }
  return null;
}

function canOpenEmphasis(
  previous: string | undefined,
  next: string | undefined,
): boolean {
  if (next === undefined || next === " " || next === "\n") {
    return false;
  }
  return !isWordChar(previous);
}

function isWordChar(ch: string | undefined): boolean {
  if (ch === undefined || ch.length === 0) {
    return false;
  }
  const code = ch.codePointAt(0);
  if (code === undefined) {
    return false;
  }
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 0x400 && code <= 0x52f)
  );
}
