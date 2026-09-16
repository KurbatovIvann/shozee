import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  gitMergeBase,
  gitObjectExists,
  parseRunTurboArgv,
  runTurboCli,
} from "./run-turbo.mjs";

const script = fileURLToPath(new URL("./run-turbo.mjs", import.meta.url));

/**
 * One comparison SHA that exists in this clone and equals production `scmBase`.
 *
 * `run-turbo` sets `TURBO_SCM_BASE` to `git merge-base HEAD <candidate>`, not
 * the current `origin/main` tip (SHO-512). `rev-parse origin/main` can print a
 * SHA whose object was never fetched, or a tip that moved past this branch
 * point — either way the CLI's merge-base differs from that print.
 *
 * @returns {string}
 */
function existingPrComparisonSha() {
  const originMain = spawnSync(
    "git",
    ["rev-parse", "--verify", "origin/main"],
    {
      encoding: "utf8",
    },
  );
  /** @type {string[]} */
  const candidates = [];
  if (originMain.status === 0) {
    const sha = originMain.stdout.trim();
    if (sha.length > 0 && gitObjectExists(sha)) {
      candidates.push(sha);
    }
  }
  candidates.push("origin/main", "main");

  for (const candidate of candidates) {
    if (!gitObjectExists(candidate)) {
      continue;
    }
    const mergeBase = gitMergeBase("HEAD", candidate);
    if (mergeBase && gitObjectExists(mergeBase)) {
      return mergeBase;
    }
  }

  const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  assert.equal(head.status, 0, head.stderr);
  const headSha = head.stdout.trim();
  assert.ok(gitObjectExists(headSha), "HEAD commit must exist in this clone");
  return headSha;
}

test("parseRunTurboArgv strips its own flags and keeps extra turbo args", () => {
  assert.deepEqual(parseRunTurboArgv(["typecheck", "--print-only"]), {
    printOnly: true,
    alwaysFull: false,
    task: "typecheck",
    extraArgs: [],
  });
  assert.deepEqual(
    parseRunTurboArgv(["build", "--filter=@showzy/web", "--print-only"]),
    {
      printOnly: true,
      alwaysFull: false,
      task: "build",
      extraArgs: ["--filter=@showzy/web"],
    },
  );
  assert.deepEqual(
    parseRunTurboArgv([
      "e2e-smoke",
      "--always-full",
      "--filter=@showzy/web",
      "--print-only",
    ]),
    {
      printOnly: true,
      alwaysFull: true,
      task: "e2e-smoke",
      extraArgs: ["--filter=@showzy/web"],
    },
  );
});

test("--always-full runs the whole workspace even when a PR base resolves", () => {
  const baseSha = existingPrComparisonSha();
  const result = spawnSync(
    process.execPath,
    [script, "e2e-smoke", "--always-full", "--print-only"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_REF: "refs/pull/1/merge",
        GITHUB_BASE_REF: "main",
        TURBO_PR_BASE_SHA: baseSha,
        GITHUB_STEP_SUMMARY: "",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(
    result.stdout
      .trim()
      .split("\n")
      .find((line) => line.startsWith("{")) ?? "{}",
  );
  assert.equal(payload.mode, "full");
  assert.equal(payload.reason, "always-full-uncacheable-task");
  assert.ok(!payload.args.includes("--affected"));
  assert.equal(payload.scmBase, null);
});

test("a --cache in extra args is refused so it cannot outrank the helper", () => {
  for (const override of ["--cache=local:rw", "--cache"]) {
    const result = spawnSync(
      process.execPath,
      [script, "test:unit", override, "--print-only"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: "push",
          GITHUB_REF: "refs/heads/main",
          GITHUB_BASE_REF: "",
          TURBO_PR_BASE_SHA: "",
          GITHUB_STEP_SUMMARY: "",
        },
      },
    );
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stderr, /owns the turbo cache mode/);
  }
});

test("runTurboCli print-only: PR with missing objects falls back to full", () => {
  const isolatedEnv = {
    ...process.env,
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_REF: "refs/pull/1/merge",
    GITHUB_BASE_REF: "main",
    TURBO_PR_BASE_SHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    GITHUB_STEP_SUMMARY: "",
  };
  const io = {
    spawnSync: (command, args) => {
      if (command === "git") {
        return { status: 1, stdout: "", stderr: "missing" };
      }
      throw new Error(`unexpected spawn ${command} ${args.join(" ")}`);
    },
  };
  const code = runTurboCli(["lint", "--print-only"], isolatedEnv, io);
  assert.equal(code, 0);
});

test("CLI print-only on push to main is full (no --affected)", () => {
  const result = spawnSync(process.execPath, [script, "test", "--print-only"], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/heads/main",
      GITHUB_BASE_REF: "",
      TURBO_PR_BASE_SHA: "",
      GITHUB_STEP_SUMMARY: "",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Turbo execution mode: full \(push-to-main\)/);
  assert.doesNotMatch(result.stdout, /--affected/);
  const jsonLine = result.stdout
    .trim()
    .split("\n")
    .find((line) => line.startsWith("{"));
  assert.ok(jsonLine);
  const payload = JSON.parse(jsonLine);
  assert.equal(payload.mode, "full");
  assert.ok(payload.args.includes("--cache=local:w"));
  assert.ok(!payload.args.includes("--affected"));
});

test("CLI print-only on pull_request with a resolvable origin/main uses affected", () => {
  const baseSha = existingPrComparisonSha();
  const result = spawnSync(process.execPath, [script, "lint", "--print-only"], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_REF: "refs/pull/9/merge",
      GITHUB_BASE_REF: "main",
      TURBO_PR_BASE_SHA: baseSha,
      GITHUB_STEP_SUMMARY: "",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /Turbo execution mode: affected \(pull-request\)/,
  );
  const jsonLine = result.stdout
    .trim()
    .split("\n")
    .find((line) => line.startsWith("{"));
  assert.ok(jsonLine);
  const payload = JSON.parse(jsonLine);
  assert.equal(payload.mode, "affected");
  assert.ok(payload.args.includes("--affected"));
  assert.equal(payload.scmBase, baseSha);
  assert.equal(payload.scmHead, "HEAD");
});

test("CLI print-only on pull_request with an unresolvable SHA is full", () => {
  const result = spawnSync(
    process.execPath,
    [script, "typecheck", "--print-only"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_REF: "refs/pull/9/merge",
        GITHUB_BASE_REF: "this-base-ref-does-not-exist",
        TURBO_PR_BASE_SHA: "0000000000000000000000000000000000000000",
        GITHUB_STEP_SUMMARY: "",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Turbo execution mode: full \(unresolved-base\)/);
  const jsonLine = result.stdout
    .trim()
    .split("\n")
    .find((line) => line.startsWith("{"));
  assert.ok(jsonLine);
  const payload = JSON.parse(jsonLine);
  assert.equal(payload.mode, "full");
  assert.ok(!payload.args.includes("--affected"));
});
