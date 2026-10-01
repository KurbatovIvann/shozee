import { defineActionContract } from "@showzy/core/contract";
import { ConflictError, NotFoundError } from "@showzy/core/errors";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  CHOICE_CREATE_OPTION_ID,
  catalogPickerConflictExtrasFromError,
} from "../choice.js";
import {
  CUSTOMERS_GET_CUSTOMER_ACTION_NAME,
  CUSTOMERS_GET_CUSTOMER_TOOL_NAME,
  customersGetCustomerFacadeTools,
  customersGetCustomerInputSchema,
} from "./customers-get-customer.js";
import { ENTITY_LOOKUP_RECORD_OPTIONS_MAX } from "./entity-lookup.js";

const getCustomer = defineActionContract({
  name: CUSTOMERS_GET_CUSTOMER_ACTION_NAME,
  description: "Read one CRM customer in the staff member's active company.",
  principal: "staff",
  transport: "client",
  aiExposure: "exposed",
  permissions: ["customers:view"],
  risk: "read",
  requiresConfirmation: false,
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["NOT_FOUND", "CONFLICT"],
  audit: false,
  timeout: 5_000,
  input: z.strictObject({
    id: z.uuid().optional(),
    query: z.string().min(1).optional(),
  }),
  output: z.object({ id: z.uuid(), name: z.string() }),
});

const customerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const foreignId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function nearestOption(index: number): { id: string; label: string } {
  return {
    id: `dddddddd-dddd-4ddd-8ddd-${String(index).padStart(12, "0")}`,
    label: `Катя ${String(index)}`,
  };
}

function unmatched(
  options: readonly { id: string; label: string }[],
): NotFoundError {
  return Object.assign(new NotFoundError('Nothing matches "Катя".'), {
    reason: "unmatched_query",
    target: { kind: "customer", query: "Катя" },
    options,
    optionsTruncated: false,
  });
}

function runTool(
  execute: (
    actionName: string,
    input: unknown,
    options: { readonly toolCallId: string },
  ) => Promise<unknown>,
  input: unknown,
): Promise<unknown> {
  const tool = customersGetCustomerFacadeTools(getCustomer, execute)[
    CUSTOMERS_GET_CUSTOMER_TOOL_NAME
  ];
  const run = tool?.execute;
  if (run === undefined) {
    throw new Error("facade tool has no execute");
  }
  return Promise.resolve(
    run(input, {
      toolCallId: "call-customer",
      messages: [],
      context: undefined,
    }),
  );
}

describe("customersGetCustomerInputSchema", () => {
  it("refuses both references and neither reference", () => {
    expect(
      customersGetCustomerInputSchema.safeParse({
        customerId,
        customerQuery: "Катя",
      }).success,
    ).toBe(false);
    expect(customersGetCustomerInputSchema.safeParse({}).success).toBe(false);
  });
});

