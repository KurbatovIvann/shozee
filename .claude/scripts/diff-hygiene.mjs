#!/usr/bin/env node
/**
 * Branch diff hygiene: the two limits that planning and review depend on.
 *
 * 1. Comments in `.ts`/`.tsx` (constitution: code has no comments). Scanned on
 *    the diff, not on a write, so no tool can route around it — the PreToolUse
 *    hook only sees Edit/Write, and a heredoc or a script is neither.
 * 2. The source-line budget. Tests are 1.5-4x the source by the definition of
 *    done, so a budget over all changed lines is unmeetable and gets ignored.
 *    Only source counts here: no tests, no generated files, no markdown.
 *
 * Usage: node .claude/scripts/diff-hygiene.mjs [--base <ref>] [--budget <n>]
 * Exit code: 0 when both limits hold, 1 otherwise.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const COMMENT_LINE = /^\s*(\/\/|\/\*|\*\s|\*\/|\*$)|[;{}()\],]\s+\/\/\s/;
const ALLOWED_ALWAYS = /eslint-disable|@ts-expect-error|@ts-ignore|@vitest-environment/;
// The ADR/spec reference is licensed only where the constitution licenses it:
// on an approved raw-SQL primitive. Anywhere else it is a comment wearing a
// citation, which is how an ADR-shaped slice ends up 28% comments.
const APPROVAL_REFERENCE = /ADR-\d{4}|docs\/specs\//;
const RAW_SQL = /\bsql`|\.execute\(|sql\.raw\(/;

const GENERATED =
  /(^pnpm-lock\.yaml$|^packages\/contract\/openapi\.json$|^apps\/web\/src\/routeTree\.gen\.ts$|^packages\/db\/src\/schema\/auth\.ts$|^packages\/db\/migrations\/|\.gen\.tsx?$|\.d\.ts$|\/__goldens__\/|\.snap$)/;
const TESTS = /(\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(__tests__|__mocks__|tests?)\/)/;
const PROSE = /(\.mdx?$|^docs\/)/;

function parseArgs(argv) {
  const opts = { base: null, budget: 400 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--base") opts.base = argv[++i];
    else if (argv[i] === "--budget") opts.budget = Number(argv[++i]);
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("node .claude/scripts/diff-hygiene.mjs [--base <ref>] [--budget <n>]");
      process.exit(0);
    } else throw new Error(`unknown option ${argv[i]}`);
  }
  if (!Number.isFinite(opts.budget) || opts.budget <= 0) throw new Error("--budget must be a positive number");
  return opts;
}

function git(args, cwd) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return res.status === 0 ? res.stdout : null;
}

const root = (git(["rev-parse", "--show-toplevel"], process.cwd()) ?? "").trim();
if (!root) throw new Error("not inside a git repository");
const opts = parseArgs(process.argv.slice(2));

function resolveBase(explicit) {
  if (explicit) {
    const sha = git(["rev-parse", "--verify", `${explicit}^{commit}`], root);
    if (!sha) throw new Error(`cannot resolve --base ${explicit}`);
    return { ref: explicit, sha: sha.trim() };
  }
  for (const candidate of ["origin/main", "main"]) {
    const sha = git(["merge-base", "HEAD", candidate], root);
    if (sha?.trim()) return { ref: candidate, sha: sha.trim() };
  }
  throw new Error("cannot find merge-base with origin/main or main");
}

const base = resolveBase(opts.base);

// file -> { added: [{ n, text }], addedCount, deletedCount }
const byFile = new Map();
const entry = (file) => {
  let e = byFile.get(file);
  if (!e) {
    e = { added: [], addedCount: 0, deletedCount: 0 };
    byFile.set(file, e);
  }
  return e;
};

function ingestDiff(text) {
  if (!text) return;
  let file = null;
  let line = 0;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).trim();
      file = p === "/dev/null" ? null : p.replace(/^b\//, "").replaceAll("\\", "/");
      continue;
    }
    if (raw.startsWith("@@")) {
      const m = raw.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
      line = m ? Number(m[1]) : 0;
      continue;
    }
    if (!file || raw.startsWith("---") || raw.startsWith("diff ") || raw.startsWith("index ")) continue;
    if (raw.startsWith("+")) {
      const e = entry(file);
      e.addedCount += 1;
      e.added.push({ n: line, text: raw.slice(1) });
      line += 1;
    } else if (raw.startsWith("-")) {
      entry(file).deletedCount += 1;
    }
  }
}

ingestDiff(git(["diff", "--unified=0", "--no-color", "--diff-filter=ACMR", `${base.sha}...HEAD`], root));
ingestDiff(git(["diff", "--unified=0", "--no-color", "--diff-filter=ACMR", "HEAD"], root));

for (const rel of (git(["ls-files", "--others", "--exclude-standard"], root) ?? "").split(/\r?\n/)) {
  const file = rel.trim().replaceAll("\\", "/");
  if (!file) continue;
  const abs = path.join(root, file);
  try {
    if (!statSync(abs).isFile()) continue;
    const e = entry(file);
    readFileSync(abs, "utf8")
      .split(/\r?\n/)
      .forEach((text, i) => {
        e.addedCount += 1;
        e.added.push({ n: i + 1, text });
      });
  } catch {
    /* unreadable working-tree file: nothing to scan */
  }
}

