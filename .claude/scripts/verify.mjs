#!/usr/bin/env node
/**
 * Local CI-equivalent verification for Claude Code sessions and subagents.
 *
 * Mirrors the GitHub Actions gates in `.github/workflows/ci.yml`, but only for
 * what the branch touched, and prints a compact summary so agents do not pour
 * thousands of log lines into their context. Full logs stay on disk in
 * `.claude/.verify/<step>.log`.
 *
 * Usage:
 *   node .claude/scripts/verify.mjs [options]
 *
 * Options:
 *   --base <ref>     Comparison base (default: merge-base of HEAD and origin/main)
 *   --full           Run every package and every gate (incl. build + e2e smoke)
 *   --only a,b       Run only these steps
 *   --skip a,b       Skip these steps
 *   --db auto|on|off DB suite: auto (changed server packages), on (whole suite), off
 *   --no-fix         Check formatting without rewriting files
 *   --dry-run        Print the plan without running anything
 *   --tail <n>       Lines of failing output to print per step (default 60)
 *
 * Steps: diff-hygiene, format, typecheck, lint, test-unit, test-db,
 *        contract-check, migration-drift, bundle-probe, build-web, e2e-smoke
 * Exit code: 0 when every executed step passed, 1 otherwise.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const IS_WIN = process.platform === "win32";
const STEPS = [
  "diff-hygiene",
  "format",
  "typecheck",
  "lint",
  "test-unit",
  "test-db",
  "contract-check",
  "migration-drift",
  "bundle-probe",
  "build-web",
  "e2e-smoke",
];

// ---------------------------------------------------------------- args ----
function parseArgs(argv) {
  const opts = {
    base: null,
    full: false,
    only: null,
    skip: new Set(),
    db: "auto",
    fix: true,
    dryRun: false,
    tail: 60,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      i += 1;
      return value;
    };
    if (arg === "--base") opts.base = next();
    else if (arg === "--full") opts.full = true;
    else if (arg === "--only") opts.only = new Set(next().split(","));
    else if (arg === "--skip") opts.skip = new Set(next().split(","));
    else if (arg === "--db") opts.db = next();
    else if (arg === "--no-fix") opts.fix = false;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--tail") opts.tail = Number(next());
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "node .claude/scripts/verify.mjs [--base ref] [--full] [--only a,b] [--skip a,b] [--db auto|on|off] [--no-fix] [--dry-run] [--tail n]",
      );
      process.exit(0);
    } else throw new Error(`unknown option ${arg}`);
  }
  for (const name of [...(opts.only ?? []), ...opts.skip]) {
    if (!STEPS.includes(name)) throw new Error(`unknown step ${name}`);
  }
  if (!["auto", "on", "off"].includes(opts.db)) {
    throw new Error("--db must be auto, on, or off");
  }
  return opts;
}

// ----------------------------------------------------------------- git ----
function git(args, cwd) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  return res.status === 0 ? res.stdout.trim() : null;
}

function repoRoot() {
  const root = git(["rev-parse", "--show-toplevel"], process.cwd());
  if (!root) throw new Error("not inside a git repository");
  return root;
}

function resolveBase(root, explicit) {
  if (explicit) {
    const sha = git(["rev-parse", "--verify", `${explicit}^{commit}`], root);
    if (!sha) throw new Error(`cannot resolve --base ${explicit}`);
    return { ref: explicit, sha };
  }
  for (const candidate of ["origin/main", "main"]) {
    const sha = git(["merge-base", "HEAD", candidate], root);
    if (sha) return { ref: candidate, sha };
  }
  throw new Error("cannot find merge-base with origin/main or main");
}

function changedFiles(root, baseSha) {
  const lists = [
    git(["diff", "--name-only", "--diff-filter=ACMRD", `${baseSha}...HEAD`], root),
    git(["diff", "--name-only", "--diff-filter=ACMRD", "HEAD"], root),
    git(["ls-files", "--others", "--exclude-standard"], root),
  ];
  const files = new Set();
  for (const list of lists) {
    for (const line of (list ?? "").split("\n")) {
      if (line.trim()) files.add(line.trim().replaceAll("\\", "/"));
    }
  }
  return [...files].sort();
}

// ---------------------------------------------------------------- plan ----
const any = (files, re) => files.some((f) => re.test(f));

const SERVER_RE =
  /^(packages\/(core|db|module-kit|modules|ai|assistant-kit|assistant-runtime|contract|validation|config|document-signing)\/|apps\/(api|worker)\/)/;
const DB_WIDE_RE = /^(packages\/(core|db|module-kit|config)\/|pnpm-lock\.yaml$)/;
const GLOBAL_RE =
  /^(pnpm-lock\.yaml|pnpm-workspace\.yaml|package\.json|turbo\.json|prettier\.config\.mjs|packages\/tooling\/)/;

function dbFilters(files) {
  const filters = new Set();
  for (const f of files) {
    const mod = f.match(/^packages\/modules\/([^/]+)\//);
    if (mod) {
      filters.add(`packages/modules/${mod[1]}/`);
      continue;
    }
    const pkg = f.match(/^(packages\/(ai|assistant-kit|assistant-runtime|contract|validation|document-signing)|apps\/(api|worker))\//);
    if (pkg) filters.add(`${pkg[1]}/`);
  }
  return [...filters].sort();
}

function buildPlan(files, opts) {
  const full = opts.full;
  const global = any(files, GLOBAL_RE);
  const want = (name, reason) => ({ name, reason });
  const skipped = (name, reason) => ({ name, skip: reason });
  const plan = [];

  plan.push(
    files.length > 0 || full
      ? want("diff-hygiene", "comments and the source budget")
      : skipped("diff-hygiene", "no changes"),
  );

  const formatTargets = files.filter(
    (f) => !f.startsWith("docs/") && !f.startsWith(".claude/"),
  );
  plan.push(
    formatTargets.length > 0 || full
      ? want("format", full ? "full" : `${formatTargets.length} changed files`)
      : skipped("format", "no formattable changes"),
  );

  const codeTouched = full || global || any(files, /^(apps|packages|\.github)\//);
  for (const name of ["typecheck", "lint", "test-unit"]) {
    plan.push(
      codeTouched
        ? want(name, full ? "full" : "affected packages")
        : skipped(name, "no package changes"),
    );
  }

  if (opts.db === "off") plan.push(skipped("test-db", "--db off"));
  else if (opts.db === "on" || full || any(files, DB_WIDE_RE)) {
    plan.push({ ...want("test-db", "whole DB suite"), dbFilters: [] });
  } else if (any(files, SERVER_RE) || any(files, /\.db\.test\.ts$/)) {
    const filters = dbFilters(files);
    plan.push(
      filters.length > 0
        ? { ...want("test-db", filters.join(" ")), dbFilters: filters }
        : skipped("test-db", "no DB-backed package changes"),
    );
  } else plan.push(skipped("test-db", "no server changes"));

  plan.push(
    full ||
      global ||
      any(files, /^(packages\/(core|modules|contract|ai|validation|assistant-kit|assistant-runtime)\/|apps\/api\/)/)
      ? want("contract-check", full ? "full" : "actions/registry touched")
      : skipped("contract-check", "no action or registry changes"),
  );

  plan.push(
    full || any(files, /^(packages\/db\/(src\/schema|migrations|drizzle)|apps\/api\/src\/auth\/)/)
      ? want("migration-drift", full ? "full" : "schema/migrations/auth touched")
      : skipped("migration-drift", "no schema changes"),
  );

  plan.push(
    full ||
      any(files, /^(packages\/(contract|validation|core\/src\/contract)\/|packages\/modules\/[^/]+\/src\/(index\.contract\.ts|.*\.contract\.ts$))/)
      ? want("bundle-probe", full ? "full" : "client contract touched")
      : skipped("bundle-probe", "no client contract changes"),
  );

  plan.push(
    full || any(files, /^apps\/web\//)
      ? want("build-web", full ? "full" : "apps/web touched")
      : skipped("build-web", "apps/web untouched"),
  );

  plan.push(full ? want("e2e-smoke", "full") : skipped("e2e-smoke", "CI only (use --full)"));

  return plan
    .map((step) => {
      if (opts.only && !opts.only.has(step.name)) return { ...step, skip: "not in --only" };
      if (opts.skip.has(step.name)) return { ...step, skip: "--skip" };
      return step;
    })
    .map((step) => ({ ...step, formatTargets }));
}

// ----------------------------------------------------------------- run ----
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function run(cmd, args, { cwd, env, logFile }) {
  const started = Date.now();
  // On Windows, pnpm/turbo are .cmd shims and need a shell. Pass one command
  // string (args array + shell is deprecated in recent Node releases).
  const quote = (a) => (/[\s"&|<>^]/.test(a) ? `"${a.replaceAll('"', '\\"')}"` : a);
  const res = spawnSync(IS_WIN ? [cmd, ...args].map(quote).join(" ") : cmd, IS_WIN ? [] : args, {
    cwd,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", CI: process.env.CI ?? "", ...env },
    encoding: "utf8",
    shell: IS_WIN,
    maxBuffer: 256 * 1024 * 1024,
  });
  const output = `${res.stdout ?? ""}${res.stderr ?? ""}`.replace(ANSI_RE, "");
  const header = `$ ${cmd} ${args.join(" ")}\n`;
  writeFileSync(logFile, header + output, { flag: "a" });
  return {
    ok: res.status === 0,
    code: res.status,
    output,
    error: res.error ? String(res.error) : null,
    ms: Date.now() - started,
  };
}

function tailRelevant(output, lines) {
  const all = output.split(/\r?\n/).filter((l) => l.trim() !== "");
  const noisy = /^(\s*(cache (hit|miss|bypass)|Tasks:|Cached:|Time:|•|turbo \d)|.*: cache (hit|miss))/i;
  const kept = all.filter((l) => !noisy.test(l));
  return kept.slice(-lines).join("\n");
}

function pnpm(args, ctx, env) {
  return run("pnpm", args, { ...ctx, env });
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function executeStep(step, ctx) {
  const turboFilter = ctx.full
    ? []
    : [
        `--filter=...[${ctx.base.sha}]`,
        // Workflow/CI script changes are proven by @showzy/tooling tests.
        ...(ctx.files.some((f) => f.startsWith(".github/")) ? ["--filter=@showzy/tooling"] : []),
      ];
  const turbo = (task, extra = []) =>
    pnpm(
      ["exec", "turbo", "run", task, ...turboFilter, "--continue", "--output-logs=errors-only", ...extra],
      ctx,
    );
  const results = [];
  const push = (r) => {
    results.push(r);
    return r;
  };

  switch (step.name) {
    case "diff-hygiene":
      push(
        run("node", [".claude/scripts/diff-hygiene.mjs", "--base", ctx.base.sha], ctx),
      );
      break;
    case "format": {
      if (ctx.full) {
        push(pnpm(["format:check"], ctx));
        break;
      }
      const targets = step.formatTargets.filter((f) => existsSync(path.join(ctx.cwd, f)));
      for (const group of chunk(targets, 40)) {
        const base = ["exec", "prettier", "--ignore-unknown", "--no-error-on-unmatched-pattern"];
        if (ctx.fix) pnpm([...base, "--write", "--log-level", "warn", ...group], ctx);
        push(pnpm([...base, "--check", ...group], ctx));
      }
      break;
    }
    case "typecheck":
      push(turbo("typecheck"));
      break;
    case "lint":
      push(turbo("lint"));
      break;
    case "test-unit":
      push(turbo("test:unit", ["--concurrency=2"]));
      break;
    case "test-db": {
      const docker = run("docker", ["info", "--format", "{{.ServerVersion}}"], ctx);
      if (!docker.ok) {
        return {
          ok: false,
          blocked: "Docker is not running — start Docker Desktop, then re-run with --only test-db",
          ms: docker.ms,
          output: docker.output,
        };
      }
      push(pnpm(["test:db", "--passWithNoTests", ...(step.dbFilters ?? [])], ctx));
      break;
    }
    case "contract-check":
      push(pnpm(["--filter", "@showzy/api", "contract:check"], ctx));
      break;
    case "migration-drift":
      if (push(pnpm(["--filter", "@showzy/db", "db:check"], ctx)).ok) {
        if (ctx.full || ctx.files.some((f) => f.startsWith("apps/api/src/auth/"))) {
          push(pnpm(["--filter", "@showzy/api", "auth:check"], ctx));
        }
      }
      break;
    case "bundle-probe":
      if (push(pnpm(["--filter", "@showzy/contract", "bundle:probe"], ctx)).ok) {
        push(pnpm(["--filter", "@showzy/contract", "openapi:check"], ctx));
      }
      break;
    case "build-web":
      push(pnpm(["exec", "turbo", "run", "build", "--filter=@showzy/web", "--output-logs=errors-only"], ctx));
      break;
    case "e2e-smoke":
      push(pnpm(["exec", "turbo", "run", "e2e-smoke", "--filter=@showzy/web", "--output-logs=errors-only"], ctx));
      break;
    default:
      throw new Error(`no runner for ${step.name}`);
  }
  return {
    ok: results.every((r) => r.ok),
    ms: results.reduce((sum, r) => sum + r.ms, 0),
    output: results.filter((r) => !r.ok).map((r) => r.error ?? r.output).join("\n"),
  };
}

// ---------------------------------------------------------------- main ----
function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = repoRoot();
  const base = resolveBase(root, opts.base);
  const files = changedFiles(root, base.sha);
  const plan = buildPlan(files, opts);
  const logDir = path.join(root, ".claude", ".verify");
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], root);

  console.log(
    `verify: branch=${branch} base=${base.ref}@${base.sha.slice(0, 8)} changed=${files.length}${opts.full ? " mode=full" : ""}`,
  );
  if (opts.dryRun) {
    for (const step of plan) {
      console.log(`  ${step.skip ? "-" : "+"} ${step.name.padEnd(16)} ${step.skip ?? step.reason}`);
    }
    if (files.length > 0) console.log(`changed:\n  ${files.slice(0, 40).join("\n  ")}${files.length > 40 ? "\n  …" : ""}`);
    return 0;
  }

  mkdirSync(logDir, { recursive: true });
  const ctx = { cwd: root, base, files, fix: opts.fix, full: opts.full };
  const summary = [];
  for (const step of plan) {
    if (step.skip) {
      summary.push({ name: step.name, status: "skip", note: step.skip });
      continue;
    }
    const logFile = path.join(logDir, `${step.name}.log`);
    writeFileSync(logFile, "");
    process.stdout.write(`  … ${step.name}\n`);
    const result = executeStep(step, { ...ctx, logFile });
    summary.push({
      name: step.name,
      status: result.blocked ? "blocked" : result.ok ? "pass" : "FAIL",
      note: result.blocked ?? `${(result.ms / 1000).toFixed(1)}s`,
      logFile,
      output: result.output,
    });
  }

  console.log("");
  const icon = { pass: "PASS", FAIL: "FAIL", skip: "skip", blocked: "BLOCKED" };
  for (const s of summary) {
    console.log(`${icon[s.status].padEnd(8)} ${s.name.padEnd(16)} ${s.note}`);
  }
  const failed = summary.filter((s) => s.status === "FAIL" || s.status === "blocked");
  for (const s of failed) {
    const rel = path.relative(root, s.logFile).replaceAll("\\", "/");
    console.log(`\n── ${s.name} (full log: ${rel}) ──`);
    console.log(tailRelevant(s.output ?? "", opts.tail) || "(no output captured)");
  }
  const notRun = summary.filter((s) => s.status === "skip").map((s) => s.name);
  console.log(
    `\nRESULT: ${failed.length === 0 ? "PASS" : `FAIL (${failed.map((s) => s.name).join(", ")})`}` +
      (notRun.length > 0 ? ` — not run: ${notRun.join(", ")}` : ""),
  );
  return failed.length === 0 ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`verify: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
