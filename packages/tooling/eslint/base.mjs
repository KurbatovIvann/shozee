import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import js from "@eslint/js";
import prettierConfig from "eslint-config-prettier";
import boundaries from "eslint-plugin-boundaries";
import tseslint from "typescript-eslint";

import { importBoundariesRule } from "./import-boundaries.mjs";

/**
 * Walk from a package's eslint config directory to the monorepo root so
 * `boundaries/elements` patterns (`packages/core`, `apps/*`, …) match
 * regardless of which package invoked `eslint .`.
 *
 * @param {string} start
 * @returns {string}
 */
export function findRepoRoot(start) {
  let directory = start;
  while (!existsSync(join(directory, "pnpm-workspace.yaml"))) {
    const parent = dirname(directory);
    if (parent === directory) {
      return start;
    }
    directory = parent;
  }
  return directory;
}

/**
 * Architectural element types for eslint-plugin-boundaries, derived from
 * blueprint §5. Declared centrally so every package lints against the same
 * map. v7 renamed `boundaries/element-types` to `boundaries/dependencies`
 * (fnd-T25). Fine-grained specifier rules (own schema, `*.contract.ts`
 * allowlist) live in `showzy/import-boundaries` so they do not depend on
 * resolving workspace packages through pnpm.
 */
const boundaryElements = [
  { type: "app", pattern: "apps/*", capture: ["app"] },
  { type: "core", pattern: "packages/core" },
  { type: "db", pattern: "packages/db" },
  { type: "contract", pattern: "packages/contract" },
  { type: "module", pattern: "packages/modules/*", capture: ["module"] },
  { type: "money", pattern: "packages/money" },
  { type: "config", pattern: "packages/config" },
  { type: "ai", pattern: "packages/ai" },
  { type: "validation", pattern: "packages/validation" },
  { type: "copy", pattern: "packages/copy" },
  { type: "module-kit", pattern: "packages/module-kit" },
  { type: "tooling", pattern: "packages/tooling" },
];

const boundaryFiles = [
  { pattern: "**/*.contract.ts", category: "action-contract" },
  {
    pattern: "packages/contract/src/client/**/*.ts",
    category: "contract-client",
  },
  { pattern: "apps/mobile/**/*.{ts,tsx}", category: "client-app" },
  { pattern: "apps/web/**/*.{ts,tsx}", category: "client-app" },
];

const showzyPlugin = {
  meta: { name: "showzy", version: "0.0.0" },
  rules: {
    "import-boundaries": importBoundariesRule,
  },
};

/**
 * @param {string} repoRoot
 */
export function showzyBoundarySettings(repoRoot) {
  return {
    "boundaries/elements": boundaryElements,
    "boundaries/files": boundaryFiles,
    "boundaries/root-path": repoRoot,
    "boundaries/ignore": [
      "**/*.test.ts",
      "**/*.db.test.ts",
      "**/probe/leaks/**",
      "**/scripts/**",
      "**/migrations/**",
    ],
  };
}

/**
 * Package-level dependency matrix. Default is allow so existing packages
 * keep linting; policies encode the known-forbidden edges. Last matching
 * policy wins, so an allow that follows a broader disallow is an exception.
 */
