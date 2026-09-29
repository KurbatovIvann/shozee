import { showzyEslintConfig } from "@showzy/tooling/eslint";

export default [
  { ignores: ["runtime/**", "model/**", "test/conformance-v3/**"] },
  ...showzyEslintConfig({ tsconfigRootDir: import.meta.dirname }),
];
