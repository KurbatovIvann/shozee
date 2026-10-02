/**
 * The CI contract-check stage (core.md §2, fnd-T10 / fnd-G1 A2): walks the
 * API composition root and fails on any registry-wide violation. Define-
 * time and implement-time rules run implicitly — importing the composition
 * executes `defineActionContract` / `implementAction` for everything
 * registered, so a broken definition fails this stage before the walk
 * starts.
 *
 * Run in CI as `pnpm --filter @showzy/api contract:check`.
 */
import {
  deriveRecordProvenanceRequirements,
  PERMISSION_CALL_PREREQUISITES,
  PERMISSION_CATALOG,
  runContractCheck,
  type ActionChannel,
} from "@showzy/core";
import { rolePermissionDefaultRows } from "@showzy/db/seed";
import type { ActionContract } from "@showzy/core/contract";
import type { RecordCreatedVia as DbRecordCreatedVia } from "@showzy/db/schema/tenant-columns";
import {
  ASSISTANT_PREVIEW_LIST_MAX,
  ASSISTANT_PREVIEW_TEXT_MAX,
} from "@showzy/validation/assistant-chat";
import { ASSISTANT_SURFACE_REGISTRY } from "@showzy/validation/assistant-surfaces";
import { CREATE_ORDER_MAX_ITEMS } from "@showzy/validation/orders";
import type { RecordCreatedVia as ValidationRecordCreatedVia } from "@showzy/validation/record-verification";
import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import { buildContractCheckInput } from "./composition.js";

const T1_PROVENANCE_TABLES = [
  "company_customer_invites",
  "company_customers",
  "counterparties",
  "customer_groups",
  "documents",
  "orders",
  "price_lists",
  "product_variants",
  "products",
] as const;

/**
 * SHO-509 / SHO-504 T1: every `staff` + `aiExposure: "exposed"` action
 * must appear here on purpose. A new exposed staff action fails CI until
 * it is added to this list.
 */
const STAFF_EXPOSED_ACTION_ALLOWLIST = [
  "catalog.archiveProduct",
  "catalog.archiveVariant",
  "catalog.createProduct",
  "catalog.createVariant",
  "catalog.getProduct",
  "catalog.listProducts",
  "catalog.restoreProduct",
  "catalog.restoreVariant",
  "catalog.updateProduct",
  "catalog.updateVariant",
  "companies.get",
  "companies.updateLegal",
  "customers.archiveCustomer",
  "customers.createCounterparty",
  "customers.createCustomer",
  "customers.createGroup",
  "customers.deleteCounterparty",
  "customers.deleteCustomer",
  "customers.deleteGroup",
  "customers.getCounterparty",
  "customers.getCustomer",
  "customers.getGroup",
  "customers.listCounterparties",
  "customers.listCustomers",
  "customers.listGroups",
  "customers.restoreCustomer",
  "customers.updateCounterparty",
  "customers.updateCustomer",
  "customers.updateGroup",
  "docGeneration.listLayouts",
  "documents.cancel",
  "documents.createFromOrder",
  "documents.get",
  "documents.list",
  "documents.requestSign",
  "documents.share",
  "invites.create",
  "invites.get",
  "invites.list",
  "invites.revoke",
  "orders.cancel",
  "orders.complete",
  "orders.confirm",
  "orders.create",
  "orders.get",
  "orders.list",
  "orders.start",
  "pricing.activatePriceList",
  "pricing.createPriceList",
  "pricing.deactivatePriceList",
  "pricing.deletePriceList",
  "pricing.getPriceList",
  "pricing.listPriceListEntries",
  "pricing.listPriceLists",
  "pricing.removePriceListEntries",
  "pricing.setDefaultPriceList",
  "pricing.setPriceListEntries",
  "pricing.updatePriceList",
  "search.query",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveJsonPointer(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) {
    return undefined;
  }
  let current: unknown = root;
  for (const segment of ref.slice(2).split("/")) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment.replaceAll("~1", "/").replaceAll("~0", "~")];
  }
  return current;
}

