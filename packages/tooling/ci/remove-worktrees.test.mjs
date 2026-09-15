import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("../../../.claude/scripts/remove-worktrees.mjs", import.meta.url),
);

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "remove-worktrees-"));
  const git = (...a) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(path.join(root, "a.txt"), "a");
  git("add", ".");
  git("commit", "-m", "base");
  const wt = (name) => path.join(root, ".claude", "worktrees", name);
  const run = (...args) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd: root,
      encoding: "utf8",
    });
  return { root, git, wt, run };
}

test("removes a finished worktree with its untracked files", () => {
  const { root, git, wt, run } = fixture();
  try {
    git("worktree", "add", wt("agent-a1"), "-b", "a1");
    mkdirSync(path.join(wt("agent-a1"), "node_modules", "x"), {
      recursive: true,
    });
    const result = run("a1");
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(existsSync(wt("agent-a1")), false);
    assert.doesNotMatch(git("worktree", "list").stdout, /agent-a1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skips a locked worktree and leaves it registered", () => {
  const { root, git, wt, run } = fixture();
  try {
    git("worktree", "add", wt("agent-b2"), "-b", "b2");
    git("worktree", "lock", wt("agent-b2"));
    const result = run("agent-b2", "--orphans");
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /skipped: locked/);
    assert.equal(existsSync(path.join(wt("agent-b2"), "a.txt")), true);
    git("worktree", "unlock", wt("agent-b2"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--orphans deletes only directories git does not track", () => {
  const { root, git, wt, run } = fixture();
  try {
    git("worktree", "add", wt("agent-live"), "-b", "live");
    mkdirSync(path.join(wt("agent-dead"), "node_modules"), { recursive: true });
    const result = run("--orphans");
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(existsSync(wt("agent-dead")), false);
    assert.equal(existsSync(path.join(wt("agent-live"), "a.txt")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a name that is not an agent id", () => {
  const { root, wt, run } = fixture();
  try {
    mkdirSync(wt("agent-keep"), { recursive: true });
    const result = run("../../a.txt");
    assert.equal(result.status, 1);
    assert.equal(existsSync(path.join(root, "a.txt")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
