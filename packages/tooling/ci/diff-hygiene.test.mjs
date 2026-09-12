import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("../../../.claude/scripts/diff-hygiene.mjs", import.meta.url),
);

/**
 * A throwaway repository whose base commit is empty, so every file written
 * afterwards is what the gate sees as the branch diff.
 *
 * @param {Record<string, string>} files
 * @returns {{ status: number, output: string }}
 */
function scan(files, args = []) {
  const cwd = mkdtempSync(path.join(tmpdir(), "diff-hygiene-"));
  try {
    const git = (...a) => spawnSync("git", a, { cwd, encoding: "utf8" });
    git("init", "-b", "main");
    git("config", "user.email", "gate@example.test");
    git("config", "user.name", "gate");
    git("commit", "--allow-empty", "-m", "base");
    for (const [rel, body] of Object.entries(files)) {
      const abs = path.join(cwd, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, body);
    }
    const res = spawnSync(process.execPath, [script, ...args], {
      cwd,
      encoding: "utf8",
    });
    return {
      status: res.status ?? -1,
      output: `${res.stdout ?? ""}${res.stderr ?? ""}`,
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

const lines = (n, text) =>
  `${Array.from({ length: n }, (_, i) => `${text}${i}`).join("\n")}\n`;

test("clean source within the budget passes", () => {
  const res = scan({ "src/a.ts": "export const turnBudgetCapUsd = 1;\n" });
  assert.equal(res.status, 0);
  assert.match(res.output, /OK comments: none/);
});

test("a comment in code fails and names the line", () => {
  const res = scan({ "src/a.ts": "// why this exists\nexport const a = 1;\n" });
  assert.equal(res.status, 1);
  assert.match(res.output, /FAIL comments in code: 1 line/);
  assert.match(res.output, /src\/a\.ts:1/);
});

test("a JSDoc block is comments too", () => {
  const res = scan({
    "src/a.ts": "/**\n * One cap on a budget.\n */\nexport const a = 1;\n",
  });
  assert.equal(res.status, 1);
  assert.match(res.output, /FAIL comments in code/);
});

test("an ADR citation is not a license on its own", () => {
  const res = scan({
    "src/a.ts": "// The API is the producer (ADR-0039).\nexport const a = 1;\n",
  });
  assert.equal(res.status, 1);
  assert.match(res.output, /ADR-0039/);
});

test("an ADR citation is licensed in a file that adds a raw-SQL primitive", () => {
  const res = scan({
    "src/a.ts":
      "// Approved by ADR-0039: Drizzle cannot express this.\nawait db.execute(sql`select 1`);\n",
  });
  assert.equal(res.status, 0);
});

test("eslint-disable and @vitest-environment stay permitted", () => {
  const res = scan({
    "src/a.ts":
      "// eslint-disable-next-line no-control-regex\nexport const a = 1;\n",
    "src/a.test.ts": "// @vitest-environment node\nexport const b = 2;\n",
  });
  assert.equal(res.status, 0);
});

test("markdown and docs are not scanned for comments", () => {
  const res = scan({
    "docs/x.md": "// not code\n",
    "README.md": "/* not code */\n",
  });
  assert.equal(res.status, 0);
});

test("tests do not spend the source budget", () => {
  const res = scan({
    "src/a.ts": lines(100, "export const a"),
    "src/a.test.ts": lines(900, "export const t"),
  });
  assert.equal(res.status, 0);
  assert.match(res.output, /tests 90[01] \(9\d%\)/);
});

test("generated files do not spend the source budget", () => {
  const res = scan({
    "src/a.ts": lines(50, "export const a"),
    "pnpm-lock.yaml": lines(5000, "  entry"),
    "packages/db/migrations/0001_x.sql": lines(600, "select 1; --"),
    "apps/web/src/routeTree.gen.ts": lines(600, "export const r"),
  });
  assert.equal(res.status, 0);
  assert.match(res.output, /generated \d+ \(not counted\)/);
});

test("the default budget is 800 source lines", () => {
  assert.equal(scan({ "src/a.ts": lines(700, "export const a") }).status, 0);
  const over = scan({ "src/a.ts": lines(900, "export const a") });
  assert.equal(over.status, 1);
  assert.match(over.output, /budget 800/);
});

test("source over the budget fails as a planning failure", () => {
  const res = scan({ "src/a.ts": lines(900, "export const a") });
  assert.equal(res.status, 1);
  assert.match(res.output, /FAIL source budget: 90\d changed source lines/);
  assert.match(res.output, /planning failure/);
  assert.match(res.output, /src\/a\.ts/);
});

test("--budget raises the limit, for the parent only", () => {
  const res = scan({ "src/a.ts": lines(900, "export const a") }, [
    "--budget",
    "1200",
  ]);
  assert.equal(res.status, 0);
});

test("settings registers the comment hook on Bash as well as on writes", () => {
  const settings = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../../.claude/settings.json", import.meta.url)),
      "utf8",
    ),
  );
  const matchers = settings.hooks.PreToolUse.filter((e) =>
    e.hooks.some((h) => String(h.command).includes("no-comments.mjs")),
  ).map((e) => e.matcher);
  assert.ok(
    matchers.some((m) => m.includes("Write")),
    "write tools are matched",
  );
  assert.ok(matchers.includes("Bash"), "Bash is matched");
});

const hook = fileURLToPath(
  new URL("../../../.claude/hooks/no-comments.mjs", import.meta.url),
);

/**
 * The PreToolUse hook is the early half of the same rule: it sees one write,
 * the gate sees the branch. Their licenses must agree, or an agent learns the
 * rule from whichever is looser.
 *
 * @param {string} filePath
 * @param {string} content
 * @returns {number}
 */
function hookExit(filePath, content) {
  const res = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ tool_input: { file_path: filePath, content } }),
    encoding: "utf8",
  });
  return res.status ?? -1;
}

