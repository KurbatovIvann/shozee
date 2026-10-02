import { describe, expect, it } from "vitest";

import {
  assistantCloseTrace,
  assistantRejectedTrace,
  assistantTraceRecordId,
} from "./assistant-close-trace.js";
import type {
  ChoiceResolution,
  ConfirmationAlsoSecret,
  ConfirmationResolution,
} from "./assistant-interactions.js";

const INTERACTION = "11111111-1111-4111-8111-111111111111";
const CUSTOMER = "22222222-2222-4222-8222-222222222222";
const ORDER = "33333333-3333-4333-8333-333333333333";
const PRODUCT = "44444444-4444-4444-8444-444444444444";

const TRACE_KEYS = [
  "attempts",
  "interactionId",
  "interactionKind",
  "kind",
  "optionId",
  "outcome",
];

const DECLARED_RECORD_ID_FIELDS = new Map<string, string>([
  ["orders.create", "orderId"],
  ["orders.confirm", "orderId"],
  ["catalog.createProduct", "productId"],
  ["customers.updateCustomer", "id"],
  ["pricing.createPriceList", "id"],
]);

function writtenRecordIdField(action: string): string | null {
  return DECLARED_RECORD_ID_FIELDS.get(action) ?? null;
}

function alsoAttempt(actionName: string): ConfirmationAlsoSecret {
  return {
    actionName,
    canonicalInput: { orderId: ORDER },
    idempotencyKey: "key-2",
    challengeId: "challenge-2",
    preview: { title: "Підтвердити", lines: [], notes: [] },
    level: "card",
  };
}

function approved(
  also: readonly ConfirmationAlsoSecret[] = [],
  actionName = "customers.updateCustomer",
): ConfirmationResolution {
  return {
    approved: true,
    actionName,
    canonicalInput: { customerId: CUSTOMER },
    idempotencyKey: "key-1",
    challengeId: "challenge-1",
    also,
  };
}

const chosen: ChoiceResolution = {
  entityId: CUSTOMER,
  toolName: "orders_create",
  input: { customerQuery: "дві" },
  target: { kind: "customer", query: "дві" },
};

describe("the trace an approved preview leaves", () => {
  it("names the action and the record it wrote, and nothing else", () => {
    const [trace] = assistantCloseTrace({
      interactionId: INTERACTION,
      kind: "confirmation",
      value: approved(),
      outcome: {
        kind: "ok",
        result: { id: CUSTOMER, name: "Оксана", archived: false },
      },
      writtenRecordIdField,
    });

    expect(trace).toEqual({
      kind: "trace",
      interactionId: INTERACTION,
      interactionKind: "confirmation",
      outcome: "done",
      optionId: null,
      attempts: [
        {
          action: "customers.updateCustomer",
          outcome: "done",
          recordId: CUSTOMER,
        },
      ],
    });
    expect(Object.keys(trace ?? {}).sort()).toEqual(TRACE_KEYS);
  });

  it("names the order an order write wrote, which is never in an `id`", () => {
    const [trace] = assistantCloseTrace({
      interactionId: INTERACTION,
      kind: "confirmation",
      value: approved([], "orders.create"),
      outcome: {
        kind: "ok",
        result: {
          orderId: ORDER,
          orderNumber: "CO-1",
          customer: { id: CUSTOMER, name: "Оксана" },
          status: "draft",
        },
      },
      writtenRecordIdField,
    });

    expect(trace?.attempts).toEqual([
      { action: "orders.create", outcome: "done", recordId: ORDER },
    ]);
  });

  it("names the product a catalog write wrote", () => {
    const [trace] = assistantCloseTrace({
      interactionId: INTERACTION,
      kind: "confirmation",
      value: approved([], "catalog.createProduct"),
      outcome: {
        kind: "ok",
        result: { productId: PRODUCT, name: "Кава", variants: [] },
      },
      writtenRecordIdField,
    });

    expect(trace?.attempts).toEqual([
      { action: "catalog.createProduct", outcome: "done", recordId: PRODUCT },
    ]);
  });

  it("names no record for an action whose contract declares no field", () => {
    const [trace] = assistantCloseTrace({
      interactionId: INTERACTION,
      kind: "confirmation",
      value: approved([], "catalog.setProductImages"),
      outcome: {
        kind: "ok",
        result: { productId: PRODUCT, imageFileIds: [] },
      },
      writtenRecordIdField,
    });

    expect(trace?.attempts).toEqual([
      {
        action: "catalog.setProductImages",
        outcome: "done",
        recordId: null,
      },
    ]);
  });

  it("reports one outcome per attempt when an `also` bundle halted part-way", () => {
    const [trace] = assistantCloseTrace({
      interactionId: INTERACTION,
      kind: "confirmation",
      value: approved([alsoAttempt("orders.confirm")]),
      outcome: {
        kind: "ok",
        result: {
          done: [
            {
              action: "customers.updateCustomer",
              result: { id: CUSTOMER },
            },
          ],
          failed: {
            action: "orders.confirm",
            code: "CONFLICT",
            message: "вже підтверджено",
          },
        },
      },
      writtenRecordIdField,
    });

    expect(trace?.outcome).toBe("failed");
    expect(trace?.attempts).toEqual([
      {
        action: "customers.updateCustomer",
        outcome: "done",
        recordId: CUSTOMER,
      },
      { action: "orders.confirm", outcome: "failed", recordId: null },
    ]);
  });

  it("names every record of a bundle that ran through, each from its own action", () => {
    const [trace] = assistantCloseTrace({
      interactionId: INTERACTION,
      kind: "confirmation",
      value: approved([alsoAttempt("orders.confirm")]),
      outcome: {
        kind: "ok",
        result: {
          done: [
            {
              action: "customers.updateCustomer",
              result: { id: CUSTOMER },
            },
            {
              action: "orders.confirm",
              result: { orderId: ORDER, customerId: CUSTOMER },
            },
          ],
        },
      },
      writtenRecordIdField,
    });

    expect(trace?.outcome).toBe("done");
    expect(trace?.attempts.map((attempt) => attempt.recordId)).toEqual([
      CUSTOMER,
      ORDER,
    ]);
  });

  it("marks the card superseded when drift replaced it with a new one", () => {
    const [trace] = assistantCloseTrace({
      interactionId: INTERACTION,
      kind: "confirmation",
      value: approved(),
      outcome: {
        kind: "pause",
        interaction: "confirmation",
        prompt: { title: "Нова ціна" },
        secret: {},
      },
      writtenRecordIdField,
    });

    expect(trace).toEqual({
      kind: "trace",
      interactionId: INTERACTION,
      interactionKind: "confirmation",
      outcome: "superseded",
      optionId: null,
      attempts: [],
    });
    expect(Object.keys(trace ?? {}).sort()).toEqual(TRACE_KEYS);
  });

  it("leaves no trace when the action refused and the card stayed open", () => {
    expect(
      assistantCloseTrace({
        interactionId: INTERACTION,
        kind: "confirmation",
        value: approved(),
        outcome: { kind: "error", code: "CONFLICT", message: "ні" },
        writtenRecordIdField,
      }),
    ).toEqual([]);
  });
});

