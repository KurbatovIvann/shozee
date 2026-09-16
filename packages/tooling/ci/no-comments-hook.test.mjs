import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const hook = fileURLToPath(
  new URL("../../../.claude/hooks/no-comments.mjs", import.meta.url),
);

/**
 * Runs the PreToolUse hook over one tool call.
 *
 * @param {Record<string, unknown>} toolInput
 * @returns {{ status: number, stderr: string }}
 */
function run(toolInput) {
  const res = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ tool_input: toolInput }),
    encoding: "utf8",
  });
  return { status: res.status ?? 0, stderr: res.stderr ?? "" };
}

function withFile(body, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "no-comments-"));
  try {
    const file = path.join(dir, "subject.ts");
    writeFileSync(file, body);
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const BLOCK = [
  "/**",
  " * Queued turns wait for the runner.",
  " * The job carries the identity.",
  " */",
].join("\n");

test("blocks an edit that adds a comment", () => {
  const res = run({
    file_path: "packages/modules/orders/src/actions/confirm.ts",
    old_string: "const total = sum(items);",
    new_string: "// totals are snapshots\nconst total = sum(items);",
  });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /totals are snapshots/);
});

test("allows an edit that deletes a comment line from a block it keeps", () => {
  const res = run({
    file_path: "apps/worker/src/policy.ts",
    old_string: BLOCK,
    new_string: ["/**", " * Queued turns wait for the runner.", " */"].join(
      "\n",
    ),
  });
  assert.equal(res.status, 0, res.stderr);
});

test("allows an edit that deletes a whole comment block", () => {
  const res = run({
    file_path: "apps/worker/src/policy.ts",
    old_string: `${BLOCK}\nexport const DRAIN_MS = 210_000;`,
    new_string: "export const DRAIN_MS = 210_000;",
  });
  assert.equal(res.status, 0, res.stderr);
});

test("blocks a new comment smuggled into an edit that also deletes one", () => {
  const res = run({
    file_path: "apps/worker/src/policy.ts",
    old_string: BLOCK,
    new_string: [
      "/**",
      " * Queued turns wait for the runner.",
      " * Rewritten for pg-boss.",
      " */",
    ].join("\n"),
  });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /Rewritten for pg-boss/);
});

test("counts repeats: two identical comment lines where one existed is an addition", () => {
  const res = run({
    file_path: "apps/worker/src/policy.ts",
    old_string: "// keep\nconst a = 1;",
    new_string: "// keep\nconst a = 1;\n// keep\nconst b = 2;",
  });
  assert.equal(res.status, 2);
});

test("allows a multi-edit whose every comment line came from the text it replaces", () => {
  const res = run({
    file_path: "apps/worker/src/loop.ts",
    edits: [
      {
        old_string: BLOCK,
        new_string: ["/**", " * Queued turns wait for the runner.", " */"].join(
          "\n",
        ),
      },
      { old_string: "// legacy\nrun();", new_string: "run();" },
    ],
  });
  assert.equal(res.status, 0, res.stderr);
});

test("a Write keeping the file's existing comments is allowed, adding one is not", () => {
  withFile(`${BLOCK}\nexport const DRAIN_MS = 210_000;\n`, (file) => {
    const kept = run({
      file_path: file,
      content: `${BLOCK}\nexport const DRAIN_MS = 240_000;\n`,
    });
    assert.equal(kept.status, 0, kept.stderr);

    const added = run({
      file_path: file,
      content: `${BLOCK}\n// bumped for the shared host\nexport const DRAIN_MS = 240_000;\n`,
    });
    assert.equal(added.status, 2);
    assert.match(added.stderr, /bumped for the shared host/);
  });
});

test("still blocks a heredoc that writes a comment into a .ts file", () => {
  const res = run({
    command:
      "cat <<'EOF' > apps/worker/src/policy.ts\n// smuggled\nexport const A = 1;\nEOF",
  });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /smuggled/);
});

test("still allows the licensed exceptions", () => {
  const res = run({
    file_path: "packages/modules/orders/src/services/totals.ts",
    old_string: "const rows = await q();",
    new_string:
      "// eslint-disable-next-line no-restricted-syntax\nconst rows = await q();",
  });
  assert.equal(res.status, 0, res.stderr);
});
