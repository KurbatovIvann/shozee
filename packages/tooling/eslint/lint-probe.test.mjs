/**
 * SHO-863: `lint-probe.d.mts` is the only description of this module's shape
 * that consumers typecheck against, and nothing typechecks the declaration
 * itself (this package has no tsconfig). These cases hold the runtime export
 * to what the declaration promises.
 */
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  assertWalkSkipsLintProbes,
  TRANSIENT_LINT_PROBE_DIR,
} from "./lint-probe.mjs";

/**
 * @param {string} root
 */
function walkEverything(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walkEverything(join(root, entry.name))
      : [join(root, entry.name)],
  );
}

/**
 * @param {string} root
 */
function walkSkippingProbes(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
    entry.name === TRANSIENT_LINT_PROBE_DIR
      ? []
      : entry.isDirectory()
        ? walkSkippingProbes(join(root, entry.name))
        : [join(root, entry.name)],
  );
}

test("TRANSIENT_LINT_PROBE_DIR is the directory name string consumers skip", () => {
  assert.equal(typeof TRANSIENT_LINT_PROBE_DIR, "string");
  assert.equal(TRANSIENT_LINT_PROBE_DIR, "__boundary-probe__");
});

test("assertWalkSkipsLintProbes is a one-argument function", () => {
  assert.equal(typeof assertWalkSkipsLintProbes, "function");
  assert.equal(assertWalkSkipsLintProbes.length, 1);
});

test("assertWalkSkipsLintProbes accepts a walk that skips the probe directory", () => {
  assertWalkSkipsLintProbes(walkSkippingProbes);
});

test("assertWalkSkipsLintProbes throws on a walk that returns a probe path", () => {
  assert.throws(
    () => {
      assertWalkSkipsLintProbes(walkEverything);
    },
    { message: /transient lint probe/ },
  );
});

test("assertWalkSkipsLintProbes throws on a walk that reaches nothing", () => {
  assert.throws(
    () => {
      assertWalkSkipsLintProbes(() => []);
    },
    { message: /next to the probe directory/ },
  );
});