function jsonSchemaRequiresFileId(schema: unknown, root: unknown): boolean {
  if (!isRecord(schema)) {
    return false;
  }
  const ref = schema["$ref"];
  if (typeof ref === "string") {
    return jsonSchemaRequiresFileId(resolveJsonPointer(root, ref), root);
  }
  const required = schema["required"];
  if (
    Array.isArray(required) &&
    required.some((key) => key === "fileId" || key === "fileIds")
  ) {
    return true;
  }
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    const variants = schema[key];
    if (
      Array.isArray(variants) &&
      variants.some((variant) => jsonSchemaRequiresFileId(variant, root))
    ) {
      return true;
    }
  }
  return false;
}

function inputRequiresFileIdOrFileIds(contract: ActionContract): boolean {
  const json = z.toJSONSchema(contract.input);
  return jsonSchemaRequiresFileId(json, json);
}

function staffExposedActionNames(
  contracts: readonly ActionContract[],
): string[] {
  return contracts
    .filter(
      (contract) =>
        contract.principal === "staff" && contract.aiExposure === "exposed",
    )
    .map((contract) => contract.name)
    .toSorted();
}

const PREVIEW_FORMAT_TEXT_MAX: Readonly<Record<string, number>> = {
  date: 10,
  "date-time": 40,
  duration: 40,
  time: 18,
  uuid: 36,
};

const PREVIEW_CARD_FIXED_LINES = 8;

const PREVIEW_DB_ROW_FANOUT_LINES: Readonly<Record<string, number>> = {
  "orders.cancel": CREATE_ORDER_MAX_ITEMS + 1,
  "orders.complete": CREATE_ORDER_MAX_ITEMS + 1,
  "orders.confirm": CREATE_ORDER_MAX_ITEMS + 1,
  "orders.start": CREATE_ORDER_MAX_ITEMS + 1,
};

const PREVIEW_CARD_LINES_PER_INPUT_ITEM: Readonly<Record<string, number>> = {
  "catalog.createProduct": 1,
  "orders.create": 1,
  "pricing.removePriceListEntries": 1,
  "pricing.setPriceListEntries": 1,
};

const PREVIEW_CHANGE_LINE_OVERHEAD = " → ".length;

interface PreviewBound {
  readonly lines: number;
  readonly text: number;
}

function stringTextBound(
  schema: Record<string, unknown>,
  path: string,
  unbounded: string[],
): number {
  const maxLength = schema["maxLength"];
  if (typeof maxLength === "number") {
    return maxLength;
  }
  const values = schema["enum"];
  if (Array.isArray(values) && values.length > 0) {
    return Math.max(...values.map((value) => String(value).length));
  }
  const constant = schema["const"];
  if (typeof constant === "string" || typeof constant === "number") {
    return String(constant).length;
  }
  const format = schema["format"];
  if (typeof format === "string" && format in PREVIEW_FORMAT_TEXT_MAX) {
    return PREVIEW_FORMAT_TEXT_MAX[format] ?? 0;
  }
  unbounded.push(`${path}: string without a max`);
  return 0;
}

