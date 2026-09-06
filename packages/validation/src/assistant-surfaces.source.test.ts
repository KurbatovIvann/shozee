/// <reference types="node" />
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));
const surfacesDir = join(root, "assistant-surfaces");
const repoRoot = join(root, "../../..");

const FORBIDDEN_IMPORTS = [
  "react",
  "react-native",
  "i18n",
  "@showzy/ai",
  "ai",
  "@ai-sdk/",
];

const USER_VISIBLE_COPY = [
  "No orders",
  "Open orders",
  "This month",
  "This week",
  "Today",
  "How can I help",
];

const CYRILLIC = /[А-Яа-яІіЇїЄєҐґ]/;
const IMPORT_FROM = /(?:from|import)\s+["']([^"']+)["']/g;
const EXPORTED_FIELD =
  /(?:export\s+type\s+\w+\s*=\s*\{[^}]*?|\s+)readonly\s+(state|type|data)\s*[?:]/s;

function walkTs(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.endsWith(".test.ts")) {
      continue;
    }
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTs(full));
      continue;
    }
    if (entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("@showzy/validation/assistant-surfaces guards", () => {
  const files = walkTs(surfacesDir);
  const sources = files.map((path) => ({
    path,
    text: readFileSync(path, "utf8"),
  }));

  it("imports only relative files inside the subpath (zod-only leaf)", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const file of sources) {
      const specifiers = [...file.text.matchAll(IMPORT_FROM)].map(
        (match) => match[1] ?? "",
      );
      for (const spec of specifiers) {
        expect(spec === "zod" || spec.startsWith("./"), file.path).toBe(true);
        expect(spec.startsWith("../"), file.path).toBe(false);
        for (const forbidden of FORBIDDEN_IMPORTS) {
          expect(spec.includes(forbidden), `${file.path} → ${spec}`).toBe(
            false,
          );
        }
        expect(spec.startsWith("apps/"), file.path).toBe(false);
        expect(spec.startsWith("../../"), file.path).toBe(false);
      }
    }
  });

  it("exports no type that carries state, type, or data fields", () => {
    for (const file of sources) {
      expect(EXPORTED_FIELD.test(file.text), file.path).toBe(false);
      expect(file.text).not.toMatch(/\breadonly state\s*:/);
      expect(file.text).not.toMatch(/\breadonly type\s*:/);
      expect(file.text).not.toMatch(/\breadonly data\s*:/);
    }
  });

  it("does not land user-visible copy in the subpath", () => {
    for (const file of sources) {
      const stripped = stripComments(file.text);
      expect(CYRILLIC.test(stripped), file.path).toBe(false);
      for (const copy of USER_VISIBLE_COPY) {
        expect(stripped.includes(copy), `${file.path} copy ${copy}`).toBe(
          false,
        );
      }
    }
  });

  it("exports unrestorableAssistantActionNames with a production caller (SHO-461)", () => {
    const index = readFileSync(join(surfacesDir, "index.ts"), "utf8");
    const registry = readFileSync(join(surfacesDir, "registry.ts"), "utf8");
    const hydrate = readFileSync(
      join(
        repoRoot,
        "apps/mobile/src/features/assistant/shared/assistant-hydrate.ts",
      ),
      "utf8",
    );
    expect(index).toContain("unrestorableAssistantActionNames");
    expect(index).not.toContain("unrestorableAssistantListAction");
    expect(registry).not.toContain("unrestorableAssistantListAction");
    expect(hydrate).toContain("unrestorableAssistantActionNames");
    expect(hydrate).toContain("hydratableAssistantActionNames");
    expect(hydrate).not.toContain("unrestorableAssistantListAction");
  });

  it("is the clipped-status source for packages/ai clip-tool-result", () => {
    const clip = readFileSync(
      join(repoRoot, "packages/ai/src/clip-tool-result.ts"),
      "utf8",
    );
    expect(clip).toContain("@showzy/validation/assistant-surfaces");
    expect(clip).toContain("ASSISTANT_TOOL_CLIPPED_STATUS");
  });
});
