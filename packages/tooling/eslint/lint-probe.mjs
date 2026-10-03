/**
 * Transient ESLint probe files (SHO-863). `apps/web/eslint/import-boundaries.test.mjs`
 * must write its probes as real files under `apps/web/src`: `projectService: true`
 * rejects a virtual `filePath`, and `showzy-web/layer-boundaries` classifies by the
 * `/apps/web/src/<layer>/` path. Every source walk that reads that tree therefore
 * skips this directory, or it races the suite's cleanup (ENOENT).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TRANSIENT_LINT_PROBE_DIR = "__boundary-probe__";

/**
 * Proves a source walk never reads a transient probe file.
 *
 * @param {(root: string) => readonly string[]} walk
 */
export function assertWalkSkipsLintProbes(walk) {
  const root = mkdtempSync(join(tmpdir(), "showzy-lint-probe-"));
  try {
    mkdirSync(join(root, "nested", TRANSIENT_LINT_PROBE_DIR), {
      recursive: true,
    });
    writeFileSync(
      join(root, "nested", TRANSIENT_LINT_PROBE_DIR, "probe.ts"),
      "export const PROBE_ONLY = 1;\n",
    );
    writeFileSync(join(root, "nested", "kept.ts"), "export const KEPT = 1;\n");
    const seen = walk(root).map((file) => file.replaceAll("\\", "/"));
    assert.ok(
      seen.some((file) => file.endsWith("/nested/kept.ts")),
      "walk did not reach the file next to the probe directory",
    );
    assert.deepEqual(
      seen.filter((file) => file.includes(TRANSIENT_LINT_PROBE_DIR)),
      [],
      "walk read a transient lint probe",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
