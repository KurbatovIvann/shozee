// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { TRANSIENT_LINT_PROBE_DIR } from "@showzy/tooling/lint-probe";
import { describe, expect, it } from "vitest";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

const CLIENT_APP_LOCAL_COPY = "eslint/import-boundaries.test.mjs";

describe("transient lint probe directory name (SHO-863)", () => {
  it("keeps the copy the clientApp boundary forces in step with tooling", () => {
    const source = readFileSync(join(webRoot, CLIENT_APP_LOCAL_COPY), "utf8");
    expect(source).toContain(
      `const TRANSIENT_LINT_PROBE_DIR = "${TRANSIENT_LINT_PROBE_DIR}";`,
    );
  });
});
