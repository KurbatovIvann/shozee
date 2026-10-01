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
  CUSTOMERS_RESOLVE_REFERENCE_ACTION_NAME,
  customersGetCustomerFacadeTools,
  customersGetCustomerInputSchema,
} from "./customers-get-customer.js";

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
  errors: ["NOT_FOUND"],
  audit: false,
  timeout: 5_000,
  input: z.strictObject({ id: z.uuid() }),
  output: z.object({ id: z.uuid(), name: z.string() }),
});

const customerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const foreignId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

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
  it("reads the customer by id without resolving a reference", async () => {
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

  it("resolves a unique name query and then reads that customer", async () => {
    const execute = vi.fn((actionName: string) =>
      actionName === CUSTOMERS_RESOLVE_REFERENCE_ACTION_NAME
        ? Promise.resolve({ customerId })
        : Promise.resolve({ id: customerId, name: "Катя Самбука" }),
    );
    const result = await runTool(execute, { customerQuery: "Катя Самбука" });
    expect(execute).toHaveBeenNthCalledWith(
      1,
      CUSTOMERS_RESOLVE_REFERENCE_ACTION_NAME,
      { by: "query", value: "Катя Самбука" },
      { toolCallId: "call-customer" },
    );
    expect(execute).toHaveBeenNthCalledWith(
      2,
      CUSTOMERS_GET_CUSTOMER_ACTION_NAME,
      { id: customerId },
      { toolCallId: "call-customer" },
    );
    expect(result).toEqual({ id: customerId, name: "Катя Самбука" });
  });

  it("resolves a phone query through the same reference action", async () => {
    const execute = vi.fn((actionName: string) =>
      actionName === CUSTOMERS_RESOLVE_REFERENCE_ACTION_NAME
        ? Promise.resolve({ customerId })
        : Promise.resolve({ id: customerId, name: "Катя Самбука" }),
    );
    await runTool(execute, { customerQuery: "+380501234567" });
    expect(execute).toHaveBeenNthCalledWith(
      1,
      CUSTOMERS_RESOLVE_REFERENCE_ACTION_NAME,
      { by: "query", value: "+380501234567" },
      { toolCallId: "call-customer" },
    );
  });

  it("passes several matches through as an answerable customer picker", async () => {
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

  it("turns nothing matched into a picker whose only option is create", async () => {
    const error: unknown = await runTool(
      () => Promise.reject(new NotFoundError()),
      { customerQuery: "Катя" },
    ).catch((thrown: unknown) => thrown);
    const picker = catalogPickerConflictExtrasFromError(error);
    expect(picker).toEqual({
      reason: "unmatched_query",
      target: { kind: "customer", query: "Катя" },
      options: [],
      optionsTruncated: false,
      create: { optionId: CHOICE_CREATE_OPTION_ID, label: 'Create "Катя"' },
    });
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

  it("tells the model a named customer is this tool and a plural is the list", () => {
    const description = customersGetCustomerFacadeTools(getCustomer, () =>
      Promise.resolve({}),
    )[CUSTOMERS_GET_CUSTOMER_TOOL_NAME]?.description;
    expect(description).toContain("means this tool, not the list");
    expect(description).toContain("customers_list_customers");
  });
});
