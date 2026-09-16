import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { REQUIRED_QUALITY_GATES } from "./required-quality-gates.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

test("root packageManager is pnpm 12 so audit uses the bulk advisory endpoint", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );
  assert.match(pkg.packageManager, /^pnpm@12\./);
  const lockfile = fs.readFileSync(
    path.join(repoRoot, "pnpm-lock.yaml"),
    "utf8",
  );
  assert.match(lockfile, /packageManagerDependencies:/);
  assert.match(lockfile, /specifier: 12\.3\.2/);
});

const workflowPath = path.join(repoRoot, ".github/workflows/ci.yml");
const setupActionPath = path.join(
  repoRoot,
  ".github/actions/setup-ci-workspace/action.yml",
);
const aggregatorScript = "packages/tooling/ci/aggregate-required-gates.mjs";
const timingScript = "packages/tooling/ci/publish-job-timing.sh";

const PARALLEL_CHECK_JOBS = [
  "format",
  "typecheck",
  "lint",
  "test-unit",
  "test-db",
  "build-smoke",
];

const INDEPENDENT_GATES = [
  "secret-scan",
  "dependency-audit",
  "contract-check",
  "migration-drift",
  "bundle-probe",
  "e2e-smoke",
];

/**
 * @param {string} source
 * @param {string} name
 */
function extractJob(source, name) {
  const start = source.search(new RegExp(`^ {2}${name}:\\s*$`, "m"));
  if (start < 0) {
    throw new Error(`missing job ${name}`);
  }
  const rest = source.slice(start);
  const next = rest.slice(1).search(/^ {2}[a-z][a-z0-9-]*:\s*$/m);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/**
 * @param {string} block
 * @returns {string[]}
 */
function jobNeeds(block) {
  const list = block.match(/^ {4}needs:\s*\n((?: {6}- [^\n]+\n)+)/m);
  if (list) {
    return [...list[1].matchAll(/^ {6}- (\S+)/gm)].map((match) => match[1]);
  }
  const inline = block.match(/^ {4}needs:\s*\[([^\]]*)\]/m);
  if (inline) {
    return inline[1]
      .split(",")
      .map((item) => item.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  return [];
}

/**
 * @param {string} block
 */
function jobIf(block) {
  const match = block.match(/^ {4}if:\s*(.+)$/m);
  return match ? match[1].trim() : undefined;
}

/**
 * Job header is the YAML before `steps:`. GitHub evaluates
 * `jobs.<id>.env` without the `runner` context (parse failure).
 * @param {string} block
 */
function jobHeader(block) {
  return block.split(/^ {4}steps:/m)[0] ?? "";
}

/**
 * @param {string} source
 * @returns {string[]}
 */
function jobIds(source) {
  const jobsStart = source.search(/^jobs:\s*$/m);
  const jobsSource = jobsStart < 0 ? source : source.slice(jobsStart);
  return [...jobsSource.matchAll(/^ {2}([a-z][a-z0-9-]*):\s*$/gm)].map(
    (match) => match[1],
  );
}

/**
 * Joins shell lines that end with a trailing `\` onto the line that follows.
 * @param {string[]} lines
 * @returns {string[]}
 */
function joinLineContinuations(lines) {
  /** @type {string[]} */
  const joined = [];
  let pending = "";
  for (const line of lines) {
    const current = pending ? `${pending} ${line}` : line;
    if (current.endsWith("\\")) {
      pending = current.slice(0, -1).trimEnd();
      continue;
    }
    joined.push(current);
    pending = "";
  }
  if (pending) {
    joined.push(pending);
  }
  return joined;
}

/**
 * Every shell command a workflow or composite action runs. A `run: |` block
 * yields one command per logical line (trailing-`\` continuations joined); a
 * folded `run: >` block and a plain or quoted scalar that continues onto more
 * indented lines yield one command. YAML anchors and aliases are not resolved.
 * @param {string} source
 * @returns {string[]}
 */
function runStepCommands(source) {
  const lines = source.split(/\r?\n/);
  /** @type {string[]} */
  const commands = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)(- )?run:\s*(.*)$/);
    if (!match) {
      continue;
    }
    const keyColumn = match[1].length + (match[2]?.length ?? 0);
    const header = match[3].trim();
    /** @type {string[]} */
    const body = [];
    let next = index + 1;
    while (
      next < lines.length &&
      (lines[next].trim() === "" ||
        (lines[next].match(/^\s*/)?.[0].length ?? 0) > keyColumn)
    ) {
      body.push(lines[next].trim());
      next += 1;
    }
    index = next - 1;
    const isBlockScalar = header.startsWith("|") || header.startsWith(">");
    const logicalLines = joinLineContinuations(
      [...(isBlockScalar ? [] : [header]), ...body].filter(
        (line) => line !== "",
      ),
    );
    if (header.startsWith("|")) {
      commands.push(...logicalLines);
    } else if (logicalLines.length > 0) {
      commands.push(logicalLines.join(" "));
    }
  }
  return commands;
}

