import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const read = (relative) =>
  fs.readFileSync(path.join(repoRoot, relative), "utf8");

const parseVersion = (value) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  assert.ok(match, `not a concrete version: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

const isAtLeast = (version, minimum) => {
  for (let i = 0; i < 3; i += 1) {
    if (version[i] !== minimum[i]) return version[i] > minimum[i];
  }
  return true;
};

const nvmrc = read(".nvmrc").trim();
const pinned = parseVersion(nvmrc);

const WORKFLOW_FILES = [
  ".github/workflows/ci.yml",
  ".github/actions/setup-ci-workspace/action.yml",
];

test(".nvmrc satisfies the engines floor the Sho runtime requires", () => {
  const engines = JSON.parse(read("package.json")).engines.node;
  const floor = /^>=\s*(\d+)\.(\d+)(?:\.(\d+))?$/.exec(engines);
  assert.ok(floor, `engines.node must be a >= floor, got ${engines}`);
  const minimum = [Number(floor[1]), Number(floor[2]), Number(floor[3] ?? 0)];
  assert.deepEqual(minimum, [24, 14, 0]);
  assert.ok(
    isAtLeast(pinned, minimum),
    `.nvmrc ${nvmrc} is below engines.node ${engines}`,
  );
});

test("every CI Node setup uses the major that .nvmrc pins", () => {
  for (const file of WORKFLOW_FILES) {
    const versions = [...read(file).matchAll(/node-version:\s*"([^"]+)"/g)].map(
      (match) => match[1],
    );
    assert.ok(versions.length > 0, `${file} sets up no Node version`);
    for (const version of versions) {
      assert.equal(version, String(pinned[0]), `${file} pins Node ${version}`);
    }
  }
});

test("the web build image tracks the pinned Node minor", () => {
  const base = /^FROM node:([^\s]+)-alpine AS build$/m.exec(
    read("apps/web/Dockerfile"),
  );
  assert.ok(base, "apps/web/Dockerfile has no pinned node alpine build stage");
  assert.equal(base[1], `${pinned[0]}.${pinned[1]}`);
});

test("the runtime strips TypeScript types without an experimental flag", () => {
  assert.ok(
    isAtLeast(parseVersion(process.versions.node), [24, 14, 0]),
    `running Node ${process.versions.node}, below the engines floor`,
  );
  assert.equal(process.features.typescript, "strip");
});

test("no manifest still passes --experimental-strip-types", () => {
  const manifests = [
    "apps/api/package.json",
    "apps/worker/package.json",
    "packages/jobs/package.json",
  ];
  for (const manifest of manifests) {
    assert.doesNotMatch(
      read(manifest),
      /--experimental-strip-types/,
      `${manifest} still passes the flag Node ${pinned[0]} defaults on`,
    );
  }
});
