import { showzyEslintConfig } from "./eslint/base.mjs";

export default [
  { ignores: ["**/*.d.mts"] },
  ...showzyEslintConfig({ tsconfigRootDir: import.meta.dirname }),
  {
    files: ["ci/**/*.mjs"],
    languageOptions: {
      globals: {
        URL: "readonly",
        console: "readonly",
        process: "readonly",
      },
    },
  },
];