/**
 * A bare or path-qualified `turbo` word (a version suffix like `turbo@2`
 * included), or any launcher form the earlier launcher-only guard caught, so
 * this matcher stays a strict superset of it.
 */
const SPAWNS_TURBO_BINARY =
  /(?:^|[\s;&|()"'`/])turbo(?=$|[\s;&|()"'`<>@])|\b(?:pnpm|npx|yarn)\s+(?:exec\s+|dlx\s+)?turbo\b/;

const ROOT_SCRIPT_FLAG =
  "(?!-r\\b|--recursive\\b|-F\\b|--filter|-C\\b|--dir\\b)-{1,2}[A-Za-z][\\w-]*(?:=\\S+)?";

/**
 * @param {string} text
 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A command that runs the root `package.json` script `name`, with optional
 * flags before and after `run`. Package selectors (`-r`, `--filter`, `--dir`)
 * run a workspace package's script, not the root one, and do not match.
 * @param {string} name
 */
function rootScriptInvocation(name) {
  const script = `${escapeRegExp(name)}(?=$|[\\s;&|)"'])`;
  const flags = `(?:\\s+${ROOT_SCRIPT_FLAG})*`;
  return new RegExp(
    `\\b(?:(?:pnpm|yarn)${flags}\\s+(?:run${flags}\\s+)?|npm${flags}\\s+run${flags}\\s+)${script}`,
  );
}

/**
 * Root scripts that start turbo, directly or through another such script.
 * @param {Record<string, string>} scripts
 * @returns {string[]}
 */
function turboRootScripts(scripts) {
  /** @type {Set<string>} */
  const turboScripts = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, body] of Object.entries(scripts)) {
      if (turboScripts.has(name)) {
        continue;
      }
      const startsTurbo =
        SPAWNS_TURBO_BINARY.test(body) ||
        [...turboScripts].some((known) =>
          rootScriptInvocation(known).test(body),
        );
      if (startsTurbo) {
        turboScripts.add(name);
        grew = true;
      }
    }
  }
  return [...turboScripts].sort();
}

/**
 * Repo-relative paths of every workflow and composite action under `root`.
 * @param {string} root
 * @returns {string[]}
 */
function ciRunSourcePaths(root) {
  const workflowsDir = path.join(root, ".github/workflows");
  const actionsDir = path.join(root, ".github/actions");
  const workflows = fs.existsSync(workflowsDir)
    ? fs
        .readdirSync(workflowsDir)
        .filter((name) => /\.ya?ml$/.test(name))
        .map((name) => `.github/workflows/${name}`)
    : [];
  const actions = fs.existsSync(actionsDir)
    ? fs
        .readdirSync(actionsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) =>
          ["action.yml", "action.yaml"].map(
            (file) => `.github/actions/${entry.name}/${file}`,
          ),
        )
        .filter((file) => fs.existsSync(path.join(root, file)))
    : [];
  return [...workflows, ...actions].sort();
}

/**
 * Every CI step under `root` that could start turbo outside `run-turbo.mjs`
 * (and so read the turbo cache) or that overrides what the helper decides.
 * @param {string} root
 * @returns {{ file: string, rule: string, command: string }[]}
 */
function turboGuardFindings(root) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  const turboScriptInvocations = turboRootScripts(manifest.scripts ?? {}).map(
    rootScriptInvocation,
  );
  /** @type {{ file: string, rule: string, command: string }[]} */
  const findings = [];
  for (const file of ciRunSourcePaths(root)) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    for (const command of runStepCommands(source)) {
      if (
        SPAWNS_TURBO_BINARY.test(command) ||
        turboScriptInvocations.some((invocation) => invocation.test(command))
      ) {
        findings.push({ file, rule: "turbo-outside-run-turbo", command });
      }
      if (!command.includes("run-turbo.mjs")) {
        continue;
      }
      if (/--cache\b/.test(command)) {
        findings.push({ file, rule: "cache-override", command });
      }
      if (/--print-only\b/.test(command)) {
        findings.push({ file, rule: "print-only", command });
      }
    }
  }
  return findings;
}

