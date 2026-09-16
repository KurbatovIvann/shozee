#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";

const ALLOWED = /eslint-disable|@ts-expect-error|@ts-ignore|@vitest-environment/;
const APPROVAL_REFERENCE = /ADR-\d{4}|docs\/specs\//;
const RAW_SQL = /\bsql`|\.execute\(|sql\.raw\(/;
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*\s|\*\/|\*$)|[;{}()\],]\s+\/\/\s/;

// A heredoc, a redirect or `sed -i` writes a file without ever passing through
// Edit or Write, so this hook saw nothing. That bypass is how comments reach
// `.ts` files while the write-time guard reports clean. Only the write target
// counts: a command may name a `.ts` path it merely reads, greps or formats.
const WRITE_TARGETS = [
  /(?:>{1,2})\s*([^\s|;&<>]+)/g,
  /\btee\s+(?:-a\s+)?([^\s|;&<>]+)/g,
  /\b(?:sed|perl)\s+-i\S*\s+(?:-e\s+\S+\s+)?([^\s|;&<>]+)/g,
];

function writesTypeScript(cmd) {
  for (const re of WRITE_TARGETS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(cmd)) !== null) {
      if (/\.tsx?$/i.test(m[1])) return true;
    }
  }
  return false;
}

// Only a comment the write *adds* is an offence. An edit that removes one
// bullet from a block, or rewrites code around comments it leaves alone, hands
// the hook a `new_string` full of comment lines that were already on disk;
// blocking those made a stale comment unremovable by any writing tool. The
// baseline is the text the edit replaces, matched line for line.
function commentBaseline(text) {
  const counts = new Map();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!COMMENT_LINE.test(line)) continue;
    const key = line.trim();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function alreadyPresent(baseline, line) {
  const key = line.trim();
  const left = baseline.get(key) ?? 0;
  if (left === 0) return false;
  baseline.set(key, left - 1);
  return true;
}

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
const command = String(toolInput.command ?? "");
const target = filePath === "" ? "a .ts file written through Bash" : path.basename(filePath);

if (filePath === "") {
  if (command === "") process.exit(0);
  if (!writesTypeScript(command)) process.exit(0);
} else {
  if (!/\.(ts|tsx)$/i.test(filePath)) process.exit(0);
  if (/\.d\.ts$/i.test(filePath) || /[\/]docs[\/]/i.test(filePath)) process.exit(0);
}

function fileOnDisk(p) {
  if (p === "") return "";
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

const writes = [];
if (command !== "") writes.push({ text: command, before: "" });
if (typeof toolInput.content === "string") {
  writes.push({ text: toolInput.content, before: fileOnDisk(filePath) });
}
if (typeof toolInput.new_string === "string") {
  writes.push({ text: toolInput.new_string, before: String(toolInput.old_string ?? "") });
}
for (const edit of toolInput.edits ?? []) {
  if (typeof edit?.new_string === "string") {
    writes.push({ text: edit.new_string, before: String(edit.old_string ?? "") });
  }
}

const offending = [];
for (const { text, before } of writes) {
  // An ADR or spec citation is licensed only where the constitution licenses
  // it: on an approved raw-SQL primitive. Anywhere else it is a comment
  // wearing a citation, which is how an ADR-shaped slice turns into prose.
  const sqlApproved = RAW_SQL.test(text);
  const baseline = commentBaseline(before);
  for (const line of text.split(/\r?\n/)) {
    if (!COMMENT_LINE.test(line)) continue;
    if (ALLOWED.test(line)) continue;
    if (sqlApproved && APPROVAL_REFERENCE.test(line)) continue;
    if (alreadyPresent(baseline, line)) continue;
    offending.push(line.trim().slice(0, 80));
    if (offending.length >= 3) break;
  }
}

if (offending.length > 0) {
  process.stderr.write(
    `Blocked by .claude/hooks/no-comments.mjs: ${target} — code has no comments (constitution). Only comment lines this write adds are blocked; deleting one, or leaving one the edit does not touch, is allowed. Do not write them in the first place: a blocked write costs the tokens twice, once to type and once to strip. Express the intent through names, types, or a test. First offending lines:\n  ${offending.join("\n  ")}\n`,
  );
  process.exit(2);
}
process.exit(0);
