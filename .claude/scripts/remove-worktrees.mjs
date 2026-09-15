#!/usr/bin/env node
/**
 * Removes finished agent worktrees under `.claude/worktrees/`.
 *
 * - Named worktrees (`agent-<id>` or `<id>`) are unregistered with long-path
 *   support, then their directory is deleted with Node (git leaves deep
 *   node_modules behind on Windows).
 * - A `locked` worktree belongs to a running agent, possibly in another
 *   session: it is skipped, never forced.
 * - `--orphans` deletes directories git no longer tracks as worktrees.
 *
 * Usage: node .claude/scripts/remove-worktrees.mjs [<agent-id>...] [--orphans]
 * Exit code: 0 when every requested removal succeeded, 1 otherwise.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

function git(cwd, ...args) {
  return spawnSync("git", ["-c", "core.longpaths=true", ...args], {
    cwd,
    encoding: "utf8",
  });
}

function key(p) {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function repoRoot(cwd) {
  const result = git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (result.status !== 0) throw new Error(result.stderr.trim());
  return path.dirname(result.stdout.trim());
}

function registeredWorktrees(root) {
  const out = git(root, "worktree", "list", "--porcelain").stdout;
  const entries = new Map();
  let current = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice(9), locked: false };
      entries.set(key(current.path), current);
    } else if (current && (line === "locked" || line.startsWith("locked "))) {
      current.locked = true;
    }
  }
  return entries;
}

function deleteDir(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

function removeNamed(root, name, registered) {
  if (!/^(agent-)?[0-9a-z]+$/i.test(name)) return { dir: name, outcome: "failed: not an agent id", failed: true };
  const dirName = name.startsWith("agent-") ? name : `agent-${name}`;
  const dir = path.join(root, ".claude", "worktrees", dirName);
  const entry = registered.get(key(dir));
  if (entry?.locked) return { dir, outcome: "skipped: locked" };
  if (entry) git(root, "worktree", "remove", "--force", dir);
  if (!entry && !existsSync(dir)) return { dir, outcome: "absent" };
  try {
    deleteDir(dir);
  } catch (error) {
    return { dir, outcome: `failed: ${error.code ?? error.message}`, failed: true };
  }
  return { dir, outcome: "removed" };
}

function removeOrphans(root, registered) {
  const base = path.join(root, ".claude", "worktrees");
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !registered.has(key(path.join(base, d.name))))
    .map((d) => {
      const dir = path.join(base, d.name);
      try {
        deleteDir(dir);
        return { dir, outcome: "removed orphan" };
      } catch (error) {
        return { dir, outcome: `failed: ${error.code ?? error.message}`, failed: true };
      }
    });
}

const args = process.argv.slice(2);
const orphans = args.includes("--orphans");
const names = args.filter((a) => a !== "--orphans");
if (names.length === 0 && !orphans) {
  console.error("usage: remove-worktrees.mjs [<agent-id>...] [--orphans]");
  process.exit(1);
}

const root = repoRoot(process.cwd());
const registered = registeredWorktrees(root);
const results = names.map((name) => removeNamed(root, name, registered));
git(root, "worktree", "prune");
if (orphans) results.push(...removeOrphans(root, registeredWorktrees(root)));

for (const r of results) console.log(`${r.outcome}  ${path.relative(root, r.dir)}`);
process.exit(results.some((r) => r.failed) ? 1 : 0);