/**
 * @param {Record<string, string>} files
 * @param {(root: string) => void} check
 */
function withSyntheticRepo(files, check) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "turbo-guard-"));
  try {
    for (const [file, content] of Object.entries(files)) {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    check(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const SYNTHETIC_MANIFEST = JSON.stringify({
  scripts: {
    check: "turbo run lint",
    typecheck: "turbo run typecheck",
    "test:unit": "turbo run test:unit",
    test: "pnpm test:unit && pnpm test:db",
    "test:db": "vitest run",
    "format:check": "prettier --check .",
  },
});

const TURBO_TASK_JOBS = ["typecheck", "lint", "test-unit", "build-smoke"];

const workflow = fs.readFileSync(workflowPath, "utf8");
const setupAction = fs.readFileSync(setupActionPath, "utf8");

test("CI workflow keeps concurrency cancellation and has no retries", () => {
  assert.match(workflow, /group:\s+ci-\$\{\{ github\.ref \}\}/);
  assert.match(
    workflow,
    /cancel-in-progress:\s+\$\{\{ github\.ref != 'refs\/heads\/main' \}\}/,
  );
  assert.doesNotMatch(workflow, /retry|rerun-on-failure|max-attempts/i);
  assert.doesNotMatch(workflow, /continue-on-error:\s*true/);
});

test("format, typecheck, lint, test-unit, test-db, and build-smoke are independent jobs", () => {
  for (const name of PARALLEL_CHECK_JOBS) {
    const block = extractJob(workflow, name);
    assert.deepEqual(
      jobNeeds(block),
      [],
      `${name} must not wait on other jobs`,
    );
    assert.match(block, /uses:\s+\.\/\.github\/actions\/setup-ci-workspace/);
    assert.match(block, /Record job start/);
    assert.match(block, /Publish job timing/);
    assert.match(block, /if: always\(\)/);
  }

  assert.match(extractJob(workflow, "format"), /pnpm format:check/);
  assert.match(extractJob(workflow, "typecheck"), /run-turbo\.mjs typecheck/);
  assert.match(extractJob(workflow, "lint"), /run-turbo\.mjs lint/);
  const testUnit = extractJob(workflow, "test-unit");
  assert.match(testUnit, /run-turbo\.mjs test:unit/);
  assert.doesNotMatch(testUnit, /pnpm test:db/);
  const testDb = extractJob(workflow, "test-db");
  assert.match(testDb, /pnpm test:db/);
  assert.match(testDb, /assert-shared-db-runtime\.mjs/);
  assert.match(testDb, /assert-test-suite-collection\.mjs/);
  const collectAt = testDb.indexOf("assert-test-suite-collection.mjs");
  const runAt = testDb.indexOf("pnpm test:db");
  const probeAt = testDb.indexOf("assert-shared-db-runtime.mjs");
  assert.ok(
    collectAt >= 0 && collectAt < runAt && runAt < probeAt,
    "test-db must collect, then run one suite, then assert one template",
  );
  assert.doesNotMatch(testDb, /run-turbo\.mjs/);
  assert.doesNotMatch(testDb, /turbo-local-cache/);
  assert.doesNotMatch(testDb, /--shard/);
  assert.doesNotMatch(workflow, /^ {2}test:\s*$/m);

  const buildSmoke = extractJob(workflow, "build-smoke");
  assert.match(
    buildSmoke,
    /run-turbo\.mjs export:web --filter=@showzy\/mobile/,
  );
  assert.match(buildSmoke, /run-turbo\.mjs build --filter=@showzy\/web/);

  const serialChecks = extractJob(workflow, "checks");
  assert.doesNotMatch(serialChecks, /pnpm format:check/);
  assert.doesNotMatch(serialChecks, /pnpm typecheck/);
  assert.doesNotMatch(serialChecks, /pnpm lint/);
  assert.doesNotMatch(serialChecks, /pnpm test[^\n-]/);
});

test("secret-scan and the other named gates remain independent workers", () => {
  for (const name of INDEPENDENT_GATES) {
    const block = extractJob(workflow, name);
    assert.deepEqual(
      jobNeeds(block),
      [],
      `${name} must stay an independent gate`,
    );
  }

  assert.match(
    extractJob(workflow, "secret-scan"),
    /gitleaks\/gitleaks-action@/,
  );
  const dependencyAudit = extractJob(workflow, "dependency-audit");
  assert.match(dependencyAudit, /pnpm audit --audit-level high/);
  assert.match(dependencyAudit, /dependency-audit-scope\.mjs/);
  assert.match(dependencyAudit, /fetch-depth:\s+0/);
  assert.match(dependencyAudit, /steps\.scope\.outputs\.run == 'true'/);
  assert.match(dependencyAudit, /pnpm\/setup@/);
  assert.match(dependencyAudit, /install:\s*["']false["']/);
  assert.doesNotMatch(dependencyAudit, /ignore-registry-errors/);
  assert.doesNotMatch(dependencyAudit, /pnpm\/action-setup@/);
  const auditScope = fs.readFileSync(
    path.join(repoRoot, "packages/tooling/ci/dependency-audit-scope.mjs"),
    "utf8",
  );
  assert.match(auditScope, /pnpm-lock\.yaml/);
  assert.match(auditScope, /package\.json/);
  assert.doesNotMatch(auditScope, /pnpm\s+audit[^\n]*ignore-registry-errors/);
  assert.match(extractJob(workflow, "contract-check"), /contract:check/);
  assert.match(extractJob(workflow, "migration-drift"), /db:check/);
  assert.match(extractJob(workflow, "bundle-probe"), /bundle:probe/);
  const e2eSmoke = extractJob(workflow, "e2e-smoke");
  assert.match(e2eSmoke, /playwright install --with-deps chromium/);
  assert.match(e2eSmoke, /e2e-smoke --always-full --filter=@showzy\/web/);
  assert.doesNotMatch(e2eSmoke, /Placeholder/);
});

test("job-header scan rejects the GitHub parse failure of runner in jobs.env", () => {
  const invalidJob = `  test-db:
    runs-on: ubuntu-latest
    env:
      SHOWZY_DB_HARNESS_SETUP_COUNT_FILE: \${{ runner.temp }}/showzy-db-setup-count
    steps:
      - run: echo ok
`;
  assert.match(jobHeader(invalidJob), /\$\{\{\s*runner\./);
});

test("job-level env cannot use the runner context", () => {
  const ids = jobIds(workflow);
  assert.ok(ids.includes("test-db"), "test-db job must exist");
  for (const name of ids) {
    const header = jobHeader(extractJob(workflow, name));
    assert.doesNotMatch(
      header,
      /\$\{\{\s*runner\./,
      `${name}: runner is invalid in jobs.<id>.env (GitHub parse failure)`,
    );
  }

  const testDb = extractJob(workflow, "test-db");
  const header = jobHeader(testDb);
  assert.doesNotMatch(header, /SHOWZY_DB_HARNESS_/);
  assert.match(testDb, /SHOWZY_DB_HARNESS_SETUP_COUNT_FILE/);
  assert.match(testDb, /SHOWZY_DB_HARNESS_DB_NAMES_FILE/);
  assert.match(testDb, /GITHUB_ENV/);
  assert.match(testDb, /\$\{\{\s*runner\.temp\s*\}\}/);
});

test("checks is a fail-closed aggregator over every required quality job", () => {
  const checks = extractJob(workflow, "checks");
  assert.equal(jobIf(checks), "always()");
  assert.deepEqual(jobNeeds(checks), [...REQUIRED_QUALITY_GATES]);
  assert.match(checks, new RegExp(aggregatorScript.replaceAll(".", "\\.")));
  for (const name of REQUIRED_QUALITY_GATES) {
    assert.match(
      checks,
      new RegExp(`${name}=\\$\\{\\{ needs\\.${name}\\.result \\}\\}`),
    );
  }
  const header = checks.split(/^ {4}steps:/m)[0] ?? "";
  assert.doesNotMatch(
    header,
    /^ {4}name:/m,
    "job-level name would change the branch-protection check from `checks`",
  );
});

test("setup action caches the pnpm store and not node_modules", () => {
  assert.match(setupAction, /pnpm\/setup@/);
  assert.match(setupAction, /install:\s*["']false["']/);
  assert.doesNotMatch(setupAction, /pnpm\/action-setup@/);
  assert.match(setupAction, /cache:\s+pnpm/);
  assert.doesNotMatch(setupAction, /cache:\s*['"]?node_modules/);
  assert.doesNotMatch(setupAction, /actions\/cache@/);
});

test("Turbo jobs use the affected-or-full helper and restore no .turbo cache", () => {
  for (const name of TURBO_TASK_JOBS) {
    const block = extractJob(workflow, name);
    assert.match(block, /fetch-depth:\s+0/);
    assert.match(block, /Fetch PR base for Turbo affected/);
    assert.match(block, /run-turbo\.mjs/);
    assert.match(block, /TURBO_PR_BASE_SHA/);
  }

  const format = extractJob(workflow, "format");
  assert.doesNotMatch(format, /run-turbo\.mjs/);

  const e2eSmoke = extractJob(workflow, "e2e-smoke");
  assert.match(
    e2eSmoke,
    /run-turbo\.mjs e2e-smoke --always-full --filter=@showzy\/web/,
    "a cache: false required gate must state full execution, not inherit it from an unresolved base",
  );

  assert.doesNotMatch(workflow, /TURBO_TOKEN:/);
  assert.doesNotMatch(workflow, /secrets\.TURBO_TOKEN/);
  assert.doesNotMatch(workflow, /turbo-local-cache/);
  assert.doesNotMatch(setupAction, /path:\s+\.turbo/);
  assert.doesNotMatch(workflow, /actions:\s+write/);
});

test("no CI workflow or composite action step spawns turbo outside the one execution-mode helper", () => {
  const sources = ciRunSourcePaths(repoRoot);
  assert.ok(sources.includes(".github/workflows/ci.yml"));
  assert.ok(sources.includes(".github/actions/setup-ci-workspace/action.yml"));
  assert.ok(
    runStepCommands(workflow).some((command) =>
      command.includes("run-turbo.mjs"),
    ),
  );
  const rootManifest = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );
  const turboScripts = turboRootScripts(rootManifest.scripts);
  assert.ok(turboScripts.includes("test:unit"));
  assert.ok(turboScripts.includes("test"));
  assert.deepEqual(
    turboGuardFindings(repoRoot),
    [],
    "turbo outside run-turbo.mjs reads the cache; --cache or --print-only on run-turbo.mjs overrides or skips the run",
  );
});

test("the turbo guard flags a root package.json script that starts turbo, taken from the manifest", () => {
  withSyntheticRepo(
    {
      "package.json": SYNTHETIC_MANIFEST,
      ".github/workflows/ci.yml": `jobs:
  sneak:
    runs-on: ubuntu-latest
    steps:
      - run: time -p pnpm test:unit
      - run: pnpm run typecheck
      - run: pnpm check
      - run: pnpm test
      - run: pnpm test:db
      - run: pnpm format:check
      - run: pnpm --filter @showzy/web typecheck
      - run: pnpm --silent test:unit
      - run: pnpm run --silent test
      - run: pnpm -w --reporter=append-only run --if-present check
      - run: npm run --silent typecheck
      - run: yarn --silent test
      - run: pnpm --filter=@showzy/web typecheck
      - run: pnpm -r test:unit
      - run: pnpm --recursive run typecheck
      - run: pnpm --dir=apps/web check
`,
    },
    (root) => {
      assert.deepEqual(
        turboGuardFindings(root).map((finding) => finding.command),
        [
          "time -p pnpm test:unit",
          "pnpm run typecheck",
          "pnpm check",
          "pnpm test",
          "pnpm --silent test:unit",
          "pnpm run --silent test",
          "pnpm -w --reporter=append-only run --if-present check",
          "npm run --silent typecheck",
          "yarn --silent test",
        ],
      );
    },
  );
});

test("the turbo guard flags every turbo spawn the launcher-only guard on main caught, version suffixes included", () => {
  const spawns = [
    "npx turbo@2 run test:unit",
    "pnpm exec turbo@2.5 run lint",
    "pnpm dlx turbo@latest run typecheck",
    "pnpm turbo run lint",
    "yarn turbo run lint",
    "yarn exec turbo run lint",
    "npx turbo run build",
    "pnpm exec turbo.cmd run lint",
    "pnpm exec turbo>turbo.log",
    "echo `turbo run lint`",
    "result=$(turbo run lint)",
    "node_modules/.bin/turbo run lint",
    "turbo run lint",
  ];
  assert.deepEqual(
    spawns.filter((command) => !SPAWNS_TURBO_BINARY.test(command)),
    [],
  );
  const notSpawns = [
    "node packages/tooling/ci/run-turbo.mjs test:unit",
    'echo "base fetch failed; run-turbo will use full execution"',
    "rm -rf .turbo",
    "cat turbo.json",
  ];
  assert.deepEqual(
    notSpawns.filter((command) => SPAWNS_TURBO_BINARY.test(command)),
    [],
  );
});

test("the turbo guard reads composite actions, multi-line plain and folded scalars, and backslash continuations (YAML anchors unresolved; ci.yml has none)", () => {
  const workflowSource = `jobs:
  sneak:
    runs-on: ubuntu-latest
    steps:
      - name: Plain scalar
        run: pnpm exec
          turbo run typecheck
      - name: Backslash
        run: |
          echo building
          pnpm \\
            test:unit
      - name: Folded
        run: >
          pnpm
          exec turbo run build
        env:
          CI: "true"
`;
  assert.deepEqual(runStepCommands(workflowSource), [
    "pnpm exec turbo run typecheck",
    "echo building",
    "pnpm test:unit",
    "pnpm exec turbo run build",
  ]);
  withSyntheticRepo(
    {
      "package.json": SYNTHETIC_MANIFEST,
      ".github/workflows/ci.yml": workflowSource,
      ".github/actions/setup/action.yml": `name: setup
runs:
  using: composite
  steps:
    - run: pnpm exec turbo run lint
      shell: bash
`,
    },
    (root) => {
      assert.deepEqual(turboGuardFindings(root), [
        {
          file: ".github/actions/setup/action.yml",
          rule: "turbo-outside-run-turbo",
          command: "pnpm exec turbo run lint",
        },
        {
          file: ".github/workflows/ci.yml",
          rule: "turbo-outside-run-turbo",
          command: "pnpm exec turbo run typecheck",
        },
        {
          file: ".github/workflows/ci.yml",
          rule: "turbo-outside-run-turbo",
          command: "pnpm test:unit",
        },
        {
          file: ".github/workflows/ci.yml",
          rule: "turbo-outside-run-turbo",
          command: "pnpm exec turbo run build",
        },
      ]);
    },
  );
});

test("the turbo guard rejects --print-only and --cache on a run-turbo.mjs step", () => {
  withSyntheticRepo(
    {
      "package.json": SYNTHETIC_MANIFEST,
      ".github/workflows/ci.yml": `jobs:
  sneak:
    runs-on: ubuntu-latest
    steps:
      - run: time -p node packages/tooling/ci/run-turbo.mjs lint --print-only
      - run: node packages/tooling/ci/run-turbo.mjs test:unit --cache=local:rw
      - run: node packages/tooling/ci/run-turbo.mjs e2e-smoke --always-full
`,
    },
    (root) => {
      assert.deepEqual(
        turboGuardFindings(root).map((finding) => finding.rule),
        ["print-only", "cache-override"],
      );
    },
  );
});

test("the turbo guard reads block scalars, not only single-line run steps", () => {
  const evasion = `  sneak:
    runs-on: ubuntu-latest
    steps:
      - name: Build
        run: |
          echo building
          pnpm exec turbo run test:unit --cache=local:rw
      - name: After
        run: echo done
`;
  const commands = runStepCommands(evasion);
  assert.deepEqual(commands, [
    "echo building",
    "pnpm exec turbo run test:unit --cache=local:rw",
    "echo done",
  ]);
  assert.ok(commands.some((command) => SPAWNS_TURBO_BINARY.test(command)));
});

test("publish-job-timing writes a duration summary without failing", () => {
  const scriptPath = path.join(repoRoot, timingScript);
  const summaryPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "publish-job-timing.summary.tmp.md",
  );
  fs.writeFileSync(summaryPath, "");
  try {
    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        JOB_START_EPOCH: String(Math.floor(Date.now() / 1000) - 4),
        GITHUB_JOB: "lint",
        JOB_RESULT: "success",
        GITHUB_STEP_SUMMARY: summaryPath,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const summary = fs.readFileSync(summaryPath, "utf8");
    assert.match(summary, /## lint timing/);
    assert.match(summary, /Duration seconds/);
    assert.match(result.stdout, /Job lint finished in \d+s with success/);
  } finally {
    fs.unlinkSync(summaryPath);
  }
});
