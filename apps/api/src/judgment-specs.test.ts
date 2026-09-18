import { STAFF_JUDGMENT_SPECS, staffAssistantTools } from "@showzy/ai";
import { aiToolSourcesForPrincipal } from "@showzy/contract";
import { asSchema } from "ai";
import { describe, expect, it } from "vitest";

import { createActionRegistry } from "./registry.js";

interface JsonSchema {
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly enum?: readonly unknown[];
  readonly items?: JsonSchema;
}

const contracts = aiToolSourcesForPrincipal(
  createActionRegistry().contracts(),
  "staff",
);
const tools = staffAssistantTools(contracts, () => Promise.resolve({}));

function inputSchemaOf(tool: string): JsonSchema | undefined {
  const entry = tools[tool];
  return entry === undefined
    ? undefined
    : (asSchema(entry.inputSchema).jsonSchema as JsonSchema);
}

describe("staff judgment specs (ADR-0044 decision 4)", () => {
  it("names a real staff tool and the action behind it", () => {
    const actions = new Set(contracts.map((contract) => contract.name));
    const broken = STAFF_JUDGMENT_SPECS.filter(
      (spec) =>
        inputSchemaOf(spec.tool) === undefined || !actions.has(spec.action),
    ).map((spec) => spec.tool);
    expect(broken).toEqual([]);
    expect(new Set(STAFF_JUDGMENT_SPECS.map((spec) => spec.tool)).size).toBe(
      STAFF_JUDGMENT_SPECS.length,
    );
  });

  it("fills only arguments the tool's input schema has", () => {
    const unknown = STAFF_JUDGMENT_SPECS.flatMap((spec) => {
      const properties = inputSchemaOf(spec.tool)?.properties ?? {};
      const itemProperties =
        spec.items === undefined
          ? {}
          : (properties[spec.items.arg]?.items?.properties ?? {});
      return [
        ...Object.keys(spec.args).filter((name) => !(name in properties)),
        ...(spec.items === undefined
          ? []
          : [spec.items.arg].filter((name) => !(name in properties))),
        ...(spec.items === undefined
          ? []
          : [spec.items.product, spec.items.quantity].filter(
              (name) => !(name in itemProperties),
            )),
      ].map((name) => `${spec.tool}.${name}`);
    });
    expect(unknown).toEqual([]);
  });

  it("offers only closed values the tool accepts, apart from the declared unsupported ones", () => {
    const orders = inputSchemaOf("orders_list_counts")?.properties ?? {};
    expect(orders["period"]?.enum).toEqual([
      "today",
      "this_week",
      "this_month",
    ]);
    expect(orders["statuses"]?.items?.enum).toEqual([
      "new",
      "confirmed",
      "in_progress",
      "done",
      "canceled",
    ]);
  });

  it("knows which specs write, from the contract and not from the spec", () => {
    const risk = new Map(
      contracts.map((contract) => [contract.name, contract.risk]),
    );
    const writes = STAFF_JUDGMENT_SPECS.filter(
      (spec) => risk.get(spec.action) !== "read",
    ).map((spec) => spec.tool);
    expect(writes.toSorted()).toEqual([
      "catalog_createProduct",
      "customers_createCustomer",
      "customers_createGroup",
      "orders_create",
      "pricing_createPriceList",
    ]);
  });
});
