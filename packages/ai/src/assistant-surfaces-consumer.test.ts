/// <reference types="node" />
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ASSISTANT_SURFACE_REGISTRY,
  ORDER_ENTITY_PROMPT_LINE,
  ORDERS_AGGREGATE_PROMPT_LINE,
  ORDERS_LIST_COUNTS_TOOL,
  ORDERS_LIST_PAGE_TOOL,
  ORDERS_LIST_PROMPT_LINE,
  assistantSurfacesFromToolResults,
  type AssistantSurfaceData,
  type AssistantSurfaceToolResult,
} from "@showzy/validation/assistant-surfaces";
import { describe, expect, it } from "vitest";

import { presentCompletedStaffAssistantTurn } from "./presenter.js";
import { staffAssistantSystemPrompt } from "./system-prompt.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const aiSrc = here;
const validationSurfaces = join(
  repoRoot,
  "packages/validation/src/assistant-surfaces",
);

const ORDER_A = "11111111-1111-4111-8111-111111111111";
const ORDER_B = "22222222-2222-4222-8222-222222222222";

/** Byte-identical `<presentation>` block from before SHO-457. */
const PRE_CHANGE_PRESENTATION_BLOCK = `<presentation>
The staff UI already renders registered result surfaces from tool JSON. Do not emit card JSON, view-models, kind discriminators, or row arrays. Do not name those surfaces "cards" to the staff member. Reply with a short product-language summary (count, period, notable status). Do not restate rows as a table, markdown grid, or long bullet dump. No **, |, headings, or code fences.

After orders_list_page (chips from same-turn orders_list_counts), the UI already shows the orders list card. Reply with a short product-language summary. Do not dump a markdown table of the rows.
After orders_list_counts with no page on the same turn, the UI already shows the orders aggregate card with period, totals, and a status breakdown. Reply with a short product-language summary of the totals. Do not dump a markdown table of buckets. Do not call orders_list_counts or orders.list again for the card.
After orders.get or orders.create, the UI already shows an order entity card. Reply with a short product-language summary. Do not dump tool JSON.
</presentation>`;

const PRESENTER_OWNED_COPY = [
  "No orders.",
  "Latest orders",
  "There are more orders.",
  "Deleted customer",
  "Немає замовлень.",
  "Останні замовлення",
  "Є ще замовлення.",
  "Клієнт видалений",
  "не має активних варіантів",
  "в архіві, в замовлення",
  "More variants exist. Reply with the exact flavour name.",
  "Є ще варіанти. Напишіть точну назву смаку.",
];

const PARSE_HELPERS_REMOVED_FROM_PRESENTER = [
  "function isRecord",
  "function isTypedToolError",
  "function isSuccessfulToolOutput",
  "function unwrapToolOutput",
  "function pageRows",
  "function pageHasMore",
  "function lastSuccessfulIndex",
  "function customerNameFromPayload",
];

const PROMPT_LINE_CONSTANTS = [
  "ORDERS_LIST_PROMPT_LINE",
  "ORDERS_AGGREGATE_PROMPT_LINE",
  "ORDER_ENTITY_PROMPT_LINE",
] as const;

const SKIP_DIR = new Set([
  "node_modules",
  ".git",
  "dist",
  ".turbo",
  "coverage",
  ".next",
]);

function walkTs(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIP_DIR.has(entry.name)) {
      continue;
    }
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTs(full));
      continue;
    }
    if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
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

function presentationBlock(prompt: string): string {
  const start = prompt.indexOf("<presentation>");
  const end = prompt.indexOf("</presentation>");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return prompt.slice(start, end + "</presentation>".length);
}

function listOf(
  surfaces: readonly AssistantSurfaceData[],
): AssistantSurfaceData | null {
  for (const surface of surfaces) {
    if (surface.kind === "orders-list") {
      return surface;
    }
  }
  return null;
}

function aggregateOf(
  surfaces: readonly AssistantSurfaceData[],
): AssistantSurfaceData | null {
  for (const surface of surfaces) {
    if (surface.kind === "orders-aggregate") {
      return surface;
    }
  }
  return null;
}

describe("staff assistant presentation cache prefix (SHO-457)", () => {
  it("keeps the <presentation> block byte-identical to the pre-change string", () => {
    expect(presentationBlock(staffAssistantSystemPrompt)).toBe(
      PRE_CHANGE_PRESENTATION_BLOCK,
    );
    expect(ASSISTANT_SURFACE_REGISTRY.map((entry) => entry.promptLine)).toEqual(
      [
        ORDERS_LIST_PROMPT_LINE,
        ORDERS_AGGREGATE_PROMPT_LINE,
        ORDER_ENTITY_PROMPT_LINE,
      ],
    );
  });
});

describe("promptLine definitions (SHO-457)", () => {
  it("has exactly one assignment per promptLine constant in the repo", () => {
    const files = [
      ...walkTs(join(repoRoot, "packages")),
      ...walkTs(join(repoRoot, "apps")),
    ];
    for (const name of PROMPT_LINE_CONSTANTS) {
      const assignment = new RegExp(`export const ${name}\\s*=`);
      const matches = files.filter((path) =>
        assignment.test(readFileSync(path, "utf8")),
      );
      expect(matches, name).toHaveLength(1);
      expect(
        matches[0]?.includes(
          join("packages", "validation", "src", "assistant-surfaces") + sep,
        ),
      ).toBe(true);
    }
    const spokenReply = readFileSync(join(aiSrc, "spoken-reply.ts"), "utf8");
    for (const name of PROMPT_LINE_CONSTANTS) {
      expect(spokenReply).not.toMatch(new RegExp(`export const ${name}\\s*=`));
    }
  });
});

