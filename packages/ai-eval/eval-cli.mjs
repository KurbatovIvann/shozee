#!/usr/bin/env node
/**
 * Launch `vitest run --config vitest.eval.config.ts` after stripping
 * `--runs` / `--runs=N`. Vitest rejects unknown CLI flags, and worker
 * `process.argv` is the fork worker — not the original CLI — so the
 * live file reads `SHOWZY_EVAL_RUNS` composed here (SHO-412).
 *
 * Spawn the Vitest CLI via `process.execPath`. A bare `pnpm` child on
 * Windows looks for `pnpm.exe` and fails with ENOENT (`pnpm.cmd` needs
 * a shell). Load the repo-root `.env` the same way `apps/api` uses
 * `--env-file` — `loadServerConfig` reads `process.env`, not files.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRootEnv = path.resolve(packageRoot, "../../.env");
if (existsSync(repoRootEnv)) {
  process.loadEnvFile(repoRootEnv);
}

const require = createRequire(import.meta.url);
const vitestCli = path.join(
  path.dirname(require.resolve("vitest/package.json")),
  "vitest.mjs",
);

/**
 * @param {string[]} argv
 * @returns {{ rest: string[], runsSeen: boolean, runsRaw: string | undefined }}
 */
function splitEvalArgs(argv) {
  /** @type {string[]} */
  const rest = [];
  let runsSeen = false;
  /** @type {string | undefined} */
  let runsRaw;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--runs") {
      if (!runsSeen) {
        runsSeen = true;
        runsRaw = argv[index + 1];
      }
      index += 1;
      continue;
    }
    if (arg !== undefined && arg.startsWith("--runs=")) {
      if (!runsSeen) {
        runsSeen = true;
        runsRaw = arg.slice("--runs=".length);
      }
      continue;
    }
    rest.push(arg);
  }
  return { rest, runsSeen, runsRaw };
}

const { rest, runsSeen, runsRaw } = splitEvalArgs(process.argv.slice(2));
const env = { ...process.env };
if (runsSeen) {
  env.SHOWZY_EVAL_RUNS = runsRaw ?? "";
}

const child = spawn(
  process.execPath,
  [vitestCli, "run", "--config", "vitest.eval.config.ts", ...rest],
  {
    cwd: packageRoot,
    env,
    stdio: "inherit",
  },
);

child.on("error", (error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "eval failed"}\n`,
  );
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.exit(1);
  }
  process.exit(code ?? 1);
});