function schemaPreviewBound(
  schema: unknown,
  root: unknown,
  path: string,
  unbounded: string[],
  cardLinesPerItem?: number,
): PreviewBound {
  if (!isRecord(schema)) {
    unbounded.push(`${path}: no schema to derive a bound from`);
    return { lines: 1, text: 0 };
  }
  const ref = schema["$ref"];
  if (typeof ref === "string") {
    return schemaPreviewBound(
      resolveJsonPointer(root, ref),
      root,
      path,
      unbounded,
      cardLinesPerItem,
    );
  }
  for (const key of ["oneOf", "anyOf"] as const) {
    const variants = schema[key];
    if (!Array.isArray(variants) || variants.length === 0) {
      continue;
    }
    const bounds = variants.map((variant, index) =>
      schemaPreviewBound(
        variant,
        root,
        `${path}/${key}[${String(index)}]`,
        unbounded,
        cardLinesPerItem,
      ),
    );
    return {
      lines: Math.max(...bounds.map((bound) => bound.lines)),
      text: Math.max(...bounds.map((bound) => bound.text)),
    };
  }
  const allOf = schema["allOf"];
  if (Array.isArray(allOf) && allOf.length > 0) {
    const bounds = allOf.map((member, index) =>
      schemaPreviewBound(
        member,
        root,
        `${path}/allOf[${String(index)}]`,
        unbounded,
        cardLinesPerItem,
      ),
    );
    return {
      lines: bounds.reduce((total, bound) => total + bound.lines, 0),
      text: Math.max(...bounds.map((bound) => bound.text)),
    };
  }
  const type = schema["type"];
  if (type === "array") {
    const maxItems = schema["maxItems"];
    const item = schemaPreviewBound(
      schema["items"],
      root,
      `${path}[]`,
      unbounded,
      cardLinesPerItem,
    );
    const perItem = cardLinesPerItem ?? item.lines;
    if (cardLinesPerItem === undefined) {
      unbounded.push(`${path}: array with no declared card lines per item`);
    }
    if (typeof maxItems !== "number") {
      unbounded.push(`${path}: array without a max`);
      return { lines: perItem, text: item.text };
    }
    return { lines: maxItems * perItem, text: item.text };
  }
  if (type === "object") {
    const properties = schema["properties"];
    if (!isRecord(properties) || Object.keys(properties).length === 0) {
      unbounded.push(`${path}: object without named properties`);
      return { lines: 1, text: 0 };
    }
    let lines = 0;
    let text = 0;
    for (const [name, property] of Object.entries(properties)) {
      const bound = schemaPreviewBound(
        property,
        root,
        `${path}.${name}`,
        unbounded,
        cardLinesPerItem,
      );
      lines += bound.lines;
      text = Math.max(text, bound.text);
    }
    return { lines, text };
  }
  if (type === "string") {
    return { lines: 1, text: stringTextBound(schema, path, unbounded) };
  }
  return { lines: 1, text: 0 };
}

