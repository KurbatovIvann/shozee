import type {
  AssistantChatTracePart,
  AssistantInteraction,
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
  choiceTitle: "Який варіант?",
  choiceChosen: "Обрано",
};

const CHOICE: AssistantInteraction = {
  kind: "choice",
  interactionId: INTERACTION,
  revision: 2,
  subject: "Катя",
  options: [
    { optionId: "opt-a", label: "Катя Самбука", kind: "record" },
    { optionId: "opt-b", label: "Катя Іванова", kind: "record" },
  ],
  optionsTruncated: false,
  nearest: false,
  problem: undefined,
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
      question: null,
      copy: COPY,
    });

    expect(model).toEqual({
      key: INTERACTION,
      outcome: "done",
      label: "Виконано",
      tone: "success",
      question: null,
      answer: null,
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
      question: null,
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
      question: null,
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
      question: null,
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
      question: null,
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
      question: null,
      copy: COPY,
    });

    expect(model?.opens).toEqual([]);
  });

  it("offers no «Відкрити» for an action named after an inherited key", () => {
    const model = assistantClosedCardModel({
      trace: trace({ attempts: [attempt("constructor", ORDER_ID)] }),
      question: null,
      copy: COPY,
    });

    expect(model?.opens).toEqual([]);
  });

  it("renders no card for a choice out of the window or a superseded preview", () => {
    expect(
      assistantClosedCardModel({
        trace: trace({
          interactionKind: "choice",
          outcome: "chosen",
          optionId: "opt-a",
        }),
        question: null,
        copy: COPY,
      }),
    ).toBeNull();
    expect(
      assistantClosedCardModel({
        trace: trace({ outcome: "superseded" }),
        question: null,
        copy: COPY,
      }),
    ).toBeNull();
  });

  it("keeps an answered choice as the question and the option picked", () => {
    const model = assistantClosedCardModel({
      trace: trace({
        interactionKind: "choice",
        outcome: "chosen",
        optionId: "opt-b",
      }),
      question: CHOICE,
      copy: COPY,
    });

    expect(model).toEqual({
      key: INTERACTION,
      outcome: "chosen",
      label: "Обрано",
      tone: "neutral",
      question: "Катя",
      answer: "Катя Іванова",
      opens: [],
    });
  });

  it("names the question when the option picked is not in the snapshot", () => {
    const model = assistantClosedCardModel({
      trace: trace({
        interactionKind: "choice",
        outcome: "chosen",
        optionId: "opt-gone",
      }),
      question: CHOICE,
      copy: COPY,
    });

    expect(model?.question).toBe("Катя");
    expect(model?.answer).toBeNull();
  });

  it("falls back to the generic title when the question has no subject", () => {
    const model = assistantClosedCardModel({
      trace: trace({
        interactionKind: "choice",
        outcome: "chosen",
        optionId: "opt-a",
      }),
      question: { ...CHOICE, subject: "" },
      copy: COPY,
    });

    expect(model?.question).toBe("Який варіант?");
  });

  it("renders no card for an abandoned choice", () => {
    expect(
      assistantClosedCardModel({
        trace: trace({ interactionKind: "choice", outcome: "rejected" }),
        question: CHOICE,
        copy: COPY,
      }),
    ).toBeNull();
  });
});

describe("assistantClosedCardModels", () => {
  it("keeps only the traces that have a closed card", () => {
    const models = assistantClosedCardModels({
      closures: [
        {
          trace: trace({ interactionKind: "choice", outcome: "superseded" }),
          question: CHOICE,
        },
        { trace: trace({ outcome: "rejected" }), question: null },
      ],
      copy: COPY,
    });

    expect(models.map((model) => model.outcome)).toEqual(["rejected"]);
  });

  it("reads the question the thread paired with each trace", () => {
    const models = assistantClosedCardModels({
      closures: [
        {
          trace: trace({
            interactionKind: "choice",
            outcome: "chosen",
            optionId: "opt-a",
          }),
          question: CHOICE,
        },
      ],
      copy: COPY,
    });

    expect(models.map((model) => model.answer)).toEqual(["Катя Самбука"]);
  });
});