describe("the trace a settled choice leaves", () => {
  it("names the option the person chose and no attempt", () => {
    const [trace] = assistantCloseTrace({
      interactionId: INTERACTION,
      kind: "choice",
      value: chosen,
      outcome: { kind: "ok", result: { orderId: ORDER } },
      writtenRecordIdField,
    });

    expect(trace).toEqual({
      kind: "trace",
      interactionId: INTERACTION,
      interactionKind: "choice",
      outcome: "chosen",
      optionId: CUSTOMER,
      attempts: [],
    });
  });

  it("is still a close when the choice uncovered the next question", () => {
    const [trace] = assistantCloseTrace({
      interactionId: INTERACTION,
      kind: "choice",
      value: chosen,
      outcome: {
        kind: "pause",
        interaction: "choice",
        prompt: {},
        secret: {},
      },
      writtenRecordIdField,
    });

    expect(trace?.outcome).toBe("chosen");
  });

  it("leaves no trace for a kind no resolver closes", () => {
    expect(
      assistantCloseTrace({
        interactionId: INTERACTION,
        kind: "retired",
        value: chosen,
        outcome: { kind: "ok", result: {} },
        writtenRecordIdField,
      }),
    ).toEqual([]);
  });
});

describe("the trace a dropped question leaves", () => {
  it("is the interaction, its kind and `rejected`", () => {
    const trace = assistantRejectedTrace({
      interactionId: INTERACTION,
      kind: "confirmation",
    });

    expect(trace).toEqual({
      kind: "trace",
      interactionId: INTERACTION,
      interactionKind: "confirmation",
      outcome: "rejected",
      optionId: null,
      attempts: [],
    });
    expect(Object.keys(trace).sort()).toEqual(TRACE_KEYS);
  });
});

describe("the record id an action result names", () => {
  it("reads the declared field and no other", () => {
    expect(
      assistantTraceRecordId(
        { orderId: ORDER, customerId: CUSTOMER },
        "orderId",
      ),
    ).toBe(ORDER);
    expect(
      assistantTraceRecordId({ orderId: ORDER, customerId: CUSTOMER }, "id"),
    ).toBeNull();
  });

  it("guesses nothing when no field is declared", () => {
    expect(assistantTraceRecordId({ id: ORDER }, null)).toBeNull();
    expect(assistantTraceRecordId({ orderId: ORDER }, null)).toBeNull();
  });

  it("reads nothing out of a result that is not a record", () => {
    expect(assistantTraceRecordId(null, "id")).toBeNull();
    expect(assistantTraceRecordId("ok", "id")).toBeNull();
    expect(assistantTraceRecordId([{ id: ORDER }], "id")).toBeNull();
    expect(assistantTraceRecordId({ deleted: true }, "id")).toBeNull();
  });
});
