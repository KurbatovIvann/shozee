/**
 * Panel match merge (SHO-328). Node environment: no DOM, no pathname parser.
 */
// @vitest-environment node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertWalkSkipsLintProbes,
  TRANSIENT_LINT_PROBE_DIR,
} from "@showzy/tooling/lint-probe";
import { describe, expect, it } from "vitest";

import {
  resolvePanelStateFromMatches,
  type PanelMatchInput,
} from "./panel-route-state";
import { sidebarNavSection } from "./panel-section";

const here = dirname(fileURLToPath(import.meta.url));

function match(
  panel?: PanelMatchInput["staticData"]["panel"],
): PanelMatchInput {
  return { staticData: panel === undefined ? {} : { panel } };
}

describe("resolvePanelStateFromMatches", () => {
  it("merges layout section/listTo with the deepest pane", () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly matches: ReadonlyArray<PanelMatchInput>;
      readonly expected: ReturnType<typeof resolvePanelStateFromMatches>;
    }> = [
      {
        name: "company home is orders list",
        matches: [
          match(),
          match({
            panelSection: "orders",
            pane: "list",
            listTo: "/$companySlug/orders",
          }),
        ],
        expected: {
          panelSection: "orders",
          pane: "list",
          listTo: "/$companySlug/orders",
        },
      },
      {
        name: "orders detail keeps the orders list back target",
        matches: [
          match({
            panelSection: "orders",
            pane: "list",
            listTo: "/$companySlug/orders",
          }),
          match({ pane: "detail" }),
        ],
        expected: {
          panelSection: "orders",
          pane: "detail",
          listTo: "/$companySlug/orders",
        },
      },
      {
        name: "document templates list does not fall back to issued documents",
        matches: [
          match({
            panelSection: "documents",
            pane: "list",
            listTo: "/$companySlug/documents",
          }),
          match({
            panelSection: "documents",
            listTo: "/$companySlug/documents/templates",
          }),
        ],
        expected: {
          panelSection: "documents",
          pane: "list",
          listTo: "/$companySlug/documents/templates",
        },
      },
      {
        name: "template detail returns to the templates list",
        matches: [
          match({
            panelSection: "documents",
            pane: "list",
            listTo: "/$companySlug/documents",
          }),
          match({
            panelSection: "documents",
            listTo: "/$companySlug/documents/templates",
          }),
          match({ pane: "detail" }),
        ],
        expected: {
          panelSection: "documents",
          pane: "detail",
          listTo: "/$companySlug/documents/templates",
        },
      },
      {
        name: "customer groups detail returns to groups, not clients",
        matches: [
          match({
            panelSection: "customers",
            pane: "list",
            listTo: "/$companySlug/customers",
          }),
          match({
            panelSection: "customer-groups",
            listTo: "/$companySlug/customers/groups",
          }),
          match({ pane: "detail" }),
        ],
        expected: {
          panelSection: "customer-groups",
          pane: "detail",
          listTo: "/$companySlug/customers/groups",
        },
      },
      {
        name: "company legal is a detail pane with company list back",
        matches: [
          match({
            panelSection: "company",
            pane: "list",
            listTo: "/$companySlug/company",
          }),
          match({ pane: "detail" }),
        ],
        expected: {
          panelSection: "company",
          pane: "detail",
          listTo: "/$companySlug/company",
        },
      },
      {
        name: "full-shell matches without panel staticData",
        matches: [match(), match()],
        expected: undefined,
      },
    ];

    for (const item of cases) {
      expect(resolvePanelStateFromMatches(item.matches), item.name).toEqual(
        item.expected,
      );
    }
  });
});

describe("src walk and transient lint probes (SHO-863)", () => {
  it("never reads a file the boundary suite writes and deletes", () => {
    assertWalkSkipsLintProbes((root) => walkTsFiles(root, []));
  });
});

describe("sidebarNavSection", () => {
  it("collapses customer sub-tabs into the customers row", () => {
    expect(sidebarNavSection("customer-groups")).toBe("customers");
    expect(sidebarNavSection("counterparties")).toBe("customers");
    expect(sidebarNavSection("orders")).toBe("orders");
    expect(sidebarNavSection("documents")).toBe("documents");
  });
});

function walkTsFiles(dir: string, acc: string[]): string[] {
  for (const name of readdirSync(dir)) {
    if (
      name.endsWith(".test.ts") ||
      name.endsWith(".test.tsx") ||
      name === TRANSIENT_LINT_PROBE_DIR
    ) {
      continue;
    }
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walkTsFiles(full, acc);
      continue;
    }
    if (name.endsWith(".ts") || name.endsWith(".tsx")) {
      acc.push(full);
    }
  }
  return acc;
}

describe("production panel routing does not parse pathnames", () => {
  it("has no prefix/regex helpers under layouts/panel or company routes", () => {
    expect(existsSync(join(here, "section-path.ts"))).toBe(false);
    const files = [
      ...walkTsFiles(here, []),
      ...walkTsFiles(join(here, "../../routes/_authed/$companySlug"), []),
    ];
    const banned = [
      "pathname.startsWith",
      "pathname.includes",
      "panelSectionFromPathname",
      "isSectionDetailPath",
      "isFullShellPath",
      "isDocumentsTemplatesPath",
      "listPathForPathname",
    ];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const token of banned) {
        expect(src.includes(token), `${file} contains ${token}`).toBe(false);
      }
    }
  });
});
