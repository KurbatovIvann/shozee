#!/usr/bin/env node
/**
 * CI entrypoint for Turbo tasks (SHO-335).
 *
 * Resolves PR comparison history, then runs either `turbo --affected` or a
 * full `turbo run`. `--affected` walks the package graph’s dependents; a
 * synthetic `topo` or `^build` task graph is not used (this workspace is
 * cyclic). The cache mode comes from `TURBO_LOCAL_CACHE` — write-only, never
 * read (SHO-708) — so no run can replay a stale pass and TURBO_TOKEN is never
 * required.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildTurboRunArgs,
  buildTurboRunEnv,
  resolveComparisonBase,
  resolveTurboExecutionMode,
} from "./turbo-execution-mode.mjs";

/**
 * @param {string[]} argv
 */
export function parseRunTurboArgv(argv) {
  const printOnly = argv.includes("--print-only");
  const rest = argv.filter((arg) => arg !== "--print-only");
  const task = rest[0];
  const extraArgs = rest.slice(1);
  return { printOnly, task, extraArgs };
}

/**
 * @param {string} rev
 * @param {{ spawnSync?: typeof spawnSync, cwd?: string }} [io]
 */
export function gitObjectExists(rev, io = {}) {
  const spawn = io.spawnSync ?? spawnSync;
  const result = spawn("git", ["cat-file", "-e", `${rev}^{commit}`], {
    cwd: io.cwd,
    encoding: "utf8",
  });
  return result.status === 0;
}

/**
 * @param {string} a
 * @param {string} b
 * @param {{ spawnSync?: typeof spawnSync, cwd?: string }} [io]
 */
export function gitMergeBase(a, b, io = {}) {
  const spawn = io.spawnSync ?? spawnSync;
  const result = spawn("git", ["merge-base", a, b], {
    cwd: io.cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return null;
  }
  const sha = (result.stdout ?? "").trim();
  return sha.length > 0 ? sha : null;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {{ spawnSync?: typeof spawnSync, cwd?: string }} [io]
 */
export function decideTurboRun(env, io = {}) {
  const comparison = resolveComparisonBase({
    eventName: env.GITHUB_EVENT_NAME,
    baseRef: env.GITHUB_BASE_REF,
    baseSha: env.TURBO_PR_BASE_SHA,
    objectExists: (rev) => gitObjectExists(rev, io),
    mergeBase: (a, b) => gitMergeBase(a, b, io),
  });
  const mergeBase = comparison.ok ? comparison.mergeBase : null;
  const decision = resolveTurboExecutionMode({
    eventName: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF,
    baseRef: env.GITHUB_BASE_REF,
    baseSha: env.TURBO_PR_BASE_SHA,
    mergeBase,
  });
  return { comparison, decision };
}

/**
 * @param {string[]} lines
 * @param {string | undefined} summaryPath
 */
function writeSummary(lines, summaryPath) {
  if (!summaryPath) {
    return;
  }
  appendFileSync(summaryPath, `${lines.join("\n")}\n`);
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ spawnSync?: typeof spawnSync, cwd?: string }} [io]
 * @returns {number}
 */
export function runTurboCli(argv, env = process.env, io = {}) {
  const { printOnly, task, extraArgs } = parseRunTurboArgv(argv);
  if (!task) {
    console.error("usage: run-turbo.mjs <task> [...turbo args] [--print-only]");
    return 2;
  }

  const { comparison, decision } = decideTurboRun(env, io);
  const args = buildTurboRunArgs(task, decision, extraArgs);
  const turboEnv = buildTurboRunEnv(decision, env);

  const lines = [
    `Turbo execution mode: ${decision.mode} (${decision.reason})`,
    comparison.ok
      ? `Comparison base: ${comparison.mergeBase} (from ${comparison.resolvedFrom})`
      : `Comparison base: ${comparison.reason}`,
    `Command: pnpm exec turbo ${args.join(" ")}`,
  ];
  for (const line of lines) {
    console.log(line);
  }
  writeSummary(
    [
      "## Turbo execution",
      "",
      `| Field | Value |`,
      `| --- | --- |`,
      `| Mode | ${decision.mode} |`,
      `| Reason | ${decision.reason} |`,
      `| Task | ${task} |`,
    ],
    env.GITHUB_STEP_SUMMARY,
  );

  if (printOnly) {
    console.log(
      JSON.stringify({
        mode: decision.mode,
        reason: decision.reason,
        args,
        scmBase: turboEnv.TURBO_SCM_BASE ?? null,
        scmHead: turboEnv.TURBO_SCM_HEAD ?? null,
      }),
    );
    return 0;
  }

  const spawn = io.spawnSync ?? spawnSync;
  const result = spawn("pnpm", ["exec", "turbo", ...args], {
    cwd: io.cwd,
    env: turboEnv,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(result.error.message);
    return 1;
  }
  return result.status ?? 1;
}

const invoked =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invoked) {
  process.exitCode = runTurboCli(process.argv.slice(2));
}
