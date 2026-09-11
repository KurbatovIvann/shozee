#!/usr/bin/env node
/**
 * Conveyor merge gate (ADR-0029, ADR-0040): reports whether the required
 * GitHub Actions jobs are green on a PR's head commit, in a few lines.
 *
 * Usage:
 *   node .claude/scripts/merge-gate.mjs <pr-number|branch> [--wait] [--timeout-min 60]
 *
 * Output (last line is machine-friendly):
 *   GATE: GREEN | RED | PENDING  pr=<n> head=<sha8> ...
 * Exit: 0 GREEN, 1 RED, 3 PENDING (also on --wait timeout), 2 usage/gh error.
 *
 * With --wait it polls every 30s until the gate is not PENDING — run it as a
 * background shell so the session is notified when CI settles.
 */
import { spawnSync } from "node:child_process";

// Branch protection / conveyor gate job names (docs/pipeline.md).
const REQUIRED = [
  "checks",
  "secret-scan",
  "dependency-audit",
  "contract-check",
  "migration-drift",
  "bundle-probe",
  "e2e-smoke",
];

function gh(args) {
  const win = process.platform === "win32";
  const res = spawnSync(win ? ["gh", ...args].join(" ") : "gh", win ? [] : args, {
    encoding: "utf8",
    shell: win,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { ok: res.status === 0, out: res.stdout ?? "", err: res.stderr ?? "", code: res.status };
}

function parseArgs(argv) {
  const opts = { target: null, wait: false, timeoutMin: 60 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--wait") opts.wait = true;
    else if (arg === "--timeout-min") {
      opts.timeoutMin = Number(argv[(i += 1)]);
      if (!Number.isFinite(opts.timeoutMin) || opts.timeoutMin <= 0) {
        throw new Error("--timeout-min needs a positive number of minutes");
      }
    }
    else if (!opts.target) opts.target = arg;
    else throw new Error(`unexpected argument ${arg}`);
  }
  if (!opts.target) throw new Error("usage: merge-gate.mjs <pr-number|branch> [--wait]");
  return opts;
}

function evaluate(target) {
  const view = gh([
    "pr",
    "view",
    target,
    "--json",
    "number,state,isDraft,headRefName,headRefOid,mergeable,url",
  ]);
  if (!view.ok) throw new Error(`gh pr view failed: ${view.err.trim()}`);
  const pr = JSON.parse(view.out);

  // `gh pr checks` exits non-zero when checks fail or are pending; parse anyway.
  const checks = gh(["pr", "checks", String(pr.number), "--json", "name,state,bucket,link,workflow"]);
  let runs = [];
  try {
    runs = JSON.parse(checks.out || "[]");
  } catch {
    if (!checks.ok) throw new Error(`gh pr checks failed: ${checks.err.trim()}`);
  }

  const jobs = REQUIRED.map((name) => {
    const matches = runs.filter((r) => r.name === name);
    if (matches.length === 0) return { name, bucket: "pending", note: "not reported yet" };
    const bucketOrder = ["fail", "cancel", "pending", "skipping", "pass"];
    const worst = matches.sort(
      (a, b) => bucketOrder.indexOf(a.bucket) - bucketOrder.indexOf(b.bucket),
    )[0];
    return { name, bucket: worst.bucket, link: worst.link };
  });

  const red = jobs.filter((j) => ["fail", "cancel", "skipping"].includes(j.bucket));
  const pending = jobs.filter((j) => j.bucket === "pending");
  // Actions do not run on a conflicting PR, so waiting would never end.
  const conflicted = pr.mergeable === "CONFLICTING";
  const status =
    pr.state !== "OPEN" || conflicted || red.length > 0
      ? "RED"
      : pending.length > 0 || pr.mergeable === "UNKNOWN"
        ? "PENDING"
        : "GREEN";
  return { pr, jobs, red, pending, status };
}

function report({ pr, jobs, red, pending, status }) {
  const lines = [];
  if (pr.state !== "OPEN") lines.push(`PR is ${pr.state}`);
  if (pr.mergeable === "CONFLICTING") lines.push("PR has merge conflicts with main");
  for (const j of red) lines.push(`RED     ${j.name} (${j.bucket}) ${j.link ?? ""}`.trimEnd());
  for (const j of pending) lines.push(`PENDING ${j.name}${j.note ? ` (${j.note})` : ""}`);
  const passed = jobs.filter((j) => j.bucket === "pass").map((j) => j.name);
  if (passed.length > 0) lines.push(`green: ${passed.join(", ")}`);
  lines.push(
    `GATE: ${status}  pr=${pr.number} head=${pr.headRefOid} branch=${pr.headRefName} draft=${pr.isDraft} mergeable=${pr.mergeable} ${pr.url}`,
  );
  console.log(lines.join("\n"));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const deadline = Date.now() + opts.timeoutMin * 60_000;
  let transientErrors = 0;
  for (;;) {
    let result;
    try {
      result = evaluate(opts.target);
      transientErrors = 0;
    } catch (error) {
      // Tolerate brief gh/network hiccups while waiting; fail after three.
      transientErrors += 1;
      if (!opts.wait || transientErrors >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 30_000));
      continue;
    }
    if (!opts.wait || result.status !== "PENDING" || Date.now() > deadline) {
      report(result);
      return result.status === "GREEN" ? 0 : result.status === "RED" ? 1 : 3;
    }
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`merge-gate: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  },
);
