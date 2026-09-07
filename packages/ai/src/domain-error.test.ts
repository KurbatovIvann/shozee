import { describe, expect, it } from "vitest";

import { ORDERS_CREATE_TOOL_NAME } from "./action-tool.js";
import {
  presentCatalogDomainError,
  presentDomainErrorStaffAssistantTurn,
} from "./domain-error.js";

describe("presentCatalogDomainError", () => {
  it("quotes the product and uses locale copy", () => {
    expect(
      presentCatalogDomainError({
        locale: "en",
        extras: {
          reason: "archived",
          subject: { kind: "product_name", name: "Old Widget" },
        },
      }),
    ).toBe(
      '"Old Widget" is archived and cannot be added to an order. Name a different product, or repeat the order without it.',
    );
    expect(
      presentCatalogDomainError({
        locale: "uk",
        extras: {
          reason: "archived",
          subject: { kind: "product_name", name: "Old Widget" },
        },
      }),
    ).toBe(
      "«Old Widget» в архіві, в замовлення його додати не можна. Напиши інший товар або повтори замовлення без нього.",
    );
    expect(
      presentCatalogDomainError({
        locale: "uk",
        extras: {
          reason: "archived",
          subject: { kind: "query", query: "ZzzArchiveTwin" },
        },
      }),
    ).toContain("«ZzzArchiveTwin»");
    expect(
      presentCatalogDomainError({
        locale: "en",
        extras: {
          reason: "no_active_variants",
          subject: { kind: "product_name", name: "Macarons" },
        },
      }),
    ).toContain("Macarons");
  });
});

describe("presentDomainErrorStaffAssistantTurn", () => {
  it("reads the last typed archived / no_active_variants tool error", () => {
    const archived = {
      status: "error" as const,
      code: "CONFLICT",
      message: '"Old Widget" is archived.',
      reason: "archived" as const,
      subject: { kind: "product_name" as const, name: "Old Widget" },
    };
    expect(
      presentDomainErrorStaffAssistantTurn({
        locale: "uk",
        toolResults: [{ toolName: ORDERS_CREATE_TOOL_NAME, output: archived }],
      }),
    ).toBe(
      "«Old Widget» в архіві, в замовлення його додати не можна. Напиши інший товар або повтори замовлення без нього.",
    );
    expect(
      presentDomainErrorStaffAssistantTurn({
        locale: "uk",
        toolResults: [],
      }),
    ).toBeUndefined();
  });
});
