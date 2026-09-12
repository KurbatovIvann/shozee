#!/usr/bin/env node
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

const texts = [];
if (command !== "") texts.push(command);
if (typeof toolInput.content === "string") texts.push(toolInput.content);
if (typeof toolInput.new_string === "string") texts.push(toolInput.new_string);
for (const edit of toolInput.edits ?? []) {
  if (typeof edit?.new_string === "string") texts.push(edit.new_string);
}

const offending = [];
for (const text of texts) {
  // An ADR or spec citation is licensed only where the constitution licenses
  // it: on an approved raw-SQL primitive. Anywhere else it is a comment
  // wearing a citation, which is how an ADR-shaped slice turns into prose.
  const sqlApproved = RAW_SQL.test(text);
  for (const line of text.split(/\r?\n/)) {
    if (!COMMENT_LINE.test(line)) continue;
    if (ALLOWED.test(line)) continue;
    if (sqlApproved && APPROVAL_REFERENCE.test(line)) continue;
    offending.push(line.trim().slice(0, 80));
    if (offending.length >= 3) break;
  }
}

if (offending.length > 0) {
  process.stderr.write(
    `Blocked by .claude/hooks/no-comments.mjs: ${target} — code has no comments (constitution). Do not write them in the first place: a blocked write costs the tokens twice, once to type and once to strip. Express the intent through names, types, or a test. First offending lines:\n  ${offending.join("\n  ")}\n`,
  );
  process.exit(2);
}
process.exit(0);