const bucketOf = (file) =>
  GENERATED.test(file) ? "generated" : TESTS.test(file) ? "tests" : PROSE.test(file) ? "prose" : "src";

const totals = { src: { a: 0, d: 0 }, tests: { a: 0, d: 0 }, prose: { a: 0, d: 0 }, generated: { a: 0, d: 0 } };
const srcFiles = [];
const offences = [];

for (const [file, e] of byFile) {
  const bucket = bucketOf(file);
  totals[bucket].a += e.addedCount;
  totals[bucket].d += e.deletedCount;
  if (bucket === "src") srcFiles.push({ file, changed: e.addedCount + e.deletedCount });

  if (GENERATED.test(file) || PROSE.test(file) || !/\.tsx?$/i.test(file)) continue;
  const body = e.added.map((l) => l.text).join("\n");
  const sqlApproved = RAW_SQL.test(body);
  for (const { n, text } of e.added) {
    if (!COMMENT_LINE.test(text)) continue;
    if (ALLOWED_ALWAYS.test(text)) continue;
    if (sqlApproved && APPROVAL_REFERENCE.test(text)) continue;
    offences.push({ file, n, text: text.trim().slice(0, 90) });
  }
}

const srcChanged = totals.src.a + totals.src.d;
const pct = (n) => {
  const real = totals.src.a + totals.tests.a + totals.prose.a;
  return real === 0 ? "0%" : `${Math.round((n / real) * 100)}%`;
};

console.log(`base ${base.ref} ${base.sha.slice(0, 8)}`);
console.log(
  `added: src ${totals.src.a} (${pct(totals.src.a)})  tests ${totals.tests.a} (${pct(totals.tests.a)})  ` +
    `prose ${totals.prose.a} (${pct(totals.prose.a)})  generated ${totals.generated.a} (not counted)`,
);
console.log(`src changed (added+deleted): ${srcChanged} / budget ${opts.budget}`);

let failed = false;

if (offences.length > 0) {
  failed = true;
  console.log(`\nFAIL comments in code: ${offences.length} line(s) (constitution: code has no comments).`);
  console.log("Express the intent through a name, a type, or a test. Permitted: eslint-disable /");
  console.log("@ts-expect-error with a linked issue, @vitest-environment, and an ADR/spec reference on an");
  console.log("approved raw-SQL primitive. First 10:");
  for (const o of offences.slice(0, 10)) console.log(`  ${o.file}:${o.n} — ${o.text}`);
}

if (srcChanged > opts.budget) {
  failed = true;
  console.log(`\nFAIL source budget: ${srcChanged} changed source lines over a budget of ${opts.budget}.`);
  console.log("This is a planning failure, not a formatting one: split the ticket and report it.");
  console.log("An implementer may not raise the budget — stop and hand the split back to the parent.");
  console.log("Largest source files:");
  for (const f of srcFiles.sort((a, b) => b.changed - a.changed).slice(0, 8)) {
    console.log(`  ${String(f.changed).padStart(5)}  ${f.file}`);
  }
}

if (!failed) console.log("\nOK comments: none; source budget: within limit.");
process.exit(failed ? 1 : 0);
