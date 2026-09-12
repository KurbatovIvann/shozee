#!/usr/bin/env node
import path from "node:path";

const ALLOWED = /eslint-disable|@ts-expect-error|@ts-ignore|@vitest-environment|ADR-\d{4}|docs\/specs\//;
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*\s|\*\/)|[;{}()\],]\s+\/\/\s/;

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}

let input;
try {
  input = JSON.parse(await readStdin());
} catch {
  process.exit(0);
}

const toolInput = input?.tool_input ?? {};
const filePath = String(toolInput.file_path ?? "");
if (!/\.(ts|tsx)$/i.test(filePath)) process.exit(0);
if (/\.d\.ts$/i.test(filePath) || /[\\/]docs[\\/]/i.test(filePath)) process.exit(0);

const texts = [];
if (typeof toolInput.content === "string") texts.push(toolInput.content);
if (typeof toolInput.new_string === "string") texts.push(toolInput.new_string);
for (const edit of toolInput.edits ?? []) {
  if (typeof edit?.new_string === "string") texts.push(edit.new_string);
}

const offending = [];
for (const text of texts) {
  for (const line of text.split(/\r?\n/)) {
    if (COMMENT_LINE.test(line) && !ALLOWED.test(line)) offending.push(line.trim().slice(0, 80));
    if (offending.length >= 3) break;
  }
}

if (offending.length > 0) {
  process.stderr.write(
    `Blocked by .claude/hooks/no-comments.mjs: ${path.basename(filePath)} — code has no comments (constitution). Remove them and express the intent through names, types, or a test. First offending lines:\n  ${offending.join("\n  ")}\n`,
  );
  process.exit(2);
}
process.exit(0);
