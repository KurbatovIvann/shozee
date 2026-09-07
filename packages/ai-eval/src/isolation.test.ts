import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function walkTestFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTestFiles(full));
      continue;
    }
    if (entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

function walkTypeScriptFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTypeScriptFiles(full));
      continue;
    }
    if (entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("unit suite isolation (SHO-412)", () => {
  it("does not import the live sandbox or eval entry", () => {
    const root = path.dirname(fileURLToPath(import.meta.url));
    const files = walkTestFiles(root);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/from ["'][^"']*sandbox\.js["']/);
      expect(source, file).not.toMatch(/eval\/live/);
      expect(source, file).not.toMatch(/\bcreateEvalSandbox\s*\(/);
    }
  });

  it("keeps createEvalSandbox in the live entry only", () => {
    const root = path.dirname(fileURLToPath(import.meta.url));
    const allowed = new Set(["sandbox.ts", path.join("eval", "live.eval.ts")]);
    for (const file of walkTypeScriptFiles(root)) {
      const relative = path.relative(root, file);
      if (relative === "isolation.test.ts" || allowed.has(relative)) {
        continue;
      }
      const source = readFileSync(file, "utf8");
      expect(source, relative).not.toMatch(/\bcreateEvalSandbox\b/);
    }
  });

  it("does not read ANTHROPIC_API_KEY from process.env", () => {
    const root = path.dirname(fileURLToPath(import.meta.url));
    for (const file of walkTypeScriptFiles(root)) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/process\.env\.ANTHROPIC_API_KEY/);
      expect(source, file).not.toMatch(
        /process\.env\[["']ANTHROPIC_API_KEY["']\]/,
      );
    }
  });

  it("does not enable Vitest retry", () => {
    const packageRoot = path.dirname(
      path.dirname(fileURLToPath(import.meta.url)),
    );
    for (const name of ["vitest.config.ts", "vitest.eval.config.ts"]) {
      const source = readFileSync(path.join(packageRoot, name), "utf8");
      expect(source, name).not.toMatch(/\bretry\s*:/);
    }
  });

  it("only the live entry reads SHOWZY_EVAL_RUNS", () => {
    const root = path.dirname(fileURLToPath(import.meta.url));
    for (const file of walkTypeScriptFiles(root)) {
      const relative = path.relative(root, file);
      if (
        relative === "isolation.test.ts" ||
        relative === path.join("eval", "live.eval.ts")
      ) {
        continue;
      }
      const source = readFileSync(file, "utf8");
      expect(source, relative).not.toContain("SHOWZY_EVAL_RUNS");
    }
  });

  it("launches live eval through eval-cli.mjs without reading the API key", () => {
    const packageRoot = path.dirname(
      path.dirname(fileURLToPath(import.meta.url)),
    );
    const cli = readFileSync(path.join(packageRoot, "eval-cli.mjs"), "utf8");
    const manifest = JSON.parse(
      readFileSync(path.join(packageRoot, "package.json"), "utf8"),
    ) as { scripts?: { eval?: string } };
    expect(manifest.scripts?.eval).toBe("node ./eval-cli.mjs");
    expect(cli).toContain("SHOWZY_EVAL_RUNS");
    expect(cli).toContain("vitest.eval.config.ts");
    expect(cli).toContain("process.execPath");
    expect(cli).toContain("vitest.mjs");
    expect(cli).not.toMatch(/spawn\(\s*"pnpm"/);
    expect(cli).not.toContain("ANTHROPIC_API_KEY");
    expect(cli).not.toMatch(/vitest", "run".*--runs/);
  });
});