function previewBoundExposedContracts(): readonly ActionContract[] {
  return buildContractCheckInput()
    .registry.implementations()
    .filter(
      (implementation) =>
        implementation.preview !== undefined &&
        implementation.contract.aiExposure === "exposed",
    )
    .map((implementation) => implementation.contract)
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

describe("CI contract-check stage", () => {
  it("the registered surface satisfies every core.md §2 registry rule", () => {
    const result = runContractCheck(buildContractCheckInput());
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("SHO-467: AI-exposed creates derive the nine T1 tables and none violate", () => {
    const input = buildContractCheckInput();
    const required = deriveRecordProvenanceRequirements(
      input.registry.contracts(),
      input.schemaTables,
    );
    const tables = [...new Set(required.map((entry) => entry.table))].sort();
    expect(tables).toEqual([...T1_PROVENANCE_TABLES]);
    expect(
      runContractCheck(input).problems.filter((problem) =>
        problem.includes("provenance"),
      ),
    ).toEqual([]);
  });

  it("SHO-491: ActionChannel, db RecordCreatedVia, and validation RecordCreatedVia match", () => {
    expectTypeOf<ActionChannel>().toEqualTypeOf<DbRecordCreatedVia>();
    expectTypeOf<ActionChannel>().toEqualTypeOf<ValidationRecordCreatedVia>();
    expectTypeOf<DbRecordCreatedVia>().toEqualTypeOf<ValidationRecordCreatedVia>();
  });

  it("SHO-471: every registered assistant surface binding resolves (no hardcoded kinds)", () => {
    const input = buildContractCheckInput();
    expect(input.assistantSurfaces).toEqual(
      ASSISTANT_SURFACE_REGISTRY.map((surface) => ({
        kind: surface.kind,
        actionNames: surface.actionNames,
        toolNames: surface.toolNames,
      })),
    );
    expect(input.assistantSurfaces.length).toBeGreaterThan(0);
    expect(
      runContractCheck(input).problems.filter((problem) =>
        problem.startsWith("assistant surface "),
      ),
    ).toEqual([]);
  });

  it("SHO-509: staff + exposed actions equal the literal allowlist", () => {
    const contracts = buildContractCheckInput().registry.contracts();
    expect([...STAFF_EXPOSED_ACTION_ALLOWLIST]).toEqual(
      [...STAFF_EXPOSED_ACTION_ALLOWLIST].toSorted(),
    );
    expect(staffExposedActionNames(contracts)).toEqual([
      ...STAFF_EXPOSED_ACTION_ALLOWLIST,
    ]);
  });

  it("SHO-509: no files.* action and no required fileId/fileIds input is exposed to staff AI", () => {
    const contracts = buildContractCheckInput().registry.contracts();
    const exposed = staffExposedActionNames(contracts);
    expect(exposed.filter((name) => name.startsWith("files."))).toEqual([]);

    const byName = new Map(
      contracts.map((contract) => [contract.name, contract]),
    );
    const requiringFileId = exposed.filter((name) => {
      const contract = byName.get(name);
      return contract !== undefined && inputRequiresFileIdOrFileIds(contract);
    });
    expect(requiringFileId).toEqual([]);

    expect(exposed).toContain("documents.requestSign");
    expect(exposed).toContain("documents.share");
    expect(exposed).toContain("documents.createFromOrder");

    const setProductImages = byName.get("catalog.setProductImages");
    expect(setProductImages?.aiExposure).toBe("internal");
    expect(setProductImages).toBeDefined();
    if (setProductImages === undefined) {
      return;
    }
    expect(inputRequiresFileIdOrFileIds(setProductImages)).toBe(true);
  });

  /**
   * Same rule as SHO-510 and SHO-521, about the actions that replaced those.
   * The conversation's stored state is read and written on the caller's behalf
   * and must never be reachable as a tool: a model able to write the transcript
   * it is being shown can rewrite what it was told it did.
   */
  it("the stored chat state is internal and not an AI tool", () => {
    const contracts = buildContractCheckInput().registry.contracts();
    const exposed = staffExposedActionNames(contracts);
    for (const [name, risk] of [
      ["assistant.readChatState", "read"],
      ["assistant.writeChatState", "write"],
      ["assistant.readChatMessages", "read"],
      ["assistant.insertChatMessage", "write"],
      ["assistant.updateChatMessage", "write"],
    ] as const) {
      const contract = contracts.find((entry) => entry.name === name);
      expect(contract, name).toBeDefined();
      expect(contract?.transport).toBe("internal");
      expect(contract?.aiExposure).toBe("internal");
      expect(contract?.risk).toBe(risk);
      expect(contract?.principal).toBe("staff");
      expect(exposed).not.toContain(name);
    }
    // And the actions they replaced are gone rather than merely unexposed.
    for (const gone of [
      "assistant.getModelHistory",
      "assistant.checkpointAssistantTurn",
      "assistant.appendUserMessage",
      "assistant.recordAssistantTurn",
      "assistant.getConversation",
    ]) {
      expect(
        contracts.map((entry) => entry.name),
        gone,
      ).not.toContain(gone);
    }
  });

  /**
   * Answering a question is HTTP, not a registry action.
   *
   * Same rule as SHO-522, now about the routes that replaced those: an action
   * would put the interaction protocol into the tool surface the model sees,
   * which is how a model ends up able to answer its own question.
   */
  it("answering and abandoning an interaction are HTTP, not registry actions", () => {
    const contracts = buildContractCheckInput().registry.contracts();
    const names = contracts.map((contract) => contract.name);
    for (const gone of [
      "assistant.confirm",
      "assistant.abandon",
      "assistant.pending",
      "assistant.peekPending",
      "assistant.answer",
    ]) {
      expect(names).not.toContain(gone);
    }
    expect(staffExposedActionNames(contracts)).not.toContain("pending_replace");
    expect(STAFF_EXPOSED_ACTION_ALLOWLIST).not.toContain("pending_replace");

    const kitSrc = readFileSync(
      new URL("./http/assistant-kit.ts", import.meta.url),
      "utf8",
    );
    expect(kitSrc).toContain("ASSISTANT_KIT_ANSWER_PATH");
    expect(kitSrc).toContain("ASSISTANT_KIT_ABANDON_PATH");
    expect(kitSrc).not.toMatch(/implementAction\s*\(/);

    // The stored chat state is the exception, and deliberately so: it is the
    // conversation's own data, and it goes through the module that owns it.
    expect(names).toContain("assistant.readChatState");
    expect(names).toContain("assistant.writeChatState");
    expect(names).toContain("assistant.readChatMessages");
    expect(names).toContain("assistant.insertChatMessage");
    expect(names).toContain("assistant.updateChatMessage");
  });

  it("SHO-527/SHO-534/SHO-535: search.query is staff/client/exposed with companies:view; matcher callees are internal reads; fan-out and prefix edges", () => {
    const input = buildContractCheckInput();
    const contracts = input.registry.contracts();
    const byName = new Map(
      contracts.map((contract) => [contract.name, contract]),
    );

    const query = byName.get("search.query");
    expect(query).toBeDefined();
    expect(query?.principal).toBe("staff");
    expect(query?.transport).toBe("client");
    expect(query?.aiExposure).toBe("exposed");
    expect(query?.risk).toBe("read");
    expect(query?.permissions).toEqual(["companies:view"]);
    expect(query?.timeout).toBe(10_000);
    expect(staffExposedActionNames(contracts)).toContain("search.query");

    const matchers = [
      "customers.searchMatches",
      "catalog.searchMatches",
      "orders.searchMatches",
      "pricing.searchMatches",
      "documents.searchMatches",
    ] as const;
    const permissionByMatcher = {
      "customers.searchMatches": ["customers:view"],
      "catalog.searchMatches": ["products:view"],
      "orders.searchMatches": ["orders:view"],
      "pricing.searchMatches": ["pricing:view"],
      "documents.searchMatches": ["documents:view"],
    } as const;
    for (const name of matchers) {
      const matcher = byName.get(name);
      expect(matcher).toBeDefined();
      expect(matcher?.principal).toBe("staff");
      expect(matcher?.transport).toBe("internal");
      expect(matcher?.aiExposure).toBe("internal");
      expect(matcher?.risk).toBe("read");
      expect(matcher?.permissions).toEqual(permissionByMatcher[name]);
    }

    expect(input.callEdges).toContainEqual({
      caller: "orders.searchMatches",
      callee: "companies.get",
    });
    expect(input.callEdges).toContainEqual({
      caller: "documents.searchMatches",
      callee: "companies.get",
    });
    expect(input.callEdges).toContainEqual({
      caller: "search.query",
      callee: "customers.searchMatches",
      permissionGuarded: true,
    });
    expect(input.callEdges).toContainEqual({
      caller: "search.query",
      callee: "catalog.searchMatches",
      permissionGuarded: true,
    });
    expect(input.callEdges).toContainEqual({
      caller: "search.query",
      callee: "orders.searchMatches",
      permissionGuarded: true,
    });
    expect(input.callEdges).toContainEqual({
      caller: "search.query",
      callee: "pricing.searchMatches",
      permissionGuarded: true,
    });
    expect(input.callEdges).toContainEqual({
      caller: "search.query",
      callee: "documents.searchMatches",
      permissionGuarded: true,
    });
    expect(input.callEdges).not.toContainEqual({
      caller: "search.query",
      callee: "companies.get",
    });
    expect(byName.get("companies.get")?.transport).toBe("client");
    expect(byName.get("companies.get")?.aiExposure).toBe("exposed");
  });

  it("SHO-830: PERMISSION_CATALOG holds exactly the keys the registry and the seed use", () => {
    const declared = buildContractCheckInput()
      .registry.contracts()
      .filter((contract) => contract.principal === "staff")
      .flatMap((contract) => contract.permissions);
    const inUse = [
      ...new Set([
        ...declared,
        ...rolePermissionDefaultRows.map((row) => row.permission),
      ]),
    ].sort();
    expect([...PERMISSION_CATALOG].sort()).toEqual(inUse);
  });

  it("SHO-830: the edge prerequisites are exactly what the declared edges derive", () => {
    const input = buildContractCheckInput();
    const byName = new Map(
      input.registry.contracts().map((contract) => [contract.name, contract]),
    );
    const derived = new Map<string, Set<string>>();
    const addPair = (held: string, needed: string): void => {
      if (held === needed) {
        return;
      }
      const existing = derived.get(held) ?? new Set<string>();
      existing.add(needed);
      derived.set(held, existing);
    };
    const addEdge = (
      caller: ActionContract | undefined,
      callee: ActionContract | undefined,
    ): void => {
      if (
        caller === undefined ||
        callee === undefined ||
        caller.principal !== "staff"
      ) {
        return;
      }
      for (const held of caller.permissions) {
        for (const needed of callee.permissions) {
          addPair(held, needed);
        }
      }
    };
    for (const edge of input.callEdges) {
      if (edge.permissionGuarded === true) {
        continue;
      }
      addEdge(byName.get(edge.caller), byName.get(edge.callee));
    }
    for (const caller of byName.values()) {
      for (const calleeName of caller.atomicCalls) {
        addEdge(caller, byName.get(calleeName));
      }
    }
    const asRows = (map: Map<string, Set<string>>): [string, string[]][] =>
      [...map.entries()]
        .map(([key, values]): [string, string[]] => [key, [...values].sort()])
        .sort(([a], [b]) => a.localeCompare(b));
    expect(asRows(derived)).toEqual(
      asRows(
        new Map(
          Object.entries(PERMISSION_CALL_PREREQUISITES).map(([key, values]) => [
            key,
            new Set(values),
          ]),
        ),
      ),
    );
  });

  it("SHO-830: search.query holds the whole permissionGuarded allowlist", () => {
    const input = buildContractCheckInput();
    const guarded = input.callEdges.filter(
      (edge) => edge.permissionGuarded === true,
    );
    expect(guarded.map((edge) => `${edge.caller} -> ${edge.callee}`)).toEqual([
      "search.query -> customers.searchMatches",
      "search.query -> catalog.searchMatches",
      "search.query -> orders.searchMatches",
      "search.query -> pricing.searchMatches",
      "search.query -> documents.searchMatches",
    ]);
  });

  it("SHO-749: the largest card every preview-bound AI tool can build fits the wire", () => {
    const contracts = previewBoundExposedContracts();
    expect(contracts.length).toBeGreaterThan(0);

    const names = contracts.map((contract) => contract.name);
    const declaredElsewhere = [
      ...Object.keys(PREVIEW_DB_ROW_FANOUT_LINES),
      ...Object.keys(PREVIEW_CARD_LINES_PER_INPUT_ITEM),
    ].filter((name) => !names.includes(name));
    expect(declaredElsewhere).toEqual([]);

    const unbounded: string[] = [];
    const over: string[] = [];
    for (const contract of contracts) {
      const json = z.toJSONSchema(contract.input);
      const bound = schemaPreviewBound(
        json,
        json,
        contract.name,
        unbounded,
        PREVIEW_CARD_LINES_PER_INPUT_ITEM[contract.name],
      );
      const lines =
        bound.lines +
        (PREVIEW_DB_ROW_FANOUT_LINES[contract.name] ?? 0) +
        PREVIEW_CARD_FIXED_LINES;
      const text = bound.text * 2 + PREVIEW_CHANGE_LINE_OVERHEAD;
      if (lines > ASSISTANT_PREVIEW_LIST_MAX) {
        over.push(`${contract.name}: ${String(lines)} lines`);
      }
      if (text > ASSISTANT_PREVIEW_TEXT_MAX) {
        over.push(`${contract.name}: ${String(text)} characters`);
      }
    }

    expect(unbounded).toEqual([]);
    expect(over).toEqual([]);
  });

  it("SHO-824: the walk counts every line an item can add, and names what it cannot bound", () => {
    const sample = {
      type: "object",
      properties: {
        rows: {
          type: "array",
          maxItems: 3,
          items: {
            type: "object",
            properties: {
              name: { type: "string", maxLength: 10 },
              note: { type: "string", maxLength: 40 },
            },
          },
        },
        merged: {
          allOf: [
            { type: "object", properties: { a: { type: "number" } } },
            { type: "object", properties: { b: { type: "number" } } },
          ],
        },
        tags: { type: "object", additionalProperties: { type: "string" } },
      },
    };

    const undeclared: string[] = [];
    expect(schemaPreviewBound(sample, {}, "sample", undeclared)).toEqual({
      lines: 3 * 2 + 2 + 1,
      text: 40,
    });
    expect(undeclared).toEqual([
      "sample.rows: array with no declared card lines per item",
      "sample.tags: object without named properties",
    ]);

    const declared: string[] = [];
    expect(schemaPreviewBound(sample, {}, "sample", declared, 1)).toEqual({
      lines: 3 * 1 + 2 + 1,
      text: 40,
    });
    expect(declared).toEqual(["sample.tags: object without named properties"]);
  });
});
