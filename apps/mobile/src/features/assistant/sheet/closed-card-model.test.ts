import type {
  AssistantChatTracePart,
  AssistantTraceAttempt,
} from "@showzy/validation/assistant-chat";
import { describe, expect, it } from "vitest";

import {
  assistantClosedCardModel,
  assistantClosedCardModels,
  type AssistantClosedCardCopy,
} from "./closed-card-model";

const INTERACTION = "44444444-4444-4444-8444-444444444444";
const ORDER_ID = "0f0e2d5c-4a1b-4c3d-9e8f-102938475601";
const CUSTOMER_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

const COPY: AssistantClosedCardCopy = {
  closed: {
    done: "Виконано",
    rejected: "Скасовано",
    failed: "Не вдалося",
    open: "Відкрити",
    records: {
      order: "Замовлення",
      customer: "Клієнт",
      customerGroup: "Група",
      counterparty: "Юрособа",
      product: "Товар",
      priceList: "Прайс-лист",
    },
  },
};

function trace(
  overrides: Partial<AssistantChatTracePart>,
): AssistantChatTracePart {
  return {
    kind: "trace",
    interactionId: INTERACTION,
    interactionKind: "confirmation",
    outcome: "done",
    optionId: null,
    attempts: [],
    ...overrides,
  };
}

function attempt(
  action: string,
  recordId: string | null,
  outcome: AssistantTraceAttempt["outcome"] = "done",
): AssistantTraceAttempt {
  return { action, outcome, recordId };
}

describe("assistantClosedCardModel", () => {
  it("maps a done preview to the success pill and one «Відкрити»", () => {
    const model = assistantClosedCardModel({
      trace: trace({ attempts: [attempt("orders.create", ORDER_ID)] }),
      copy: COPY,
    });

    expect(model).toEqual({
      key: INTERACTION,
      outcome: "done",
      label: "Виконано",
      tone: "success",
      opens: [
        {
          key: `${INTERACTION}:0`,
          label: "Відкрити",
          href: `/orders/${ORDER_ID}`,
        },
      ],
    });
  });

  it("maps a rejected preview with nothing to open", () => {
    const model = assistantClosedCardModel({
      trace: trace({ outcome: "rejected" }),
      copy: COPY,
    });

    expect(model?.label).toBe("Скасовано");
    expect(model?.tone).toBe("neutral");
    expect(model?.opens).toEqual([]);
  });

  it("opens what landed on a failed bundle", () => {
    const model = assistantClosedCardModel({
      trace: trace({
        outcome: "failed",
        attempts: [
          attempt("orders.create", ORDER_ID),
          attempt("customers.createCustomer", null, "failed"),
        ],
      }),
      copy: COPY,
    });

    expect(model?.tone).toBe("danger");
    expect(model?.label).toBe("Не вдалося");
    expect(model?.opens).toEqual([
      {
        key: `${INTERACTION}:0`,
        label: "Відкрити",
        href: `/orders/${ORDER_ID}`,
      },
    ]);
  });

  it("names the record when a bundle wrote more than one", () => {
    const model = assistantClosedCardModel({
      trace: trace({
        attempts: [
          attempt("customers.createCustomer", CUSTOMER_ID),
          attempt("orders.create", ORDER_ID),
        ],
      }),
      copy: COPY,
    });

    expect(model?.opens).toEqual([
      {
        key: `${INTERACTION}:0`,
        label: "Відкрити: Клієнт",
        href: `/customers/clients/${CUSTOMER_ID}/edit`,
      },
      {
        key: `${INTERACTION}:1`,
        label: "Відкрити: Замовлення",
        href: `/orders/${ORDER_ID}`,
      },
    ]);
  });

  it("offers no «Відкрити» when the attempt stored no record id", () => {
    const model = assistantClosedCardModel({
      trace: trace({ attempts: [attempt("orders.create", null)] }),
      copy: COPY,
    });

    expect(model?.outcome).toBe("done");
    expect(model?.opens).toEqual([]);
  });

  it("offers no «Відкрити» for an action with no record screen", () => {
    const model = assistantClosedCardModel({
      trace: trace({
        attempts: [attempt("documents.createFromOrder", ORDER_ID)],
      }),
      copy: COPY,
    });

    expect(model?.opens).toEqual([]);
  });

  it("renders no card for a choice or a superseded preview", () => {
    expect(
      assistantClosedCardModel({
        trace: trace({
          interactionKind: "choice",
          outcome: "chosen",
          optionId: "opt-a",
        }),
        copy: COPY,
      }),
    ).toBeNull();
    expect(
      assistantClosedCardModel({
        trace: trace({ outcome: "superseded" }),
        copy: COPY,
      }),
    ).toBeNull();
  });
});

describe("assistantClosedCardModels", () => {
  it("keeps only the traces that have a closed card", () => {
    const models = assistantClosedCardModels(
      [
        trace({ interactionKind: "choice", outcome: "chosen" }),
        trace({ outcome: "rejected" }),
      ],
      COPY,
    );

    expect(models.map((model) => model.outcome)).toEqual(["rejected"]);
  });
});