export const showzyBoundaryDependencyOptions = {
  default: "allow",
  checkAllOrigins: true,
  policies: [
    {
      from: { file: { categories: "action-contract" } },
      disallow: { to: { module: { source: "@showzy/db" } } },
      message:
        "*.contract.ts may not import @showzy/db (contract.md §2, ADR-0016).",
    },
    {
      from: { file: { categories: "action-contract" } },
      disallow: { to: { module: { source: "@showzy/core" } } },
      message:
        "*.contract.ts may import @showzy/core/contract only, never the core runtime (ADR-0016).",
    },
    {
      from: { file: { categories: "action-contract" } },
      allow: {
        to: { module: { source: "@showzy/core", internalPath: "contract" } },
      },
    },
    {
      from: { file: { categories: "contract-client" } },
      disallow: { to: { module: { origin: "core" } } },
      message:
        "The contract client layer must not import Node builtins (ADR-0016).",
    },
    {
      from: { file: { categories: "contract-client" } },
      disallow: { to: { module: { source: "@showzy/db" } } },
    },
    {
      from: { file: { categories: "client-app" } },
      disallow: { to: { module: { source: "@showzy/core" } } },
      message:
        "Client apps may import only @showzy/contract, @showzy/validation, @showzy/copy, and @showzy/ui (contract.md §2, SHO-414).",
    },
    {
      from: { file: { categories: "client-app" } },
      disallow: { to: { module: { source: "@showzy/db" } } },
      message:
        "Client apps may import only @showzy/contract, @showzy/validation, @showzy/copy, and @showzy/ui (contract.md §2, SHO-414).",
    },
    {
      from: { file: { categories: "client-app" } },
      disallow: { to: { module: { source: "@showzy/config" } } },
      message:
        "Client apps may import only @showzy/contract, @showzy/validation, @showzy/copy, and @showzy/ui (contract.md §2, SHO-414).",
    },
    {
      from: { file: { categories: "client-app" } },
      disallow: { to: { module: { source: "@showzy/ai" } } },
      message: "Client apps may not import @showzy/ai (server-only, ADR-0032).",
    },
    {
      from: { element: { type: "copy" } },
      disallow: { to: { element: { type: "app" } } },
      message: "packages/copy must not import an app (SHO-414).",
    },
    {
      from: { element: { type: "module" } },
      disallow: { to: { element: { type: "contract" } } },
      message: "Module server code never imports packages/contract (ADR-0016).",
    },
    {
      from: { element: { type: "module" } },
      disallow: { to: { element: { type: "ai" } } },
      message:
        "Domain modules may not import packages/ai (ADR-0032). The API composition root mounts the AI loop.",
    },
    {
      from: { element: { type: "module" } },
      disallow: { to: { module: { source: "@showzy/ai" } } },
      message:
        "Domain modules may not import @showzy/ai (ADR-0032). The API composition root mounts the AI loop.",
    },
  ],
};

/**
 * Shared ESLint flat preset (strict, type-checked).
 *
 * @param {object} options
 * @param {string} options.tsconfigRootDir - Pass `import.meta.dirname` from
 *   the consuming package's `eslint.config.mjs` so typed linting resolves the
 *   right tsconfig.
 * @returns {import("typescript-eslint").ConfigArray}
 */
export function showzyEslintConfig({ tsconfigRootDir }) {
  const repoRoot = findRepoRoot(tsconfigRootDir);
  return tseslint.config(
    {
      ignores: [
        "dist/**",
        "coverage/**",
        "node_modules/**",
        ".turbo/**",
        "probe/leaks/**",
        ".expo/**",
      ],
    },
    js.configs.recommended,
    ...tseslint.configs.strictTypeChecked,
    {
      languageOptions: {
        parserOptions: {
          projectService: true,
          tsconfigRootDir,
        },
      },
      plugins: { boundaries, showzy: showzyPlugin },
      settings: showzyBoundarySettings(repoRoot),
      rules: {
        "showzy/import-boundaries": "error",
        "boundaries/dependencies": ["error", showzyBoundaryDependencyOptions],
        // Prohibitions (.cursor/rules/prohibitions.mdc): no `any`,
        // no suppression comments without a linked issue.
        "@typescript-eslint/no-explicit-any": "error",
        "@typescript-eslint/ban-ts-comment": [
          "error",
          {
            "ts-ignore": true,
            "ts-nocheck": true,
            // `@ts-expect-error` only with a linked issue, e.g.
            // "@ts-expect-error SHO-123: drizzle inference gap".
            "ts-expect-error": { descriptionFormat: "^ SHO-\\d+: .+$" },
          },
        ],
        // No `x as unknown as Y` escape hatch (prohibitions.mdc).
        "no-restricted-syntax": [
          "error",
          {
            selector: "TSAsExpression > TSAsExpression",
            message:
              "Double assertions (`as unknown as`) are prohibited. Fix the types instead.",
          },
        ],
        // Typed error classes only (conventions.mdc); allowing only classes
        // that extend Error still permits `packages/core/errors` subclasses.
        "@typescript-eslint/only-throw-error": "error",
      },
    },
    {
      // Config and script files (.mjs) are not covered by a tsconfig project;
      // typed rules cannot run on them.
      files: ["**/*.mjs", "**/*.js", "**/*.cjs"],
      extends: [tseslint.configs.disableTypeChecked],
    },
    {
      // Expo (and similar) CJS configs: Metro/Babel loaders require() these.
      files: ["**/*.cjs"],
      languageOptions: {
        globals: {
          __dirname: "readonly",
          __filename: "readonly",
          exports: "writable",
          module: "writable",
          require: "readonly",
        },
      },
      rules: {
        "@typescript-eslint/no-require-imports": "off",
      },
    },
    // Keep last: disables formatting rules that would conflict with Prettier.
    prettierConfig,
  );
}
