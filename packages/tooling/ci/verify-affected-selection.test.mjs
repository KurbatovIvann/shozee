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
const PROOF_PACKAGE = "@showzy/copy";
const PROOF_TASK = "typecheck";
const TURBO_TIMEOUT_MS = 180_000;

function runTurbo(command) {
  return spawnSync(command, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: TURBO_TIMEOUT_MS,
    shell: true,
  });
}

function dryRunCacheStatus(args, taskId) {
  const result = runTurbo(["pnpm", ...args, "--dry=json"].join(" "));
  const stdout = result.stdout ?? "";
  assert.equal(
    result.status,
    0,
    `turbo dry-run failed:\n${stdout}\n${result.stderr ?? ""}`,
  );
  const plan = JSON.parse(stdout.slice(stdout.indexOf("{")));
  const planned = plan.tasks.find((task) => task.taskId === taskId);
  assert.ok(planned, `${taskId} must be planned by: ${args.join(" ")}`);
  return planned.cache.status;
}

function cacheMode(args) {
  return args.find((arg) => arg.startsWith("--cache="));
}

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

test("a selected package misses the Turbo cache under the flags verify builds", (t) => {
  const primed = runTurbo(
    `pnpm exec turbo run ${PROOF_TASK} --filter=${PROOF_PACKAGE} --cache=local:rw --output-logs=errors-only`,
  );
  if (primed.status !== 0) {
    t.skip(
      `turbo could not run here: ${primed.error?.message ?? primed.stderr ?? ""}`,
    );
    return;
  }
  const args = buildTurboArgs(PROOF_TASK, {
    full: false,
    baseSha: "HEAD",
    files: [],
    extra: [`--filter=${PROOF_PACKAGE}`],
  });
  const taskId = `${PROOF_PACKAGE}#${PROOF_TASK}`;
  const replayArgs = [
    ...args.filter((arg) => !arg.startsWith("--cache=")),
    "--cache=local:rw",
  ];
  assert.equal(
    dryRunCacheStatus(replayArgs, taskId),
    "HIT",
    "the cache entry this proof measures against was not written",
  );
  assert.equal(
    dryRunCacheStatus(args, taskId),
    "MISS",
    "verify must re-run a selected package instead of replaying its cached pass",
  );
});

test("every gate builds the cache mode the replay proof measured", () => {
  const proven = cacheMode(
    buildTurboArgs(PROOF_TASK, { full: false, baseSha: "HEAD", files: [] }),
  );
  for (const task of AFFECTED_TASKS) {
    assert.equal(
      cacheMode(
        buildTurboArgs(task, { full: false, baseSha: BASE_SHA, files: [] }),
      ),
      proven,
      `${task} must use the cache mode the replay proof measured`,
    );
  }
  assert.equal(
    cacheMode(
      buildTurboArgs("test:unit", { full: true, baseSha: BASE_SHA, files: [] }),
    ),
    proven,
    "--full must use it too",
  );
  assert.equal(
    cacheMode(buildTurboArgs("build", { filters: ["--filter=@showzy/web"] })),
    proven,
    "build-web must use it too",
  );
});

test("--full drops the package filter and keeps extra flags", () => {
  const args = buildTurboArgs("test:unit", {
    full: true,
    baseSha: BASE_SHA,
    files: [],
    extra: ["--concurrency=2"],
  });
  assert.equal(args.filter((arg) => arg.startsWith("--filter=")).length, 0);
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
