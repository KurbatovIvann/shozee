import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildTurboArgs } from "../../../.claude/scripts/verify.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const BASE_SHA = "0123456789abcdef0123456789abcdef01234567";
const AFFECTED_TASKS = ["typecheck", "lint", "test:unit"];

test("affected gates select changed packages and their dependents", () => {
  for (const task of AFFECTED_TASKS) {
    const args = buildTurboArgs(task, {
      full: false,
      baseSha: BASE_SHA,
      files: ["packages/validation/src/assistant-events.ts"],
    });
    assert.ok(
      args.includes(`--filter=...[${BASE_SHA}]`),
      `${task} must keep the leading ... so dependents of a changed package are selected`,
    );
  }
});

test("affected gates never replay a cached pass", () => {
  for (const task of AFFECTED_TASKS) {
    const args = buildTurboArgs(task, {
      full: false,
      baseSha: BASE_SHA,
      files: ["packages/validation/src/assistant-events.ts"],
    });
    assert.ok(
      args.includes("--cache=local:w"),
      `${task} must not read the Turbo cache: a dependent keeps its hash when a dependency's source changes`,
    );
    assert.ok(!args.includes("--cache=local:rw"));
  }
});

test("--full drops the package filter and still refuses a cached replay", () => {
  const args = buildTurboArgs("test:unit", {
    full: true,
    baseSha: BASE_SHA,
    files: [],
    extra: ["--concurrency=2"],
  });
  assert.equal(args.filter((arg) => arg.startsWith("--filter=")).length, 0);
  assert.ok(args.includes("--cache=local:w"));
  assert.ok(args.includes("--concurrency=2"));
});

test("workflow changes add the @showzy/tooling filter", () => {
  const args = buildTurboArgs("test:unit", {
    full: false,
    baseSha: BASE_SHA,
    files: [".github/workflows/ci.yml"],
  });
  assert.ok(args.includes("--filter=@showzy/tooling"));
});

test("@showzy/mobile declares the test:unit script the gate runs", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "apps/mobile/package.json"), "utf8"),
  );
  assert.equal(manifest.name, "@showzy/mobile");
  assert.equal(typeof manifest.scripts["test:unit"], "string");
});

test("a changed @showzy/validation puts @showzy/mobile#test:unit in scope", () => {
  const result = spawnSync(
    "pnpm exec turbo run test:unit --filter=...@showzy/validation --dry=json --cache=local:w",
    { cwd: repoRoot, encoding: "utf8", timeout: 180_000, shell: true },
  );
  const stdout = result.stdout ?? "";
  assert.equal(
    result.status,
    0,
    `turbo dry-run failed:\n${stdout}\n${result.stderr ?? ""}`,
  );
  const plan = JSON.parse(stdout.slice(stdout.indexOf("{")));
  assert.ok(
    plan.packages.includes("@showzy/mobile"),
    "@showzy/mobile must be selected as a dependent of @showzy/validation",
  );
  assert.ok(
    plan.tasks.some((task) => task.taskId === "@showzy/mobile#test:unit"),
    "@showzy/mobile#test:unit must be planned, not only in scope",
  );
});
