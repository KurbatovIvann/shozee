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

const TRACE_KEYS = [
  "attempts",
  "interactionId",
  "interactionKind",
  "kind",
  "optionId",
  "outcome",
];

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
): ConfirmationResolution {
  return {
    approved: true,
    actionName: "customers.updateCustomer",
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

  it("names every record of a bundle that ran through", () => {
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
            { action: "orders.confirm", result: { id: ORDER } },
          ],
        },
      },
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
  it("prefers an explicit id", () => {
    expect(assistantTraceRecordId({ id: ORDER, customerId: CUSTOMER })).toBe(
      ORDER,
    );
  });

  it("guesses nothing from a field that merely ends in Id", () => {
    expect(assistantTraceRecordId({ customerId: CUSTOMER })).toBeNull();
    expect(
      assistantTraceRecordId({ orderId: ORDER, number: "CO-1" }),
    ).toBeNull();
    expect(
      assistantTraceRecordId({ orderId: ORDER, customerId: CUSTOMER }),
    ).toBeNull();
  });

  it("reads nothing out of a result that is not a record", () => {
    expect(assistantTraceRecordId(null)).toBeNull();
    expect(assistantTraceRecordId("ok")).toBeNull();
    expect(assistantTraceRecordId([{ id: ORDER }])).toBeNull();
    expect(assistantTraceRecordId({ deleted: true })).toBeNull();
  });
});
