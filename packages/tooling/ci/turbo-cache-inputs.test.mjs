import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const turbo = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "turbo.json"), "utf8"),
);
const workflowDir = path.join(repoRoot, ".github");

const REQUIRED_GLOBAL_INPUTS = [
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "package.json",
  "prettier.config.mjs",
  "packages/tooling/package.json",
  "packages/tooling/tsconfig/base.json",
];

test("turbo.json hashes lockfile, manifests, and shared tooling configs", () => {
  const globals = turbo.globalDependencies;
  assert.ok(Array.isArray(globals));
  for (const entry of REQUIRED_GLOBAL_INPUTS) {
    assert.ok(globals.includes(entry), `missing globalDependency ${entry}`);
  }
  assert.ok(globals.includes("packages/tooling/prettier/**"));
  assert.ok(globals.includes("packages/tooling/eslint/**"));
  assert.equal(turbo.tasks["e2e-smoke"].cache, false);
});

test("typecheck, lint, test, test:unit, and builds declare inputs so config changes miss cache", () => {
  for (const name of [
    "typecheck",
    "lint",
    "test",
    "test:unit",
    "build",
    "export:web",
  ]) {
    const inputs = turbo.tasks[name].inputs;
    assert.ok(
      Array.isArray(inputs) && inputs.includes("$TURBO_DEFAULT$"),
      `${name} must hash package sources`,
    );
  }
  assert.ok(turbo.tasks.typecheck.inputs.includes("tsconfig.json"));
  assert.ok(turbo.tasks.lint.inputs.includes("eslint.config.*"));
  assert.ok(turbo.tasks.test.inputs.includes("vitest.config.*"));
  assert.ok(turbo.tasks["test:unit"].inputs.includes("vitest.config.*"));
  assert.deepEqual(turbo.tasks.build.outputs, ["dist/**"]);
  assert.deepEqual(turbo.tasks["export:web"].outputs, ["dist/**"]);
});

test("turbo.json has no synthetic topo task and no dependsOn topo edges", () => {
  const turboSource = fs.readFileSync(
    path.join(repoRoot, "turbo.json"),
    "utf8",
  );
  assert.doesNotMatch(
    turboSource,
    /"topo"/,
    "synthetic topo serializes the cyclic workspace graph and Turbo exits",
  );
  assert.equal(turbo.tasks.topo, undefined);
  for (const [name, task] of Object.entries(turbo.tasks)) {
    const deps = task.dependsOn ?? [];
    assert.ok(
      !deps.includes("topo") && !deps.includes("^topo"),
      `${name} must not depend on topo`,
    );
  }
  for (const name of [
    "typecheck",
    "lint",
    "test",
    "test:unit",
    "build",
    "export:web",
  ]) {
    const deps = turbo.tasks[name].dependsOn ?? [];
    assert.equal(
      deps.filter((dep) => dep.startsWith("^")).length,
      0,
      `${name} must not walk ^task edges; --affected already includes dependents`,
    );
  }
});

/**
 * @param {string[]} args
 */
function turboDryRun(args) {
  return spawnSync("pnpm", ["exec", "turbo", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000,
  });
}

test("turbo typecheck, test, and test:unit dry-run exit 0 despite circular package warnings", () => {
  for (const task of ["typecheck", "test", "test:unit"]) {
    const result = turboDryRun(["run", task, "--dry-run", "--cache=local:rw"]);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, `${task} dry-run failed:\n${output}`);
    assert.match(
      output,
      /Circular package dependency detected/,
      `${task} dry-run must still see the cyclic workspace graph`,
    );
    assert.doesNotMatch(output, /Cyclic dependency detected/);
  }
});

test("turbo build and export:web dry-run succeed with existing package cycles", () => {
  const cases = [
    ["run", "build", "--filter=@showzy/web", "--dry-run", "--cache=local:rw"],
    [
      "run",
      "export:web",
      "--filter=@showzy/mobile",
      "--dry-run",
      "--cache=local:rw",
    ],
  ];
  for (const args of cases) {
    const result = turboDryRun(args);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, `${args.join(" ")} failed:\n${output}`);
    assert.doesNotMatch(output, /Cyclic dependency detected/);
  }
});

test("no GitHub Actions cache carries .turbo into a CI run", () => {
  const sources = fs
    .readdirSync(workflowDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yml"))
    .map((entry) =>
      fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8"),
    );
  assert.ok(sources.length > 0);
  for (const source of sources) {
    assert.doesNotMatch(source, /path:\s+\.turbo/);
    assert.doesNotMatch(source, /TURBO_TOKEN:/);
  }
});
