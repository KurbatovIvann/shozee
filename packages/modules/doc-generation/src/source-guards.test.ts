import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(root, "../../../..");

const FORBIDDEN_CALENDAR =
  /\.getFullYear\s*\(|\.getUTCFullYear\s*\(|extract\s*\(\s*year|date-fns/;

const FORBIDDEN_DEPS = /puppeteer|chromium|playwright|platejs|@plate/;

function readSrc(relative: string): string {
  return readFileSync(join(root, relative), "utf8");
}

function executableSource(relative: string): string {
  return readSrc(relative)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, " ");
}

describe("doc-generation source guards (SHO-236)", () => {
  it("does not recompute issuedOn with Date year APIs or date-fns", () => {
    const sources = [
      "actions/render-pdf.ts",
      "actions/mark-failed.ts",
      "actions/list-layouts.ts",
      "actions/resolve-layout.ts",
      "services/render-pdf.ts",
      "services/mark-failed.ts",
      "services/pdf-retry.ts",
      "services/format-pdf-text.ts",
      "services/layouts.ts",
      "services/amount-in-words.ts",
      "templates/extract-pdf-text.ts",
      "templates/invoice-branded-pdf.tsx",
      "templates/liberation-sans.ts",
      "templates/pdf-faces.ts",
      "templates/render-document.tsx",
      "templates/waybill-parties-pdf.tsx",
    ];
    for (const relative of sources) {
      expect(executableSource(relative), relative).not.toMatch(
        FORBIDDEN_CALENDAR,
      );
    }
  });

  it("imports money formatters only from module-kit (SHO-806)", () => {
    expect(executableSource("services/format-pdf-text.ts")).not.toMatch(
      /money-format/,
    );
    const consumers = [
      "templates/pdf-faces.ts",
      "templates/invoice-branded-pdf.tsx",
      "templates/waybill-parties-pdf.tsx",
    ];
    for (const relative of consumers) {
      const source = executableSource(relative);
      expect(source, relative).toContain(
        'from "@showzy/module-kit/money-format"',
      );
      expect(source, relative).not.toMatch(
        /import\s*\{[^}]*format(MinorUnits|MoneyUah|QuantityMilli)[^}]*\}\s*from\s*"[^"]*format-pdf-text\.js"/,
      );
    }
  });

  it("PUTs generated PDFs with files documentObjectKey, not a local copy", () => {
    const put = executableSource("services/put-generated-pdf.ts");
    expect(put).toContain('from "@showzy/files/storage"');
    expect(put).toMatch(/documentObjectKey/);
    expect(put).not.toMatch(/function\s+documentObjectKey/);
    expect(put).not.toMatch(/\$\{companyId\}\/documents\/\$\{fileId\}/);
  });

  it("pins @react-pdf/renderer exactly and does not add Puppeteer", () => {
    const pkg = JSON.parse(
      readFileSync(join(root, "../package.json"), "utf8"),
    ) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@react-pdf/renderer"]).toBe("4.9.0");
    expect(JSON.stringify(pkg)).not.toMatch(FORBIDDEN_DEPS);
    const lockfile = readFileSync(join(repoRoot, "pnpm-lock.yaml"), "utf8");
    expect(lockfile).toContain("@react-pdf/renderer@4.9.0");
    expect(lockfile.toLowerCase()).not.toContain("puppeteer@");
    expect(
      existsSync(join(root, "templates/fonts/LiberationSans-Regular.ttf")),
    ).toBe(true);
    expect(
      existsSync(join(root, "templates/fonts/LiberationSans-Bold.ttf")),
    ).toBe(true);
    expect(
      existsSync(join(root, "templates/fonts/LiberationSans-Italic.ttf")),
    ).toBe(true);
  });
});