describe("customersGetCustomerFacadeTools", () => {
  it("reads the customer by id in one call", async () => {
    const execute = vi.fn(() =>
      Promise.resolve({ id: customerId, name: "Катя Самбука" }),
    );
    const result = await runTool(execute, { customerId });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      CUSTOMERS_GET_CUSTOMER_ACTION_NAME,
      { id: customerId },
      { toolCallId: "call-customer" },
    );
    expect(result).toEqual({ id: customerId, name: "Катя Самбука" });
  });

  it("sends a name query to the owning action in one call", async () => {
    const execute = vi.fn(() =>
      Promise.resolve({ id: customerId, name: "Катя Самбука" }),
    );
    await runTool(execute, { customerQuery: "Катя Самбука" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      CUSTOMERS_GET_CUSTOMER_ACTION_NAME,
      { query: "Катя Самбука" },
      { toolCallId: "call-customer" },
    );
  });

  it("sends a phone query through the same single call", async () => {
    const execute = vi.fn(() =>
      Promise.resolve({ id: customerId, name: "Катя Самбука" }),
    );
    await runTool(execute, { customerQuery: "+380501234567" });
    expect(execute).toHaveBeenCalledWith(
      CUSTOMERS_GET_CUSTOMER_ACTION_NAME,
      { query: "+380501234567" },
      { toolCallId: "call-customer" },
    );
  });

  it("passes the action's several-matches conflict through untouched", async () => {
    const ambiguous = Object.assign(new ConflictError("Which Катя?"), {
      reason: "ambiguous",
      target: { kind: "customer", query: "Катя" },
      options: [
        { id: customerId, label: "Катя Самбука" },
        { id: otherId, label: "Катя Петренко" },
      ],
      optionsTruncated: false,
    });
    await expect(
      runTool(() => Promise.reject(ambiguous), { customerQuery: "Катя" }),
    ).rejects.toBe(ambiguous);
    const picker = catalogPickerConflictExtrasFromError(ambiguous);
    expect(picker?.target).toEqual({ kind: "customer", query: "Катя" });
    expect(picker?.options).toHaveLength(2);
    expect(picker?.create).toBeUndefined();
  });

  it("offers the action's nearest customers plus create when nothing matched", async () => {
    const nearest = [nearestOption(1), nearestOption(2)];
    const error: unknown = await runTool(
      () => Promise.reject(unmatched(nearest)),
      { customerQuery: "Катя" },
    ).catch((thrown: unknown) => thrown);
    const picker = catalogPickerConflictExtrasFromError(error);
    expect(picker).toEqual({
      reason: "unmatched_query",
      target: { kind: "customer", query: "Катя" },
      options: nearest,
      optionsTruncated: false,
      create: { optionId: CHOICE_CREATE_OPTION_ID },
    });
  });

  it("offers only create when the action found nothing near", async () => {
    const error: unknown = await runTool(() => Promise.reject(unmatched([])), {
      customerQuery: "Катя",
    }).catch((thrown: unknown) => thrown);
    const picker = catalogPickerConflictExtrasFromError(error);
    expect(picker?.options).toEqual([]);
    expect(picker?.create?.optionId).toBe(CHOICE_CREATE_OPTION_ID);
  });

  it("leaves room for the create option when the nearest list fills the card", async () => {
    const nearest = Array.from({ length: 20 }, (_, index) =>
      nearestOption(index),
    );
    const error: unknown = await runTool(
      () => Promise.reject(unmatched(nearest)),
      { customerQuery: "Катя" },
    ).catch((thrown: unknown) => thrown);
    const picker = catalogPickerConflictExtrasFromError(error);
    expect(picker?.options).toHaveLength(ENTITY_LOOKUP_RECORD_OPTIONS_MAX);
    expect(picker?.optionsTruncated).toBe(true);
    expect(picker?.create).toBeDefined();
  });

  it("refuses a customer id from another company with not found", async () => {
    const execute = vi.fn(() => Promise.reject(new NotFoundError()));
    await expect(runTool(execute, { customerId: foreignId })).rejects.toThrow(
      NotFoundError,
    );
    expect(execute).toHaveBeenCalledWith(
      CUSTOMERS_GET_CUSTOMER_ACTION_NAME,
      { id: foreignId },
      { toolCallId: "call-customer" },
    );
  });

  it("keeps a plain not-found plain", async () => {
    const plain = new NotFoundError();
    await expect(
      runTool(() => Promise.reject(plain), { customerQuery: "Катя" }),
    ).rejects.toBe(plain);
  });

  it("tells the model a named customer is this tool and a plural is the list", () => {
    const description = customersGetCustomerFacadeTools(getCustomer, () =>
      Promise.resolve({}),
    )[CUSTOMERS_GET_CUSTOMER_TOOL_NAME]?.description;
    expect(description).toContain("means this tool, not the list");
    expect(description).toContain("customers_list_customers");
  });
});
