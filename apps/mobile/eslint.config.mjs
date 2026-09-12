import { showzyEslintConfig } from "@showzy/tooling/eslint";

import { assistantTsxOverride } from "./eslint/assistant-leaked-render.mjs";
import { customersBoundaryConfigs } from "./eslint/customers-boundaries.mjs";
import { drainInfinitePagesBoundaryConfig } from "./eslint/drain-pages-boundary.mjs";

export default [
  ...showzyEslintConfig({ tsconfigRootDir: import.meta.dirname }),
  ...customersBoundaryConfigs,
  drainInfinitePagesBoundaryConfig,
  assistantTsxOverride,
];
