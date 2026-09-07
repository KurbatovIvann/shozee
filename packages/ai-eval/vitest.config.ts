import { defineConfig } from "vitest/config";

/**
 * CI unit suite: Docker-free, no live model, no Postgres template.
 * Live scenarios live in `src/eval/*.eval.ts` and are not collected here.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["src/eval/**", "**/*.eval.ts"],
    environment: "node",
  },
});
