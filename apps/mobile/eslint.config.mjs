import { showzyEslintConfig } from "@showzy/tooling/eslint";

import { assistantTsxOverride } from "./eslint/assistant-leaked-render.mjs";
import { customersBoundaryConfigs } from "./eslint/customers-boundaries.mjs";
import {
  DRAIN_INFINITE_PAGES_ALLOWLIST,
  drainInfinitePagesBoundaryConfig,
  drainInfinitePagesImportRestriction,
} from "./eslint/drain-pages-boundary.mjs";

function withDrainPagesRestriction(config) {
  const [severity, restriction] = config.rules["no-restricted-imports"];
  const patterns = [
    ...(restriction.patterns ?? []),
    ...drainInfinitePagesImportRestriction.patterns,
  ];
  return {
    ...config,
    ignores: DRAIN_INFINITE_PAGES_ALLOWLIST,
    rules: {
      ...config.rules,
      "no-restricted-imports": [
        severity,
        restriction.paths
          ? { patterns, paths: restriction.paths }
          : { patterns },
      ],
    },
  };
}

const customersBoundaryFiles = customersBoundaryConfigs.flatMap(
  (config) => config.files,
);

export default [
  ...showzyEslintConfig({ tsconfigRootDir: import.meta.dirname }),
  ...customersBoundaryConfigs.map(withDrainPagesRestriction),
  {
    ...drainInfinitePagesBoundaryConfig,
    ignores: [
      ...drainInfinitePagesBoundaryConfig.ignores,
      ...customersBoundaryFiles,
    ],
  },
  assistantTsxOverride,
];
