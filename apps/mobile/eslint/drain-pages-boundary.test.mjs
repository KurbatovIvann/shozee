import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint, Linter } from "eslint";
import { describe, expect, it } from "vitest";

import {
  DRAIN_INFINITE_PAGES_ALLOWLIST,
  drainInfinitePagesImportRestriction,
} from "./drain-pages-boundary.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const mobileRoot = join(here, "..");
const srcRoot = join(mobileRoot, "src");
const configPath = join(mobileRoot, "eslint.config.mjs");

function lintImport(specifier) {
  const linter = new Linter({ configType: "flat" });
  return linter.verify(`import { x } from "${specifier}";`, {
    languageOptions: { sourceType: "module", ecmaVersion: 2022 },
    rules: {
      "no-restricted-imports": ["error", drainInfinitePagesImportRestriction],
    },
  });
}

function restricted(messages) {
  return messages.filter(
    (message) => message.ruleId === "no-restricted-imports",
  );
}

async function restrictedForRealConfig(relativeFilePath, code) {
  const eslint = new ESLint({
    overrideConfigFile: configPath,
    cwd: mobileRoot,
  });
  const filePath = join(mobileRoot, relativeFilePath);
  const config = await eslint.calculateConfigForFile(filePath);
  const ruleConfig = config.rules["no-restricted-imports"];
  if (!ruleConfig) {
    return [];
  }
  const linter = new Linter({ configType: "flat" });
  const result = linter.verify(code, {
    languageOptions: { sourceType: "module", ecmaVersion: 2022 },
    rules: { "no-restricted-imports": ruleConfig },
  });
  return restricted(result);
}

function collectSourceFiles(dir) {
  const entries = readdirSync(dir);
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...collectSourceFiles(full));
      continue;
    }
    if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      files.push(full);
    }
  }
  return files;
}

function callsUseDrainInfinitePages(filePath) {
  if (filePath.endsWith(join("hooks", "use-drain-pages.ts"))) {
    return false;
  }
  const content = readFileSync(filePath, "utf8");
  return content.includes("useDrainInfinitePages(");
}

describe("useDrainInfinitePages allowlist (SHO-596)", () => {
  it("flags a new call site regardless of relative depth", () => {
    expect(
      restricted(lintImport("../../../hooks/use-drain-pages")),
    ).toHaveLength(1);
    expect(restricted(lintImport("../../hooks/use-drain-pages"))).toHaveLength(
      1,
    );
  });

  it("does not flag unrelated hooks", () => {
    expect(
      restricted(lintImport("../../../hooks/use-debounced-value")),
    ).toHaveLength(0);
  });

  it("pins the allowlist to the known bounded reference sets", () => {
    expect(DRAIN_INFINITE_PAGES_ALLOWLIST).toEqual([
      "src/features/customers/form/use-customer-form-lookups.ts",
      "src/features/customers/list/use-customer-lookups.ts",
      "src/features/customers/groups/use-group-form-lookups.ts",
      "src/features/customers/form/use-customer-linked-counterparties.ts",
      "src/features/documents/form/use-document-form-lookups.ts",
    ]);
  });

  it("matches the allowlist to exactly the real callers", () => {
    const callers = collectSourceFiles(srcRoot)
      .filter(callsUseDrainInfinitePages)
      .map((filePath) => relative(mobileRoot, filePath).replace(/\\/g, "/"))
      .sort();

    expect(callers).toEqual([...DRAIN_INFINITE_PAGES_ALLOWLIST].sort());
  });
});

describe("drain-pages boundary composed with customers boundaries (SHO-596)", () => {
  it("flags a new non-customers caller through the real config", async () => {
    const messages = await restrictedForRealConfig(
      "src/features/documents/list/new-caller.ts",
      'import { useDrainInfinitePages } from "../../../hooks/use-drain-pages";\n',
    );
    expect(messages).toHaveLength(1);
  });

  it("flags a new customers caller through the real config", async () => {
    const messages = await restrictedForRealConfig(
      "src/features/customers/form/new-caller.ts",
      'import { useDrainInfinitePages } from "../../../hooks/use-drain-pages";\n',
    );
    expect(messages).toHaveLength(1);
  });

  it("still enforces the customers subdomain boundary on the same file", async () => {
    const messages = await restrictedForRealConfig(
      "src/features/customers/form/new-caller.ts",
      'import { CustomerRow } from "../list/customer-row";\n',
    );
    expect(messages).toHaveLength(1);
  });

  it("does not flag an allowlisted customers caller", async () => {
    const messages = await restrictedForRealConfig(
      DRAIN_INFINITE_PAGES_ALLOWLIST[0],
      'import { useDrainInfinitePages } from "../../../hooks/use-drain-pages";\n',
    );
    expect(messages).toHaveLength(0);
  });
});