test("the write hook blocks the comments the gate blocks", () => {
  assert.equal(hookExit("a.ts", "// why this exists\nconst a = 1;\n"), 2);
  assert.equal(
    hookExit("a.ts", "/**\n * A budget cap.\n */\nconst a = 1;\n"),
    2,
  );
  assert.equal(
    hookExit("a.ts", "// The API is the producer (ADR-0039).\nconst a = 1;\n"),
    2,
  );
});

test("the write hook licenses what the gate licenses", () => {
  assert.equal(
    hookExit(
      "a.ts",
      "// Approved by ADR-0039: Drizzle cannot express this.\nawait db.execute(sql`select 1`);\n",
    ),
    0,
  );
  assert.equal(
    hookExit(
      "a.ts",
      "// eslint-disable-next-line no-control-regex\nconst a = 1;\n",
    ),
    0,
  );
  assert.equal(
    hookExit("a.test.ts", "// @vitest-environment node\nconst a = 1;\n"),
    0,
  );
  assert.equal(hookExit("a.ts", "const turnBudgetCapUsd = 1;\n"), 0);
  assert.equal(hookExit("a.md", "// not code\n"), 0);
});

/**
 * @param {string} command
 * @returns {number}
 */
function hookBashExit(command) {
  const res = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: "utf8",
  });
  return res.status ?? -1;
}

const heredoc = (target, body) => `cat > ${target} <<XEOF\n${body}\nXEOF`;

test("a TypeScript file written through Bash is checked, not waved through", () => {
  assert.equal(hookBashExit(heredoc("src/a.ts", "// why\nconst a = 1;")), 2);
  assert.equal(hookBashExit(heredoc("src/a.tsx", "/**\n * head\n */")), 2);
  assert.equal(
    hookBashExit(`cat <<XEOF | tee src/a.ts\n// why\nconst a = 1;\nXEOF`),
    2,
    "tee is a write target too",
  );
  assert.equal(hookBashExit(heredoc("src/a.ts", "const a = 1;")), 0);
});

test("a comment folded into one shell argument is the diff gate's job", () => {
  assert.equal(hookBashExit(`printf "// why\\nconst a = 1;\\n" > src/a.ts`), 0);
  assert.equal(hookBashExit(`echo "// why" > src/a.ts`), 0);
});

test("Bash that does not write TypeScript is left alone", () => {
  assert.equal(
    hookBashExit(heredoc("t.test.mjs", 'assert("src/a.ts");')),
    0,
    "a .ts path it merely names is not a write target",
  );
  assert.equal(hookBashExit(heredoc("docs/x.md", "// prose")), 0);
  assert.equal(hookBashExit("pnpm exec prettier --write src/a.ts"), 0);
  assert.equal(hookBashExit("grep -n foo src/a.ts"), 0);
  assert.equal(hookBashExit("sed -i s/foo/bar/ src/a.ts"), 0);
  assert.equal(hookBashExit('git commit -m "x"'), 0);
});
