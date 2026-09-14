import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const hook = fileURLToPath(
  new URL("../../../.claude/hooks/guard-paths.mjs", import.meta.url),
);

function checkout({ branch, approvals }) {
  const main = mkdtempSync(path.join(tmpdir(), "guard-paths-")).replaceAll(
    "\\",
    "/",
  );
  const worktree = `${main}/.claude/worktrees/w1`;
  const gitdir = `${main}/.git/worktrees/w1`;
  mkdirSync(worktree, { recursive: true });
  mkdirSync(gitdir, { recursive: true });
  writeFileSync(`${worktree}/.git`, `gitdir: ${gitdir}\n`);
  writeFileSync(`${gitdir}/HEAD`, `ref: refs/heads/${branch}\n`);
  if (approvals !== undefined) {
    writeFileSync(`${main}/.claude/core-edit-approvals.json`, approvals);
  }
  return { main, worktree };
}

function edit(file, { cwd, env = {} }) {
  const res = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ tool_input: { file_path: file }, cwd }),
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: cwd,
      SHOWZY_ALLOW_CORE_EDIT: "",
      ...env,
    },
  });
  return { status: res.status, stderr: res.stderr };
}

function withCheckout(options, run) {
  const dirs = checkout(options);
  try {
    run(dirs);
  } finally {
    rmSync(dirs.main, { recursive: true, force: true });
  }
}

const coreFile = (worktree) => `${worktree}/packages/core/src/index.ts`;

test("a worktree without an approval cannot edit packages/core", () => {
  withCheckout(
    { branch: "feat/sho-700-core", approvals: "{}" },
    ({ worktree }) => {
      const res = edit(coreFile(worktree), { cwd: worktree });
      assert.equal(res.status, 2);
      assert.match(res.stderr, /packages\/core is frozen/);
    },
  );
});

test("a worktree whose branch names an approved ticket may edit packages/core", () => {
  const approvals = JSON.stringify({ "SHO-623": "ADR-0042" });
  withCheckout(
    { branch: "kurbatovivann/sho-623-core-t1-snapshot", approvals },
    ({ worktree }) => {
      assert.equal(edit(coreFile(worktree), { cwd: worktree }).status, 0);
    },
  );
});

test("the ticket must be a whole branch segment, not a prefix of another id", () => {
  const approvals = JSON.stringify({ "SHO-62": "ADR-0042" });
  withCheckout({ branch: "feat/sho-623-core", approvals }, ({ worktree }) => {
    assert.equal(edit(coreFile(worktree), { cwd: worktree }).status, 2);
  });
});

test("an approval without an ADR reference grants nothing", () => {
  const approvals = JSON.stringify({ "SHO-623": "yes" });
  withCheckout({ branch: "feat/sho-623-core", approvals }, ({ worktree }) => {
    assert.equal(edit(coreFile(worktree), { cwd: worktree }).status, 2);
  });
});

test("a missing or malformed approvals file blocks core edits", () => {
  withCheckout({ branch: "feat/sho-623-core" }, ({ worktree }) => {
    assert.equal(edit(coreFile(worktree), { cwd: worktree }).status, 2);
  });
  withCheckout(
    { branch: "feat/sho-623-core", approvals: "{not json" },
    ({ worktree }) => {
      assert.equal(edit(coreFile(worktree), { cwd: worktree }).status, 2);
    },
  );
});

test("the worktree copy of the approvals file is never consulted", () => {
  withCheckout(
    { branch: "feat/sho-623-core", approvals: "{}" },
    ({ worktree }) => {
      mkdirSync(`${worktree}/.claude`, { recursive: true });
      writeFileSync(
        `${worktree}/.claude/core-edit-approvals.json`,
        JSON.stringify({ "SHO-623": "ADR-0042" }),
      );
      assert.equal(edit(coreFile(worktree), { cwd: worktree }).status, 2);
    },
  );
});

test("SHOWZY_ALLOW_CORE_EDIT=1 still opens packages/core", () => {
  withCheckout(
    { branch: "feat/sho-700-core", approvals: "{}" },
    ({ worktree }) => {
      const res = edit(coreFile(worktree), {
        cwd: worktree,
        env: { SHOWZY_ALLOW_CORE_EDIT: "1" },
      });
      assert.equal(res.status, 0);
    },
  );
});

test("a worktree session cannot edit the approvals file in either checkout", () => {
  withCheckout(
    { branch: "feat/sho-623-core", approvals: "{}" },
    ({ main, worktree }) => {
      for (const file of [
        `${main}/.claude/core-edit-approvals.json`,
        `${worktree}/.claude/core-edit-approvals.json`,
      ]) {
        const res = edit(file, { cwd: worktree });
        assert.equal(res.status, 2);
        assert.match(res.stderr, /core-edit-approvals\.json/);
      }
    },
  );
});

test("the main checkout may edit the approvals file and packages/core", () => {
  withCheckout({ branch: "feat/sho-700-core", approvals: "{}" }, ({ main }) => {
    assert.equal(
      edit(`${main}/.claude/core-edit-approvals.json`, { cwd: main }).status,
      0,
    );
    assert.equal(
      edit(`${main}/packages/core/src/index.ts`, { cwd: main }).status,
      0,
    );
  });
});