describe("cross-consumer surface agreement (SHO-457)", () => {
  const listPage = {
    kind: "page.summary" as const,
    requestedLimit: 2,
    rows: [
      {
        orderId: ORDER_A,
        orderNumber: "1049",
        status: "new",
        customer: { nameSnapshot: "Albina", linkedCustomerId: ORDER_A },
      },
      {
        orderId: ORDER_B,
        orderNumber: "1050",
        status: "confirmed",
        customer: { nameSnapshot: "Ivan", linkedCustomerId: ORDER_B },
      },
    ],
    hasMore: false,
    nextCursor: null,
    customerMatchTruncated: false,
  };

  const counts = {
    kind: "aggregate" as const,
    orderCount: 6,
    grossByCurrency: [],
    buckets: [
      {
        identity: { kind: "status" as const, status: "confirmed" },
        orderCount: 4,
      },
      { identity: { kind: "status" as const, status: "new" }, orderCount: 2 },
    ],
    statusBuckets: [
      {
        identity: { kind: "status" as const, status: "confirmed" },
        orderCount: 4,
      },
      { identity: { kind: "status" as const, status: "new" }, orderCount: 2 },
    ],
  };

  const entity = {
    orderId: ORDER_A,
    orderNumber: "1049",
    status: "new" as const,
    customer: { nameSnapshot: "Albina" },
  };

  it("agrees with the shared compose on list kind and underlying row data", () => {
    const results: AssistantSurfaceToolResult[] = [
      { toolName: ORDERS_LIST_PAGE_TOOL, output: listPage },
      { toolName: ORDERS_LIST_COUNTS_TOOL, output: counts },
    ];
    const surfaces = assistantSurfacesFromToolResults(results);
    const list = listOf(surfaces);
    expect(surfaces.map((surface) => surface.kind)).toEqual(["orders-list"]);
    expect(aggregateOf(surfaces)).toBeNull();
    expect(list?.kind).toBe("orders-list");
    if (list?.kind !== "orders-list") {
      throw new Error("expected orders-list");
    }
    expect(list.rows.map((row) => row.orderId)).toEqual([ORDER_A, ORDER_B]);
    expect(list.rows.map((row) => row.orderNumber)).toEqual(["1049", "1050"]);
    expect(list.rows.map((row) => row.status)).toEqual(["new", "confirmed"]);
    expect(list.hasMore).toBe(false);
    expect(list.customerMatchTruncated).toBe(false);
    expect(
      presentCompletedStaffAssistantTurn({
        locale: "en",
        toolResults: results,
      }),
    ).toBe("Latest orders: #1049 (New), #1050 (Confirmed).");
  });

  it("agrees with the shared compose on counts-only aggregate kind and status data", () => {
    const results: AssistantSurfaceToolResult[] = [
      { toolName: ORDERS_LIST_COUNTS_TOOL, output: counts },
    ];
    const surfaces = assistantSurfacesFromToolResults(results);
    const aggregate = aggregateOf(surfaces);
    expect(listOf(surfaces)).toBeNull();
    expect(aggregate?.kind).toBe("orders-aggregate");
    if (aggregate?.kind !== "orders-aggregate") {
      throw new Error("expected orders-aggregate");
    }
    expect(aggregate.orderCount).toBe(6);
    expect(aggregate.statusBuckets.map((bucket) => bucket.status)).toEqual([
      "confirmed",
      "new",
    ]);
    expect(aggregate.statusBuckets.map((bucket) => bucket.orderCount)).toEqual([
      4, 2,
    ]);
    expect(
      presentCompletedStaffAssistantTurn({
        locale: "en",
        toolResults: results,
      }),
    ).toBe("6 orders. New · 2, Confirmed · 4.");
  });

  it("agrees with the shared compose on entity kind and order fields", () => {
    const results: AssistantSurfaceToolResult[] = [
      { toolName: "orders_get", output: entity },
    ];
    const surfaces = assistantSurfacesFromToolResults(results);
    expect(surfaces.map((surface) => surface.kind)).toEqual(["order-entity"]);
    const first = surfaces[0];
    expect(first?.kind).toBe("order-entity");
    if (first?.kind !== "order-entity") {
      throw new Error("expected order-entity");
    }
    expect(first.orderId).toBe(ORDER_A);
    expect(first.orderNumber).toBe("1049");
    expect(first.status).toBe("new");
    expect(first.customerNameSnapshot).toBe("Albina");
    expect(
      presentCompletedStaffAssistantTurn({
        locale: "en",
        toolResults: results,
      }),
    ).toBe("Order #1049, Albina, New.");
  });
});

describe("packages/ai owns localized copy (SHO-457)", () => {
  it("does not move presenter uk/en sentences into packages/validation", () => {
    const files = walkTs(validationSurfaces).filter(
      (path) => !path.endsWith(".test.ts"),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const path of files) {
      const stripped = stripComments(readFileSync(path, "utf8"));
      for (const copy of PRESENTER_OWNED_COPY) {
        expect(stripped.includes(copy), `${path} copy ${copy}`).toBe(false);
      }
    }
  });

  it("does not keep the retired parse helpers in presenter.ts", () => {
    const presenter = readFileSync(join(aiSrc, "presenter.ts"), "utf8");
    expect(presenter).toContain("@showzy/validation/assistant-surfaces");
    expect(presenter).toContain("assistantSurfacesFromToolResults");
    for (const helper of PARSE_HELPERS_REMOVED_FROM_PRESENTER) {
      expect(presenter.includes(helper), helper).toBe(false);
    }
    expect(presenter).not.toMatch(/from ["']apps\/mobile/);
  });
});
