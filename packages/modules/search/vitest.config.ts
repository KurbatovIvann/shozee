import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.db.test.ts"],
        },
      },
      {
        test: {
          name: "db",
          include: ["src/**/*.db.test.ts"],
          globalSetup: ["@showzy/db/testing/global-setup"],
          testTimeout: 120_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
