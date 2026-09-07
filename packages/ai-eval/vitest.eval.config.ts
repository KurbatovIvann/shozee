import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/**
 * Hand-run live eval. Reuses the existing Testcontainers Postgres
 * `globalSetup` from `@showzy/db` — not a second harness. Not collected
 * by `test:unit` or `test:db` (`*.eval.ts` is not `*.test.ts`).
 */
export default defineConfig({
  root: repoRoot,
  server: {
    fs: {
      allow: [repoRoot],
    },
  },
  test: {
    name: "ai-eval-live",
    include: ["packages/ai-eval/src/eval/**/*.eval.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    globalSetup: [
      path.join(repoRoot, "packages/db/src/testing/global-setup.ts"),
    ],
    environment: "node",
    testTimeout: 600_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    maxWorkers: 1,
  },
});
