import {
  shoCommandSchema,
  shoResultSchema,
  type ShoCommand,
  type ShoFocusEntry,
  type ShoResult,
} from "@showzy/sho-protocol";
import { describe, expect, it } from "vitest";

import { shoFocusHolds } from "../sho-focus.js";
import { createShoPlanner, type ShoActionPlan } from "../sho-plan.js";

import { shoDocumentWriteParse } from "./__tests__/document-write-parses.js";
import { shoOrderWriteParse } from "./__tests__/order-write-parses.js";
import { SHO_CUSTOMER_WRITE_ACTIONS } from "./customers-writes.js";
import {
  SHO_CANCEL_DOCUMENT,
  SHO_CREATE_DOCUMENT,
  SHO_DOCUMENT_WRITE_ACTIONS,
  SHO_DOCUMENT_WRITE_PLANNERS,
  SHO_DOCUMENT_WRITE_PLANNER_PARAMS,
  SHO_REQUEST_SIGN_DOCUMENT,
  SHO_SHARE_DOCUMENT,
} from "./documents-writes.js";
import { SHO_ORDER_LIFECYCLE_ACTIONS } from "./orders-lifecycle.js";
import { SHO_WRITE_ACTIONS } from "./orders-writes.js";
import { SHO_READ_ACTIONS } from "./reads.js";

const NOW = new Date("2026-09-27T07:00:00.000Z");

const OVER_THE_FLOOR = {
  action: 0.99,
  margin: 0.8,
  certainty: 0.9,
  spans: 0.9,
};

const OUR_ORDER = "2b7c6e14-9a05-4f31-8d62-70c4e5a1b398";

const OUR_DOCUMENT = "7d1e4a90-3c62-4f08-9b55-61ea2d7c4083";

const ANOTHER_COMPANYS_DOCUMENT = "c51f0a82-4d37-4b96-a7e0-18d3925c6f4a";

const OUR_COUNTERPARTY = "1f90d4b7-28ae-4c63-9d10-5b7e3a84c206";

type Json = Record<string, unknown>;

const parseOf = (caseId: string): Json =>
  JSON.parse(JSON.stringify(shoDocumentWriteParse(caseId))) as Json;

function contextRef(id: string): Json {
  const parse = JSON.parse(
    JSON.stringify(shoOrderWriteParse("d88-object-order")),
  ) as Json;
  const said = parse["params"] as Json;
  return { ...(said["order_number"] as Json), id };
}

function createOnFocusOrder(id: string, patch: Json = {}): Json {
  const parse = parseOf("tools-01-085");
  const said = parse["params"] as Json;
  return {
    ...parse,
    refPrevious: {},
    params: { ...said, order_number: contextRef(id), ...patch },
  };
}

function onFocusDocument(action: string, verb: string, id: string): Json {
  const parse = parseOf("tools-01-085");
  return {
    ...parse,
    text: "скасуй його",
    action,
    verb,
    refPrevious: {},
    params: { document_ref: contextRef(id) },
  };
}

function commandOf(parse: Json, patch: Json = {}): ShoCommand {
  return shoCommandSchema.parse({
    confidence: OVER_THE_FLOOR,
    ...parse,
    ...patch,
  });
}

function resultOf(command: ShoCommand): ShoResult {
  return shoResultSchema.parse({
    schema: "sho-result/2",
    raw: null,
    text: command.text,
    segments: [command.text],
    tooMany: false,
    commands: [command],
    first: command,
    context: { version: 1, revision: null },
  });
}

const whitelisted = createShoPlanner({
  actions: [
    ...SHO_READ_ACTIONS,
    ...SHO_WRITE_ACTIONS,
    ...SHO_ORDER_LIFECYCLE_ACTIONS,
    ...SHO_CUSTOMER_WRITE_ACTIONS,
    ...SHO_DOCUMENT_WRITE_ACTIONS,
  ],
});

function planOf(command: ShoCommand): ShoActionPlan {
  const planner = SHO_DOCUMENT_WRITE_PLANNERS[command.action];
  if (planner === undefined) {
    throw new Error(`no document planner for ${command.action}`);
  }
  return planner.plan(command, NOW);
}

const orderInFocus = (id: string): ShoFocusEntry => ({
  type: "order",
  id,
  name: "№ 7001",
  how: "created",
  turns: 0,
});

describe("«виставити рахунок» issues from the order the focus holds", () => {
  it("plans tools-01-085 as documents_createFromOrder on the focus order", () => {
    expect(planOf(commandOf(createOnFocusOrder(OUR_ORDER)))).toEqual({
      kind: "call",
      toolName: "documents_createFromOrder",
      reply: "Документ створено.",
      input: { orderId: OUR_ORDER, type: "payment_invoice" },
    });
  });

  it("stamps the write once, so the turn reaches the preview", () => {
    expect(
      whitelisted(resultOf(commandOf(createOnFocusOrder(OUR_ORDER))), NOW),
    ).toEqual({
      kind: "call",
      toolName: "documents_createFromOrder",
      reply: "Документ створено.",
      input: { orderId: OUR_ORDER, type: "payment_invoice" },
      writes: true,
    });
  });

  it("sends a resolved counterparty as the legal face of the document", () => {
    expect(
      planOf(
        commandOf(
          createOnFocusOrder(OUR_ORDER, {
            counterparty: {
              text: "софтлайн",
              status: "resolved",
              id: OUR_COUNTERPARTY,
              name: "ТОВ «Софтлайн Львів»",
              match: "alias",
            },
          }),
        ),
      ),
    ).toEqual({
      kind: "call",
      toolName: "documents_createFromOrder",
      reply: "Документ створено.",
      input: {
        orderId: OUR_ORDER,
        type: "payment_invoice",
        counterpartyId: OUR_COUNTERPARTY,
      },
    });
  });

  it("refuses a document type Shozee does not issue", () => {
    expect(planOf(commandOf(parseOf("d73-base-document")))).toEqual({
      kind: "fallback",
      reason: "unsupported_param",
    });
  });

  it("refuses an order described by its customer", () => {
    expect(planOf(commandOf(parseOf("d92-ordinal-no-sum")))).toEqual({
      kind: "fallback",
      reason: "unsupported_param",
    });
  });

  it("refuses an order carried over from an earlier command", () => {
    expect(planOf(commandOf(parseOf("coffee_tea-01-026")))).toEqual({
      kind: "fallback",
      reason: "unsupported_param",
    });
  });

  it("refuses a create the parse left without an order", () => {
    const said = parseOf("tools-01-085")["params"] as Json;
    expect(
      planOf(
        commandOf(createOnFocusOrder(OUR_ORDER), {
          params: { document_type: said["document_type"] },
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "blocking_need" });
  });

  it("refuses a spoken order number the action cannot resolve", () => {
    expect(
      planOf(
        commandOf(
          createOnFocusOrder(OUR_ORDER, {
            order_number: { text: "131", value: 131 },
          }),
        ),
      ),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });
});

describe("cancel, share and request-sign act on one held document", () => {
  const verbs: Readonly<Record<string, readonly [string, string, string]>> = {
    [SHO_CANCEL_DOCUMENT]: [
      "cancel",
      "documents_cancel",
      "Документ скасовано.",
    ],
    [SHO_SHARE_DOCUMENT]: [
      "send",
      "documents_share",
      "Посилання на документ готове.",
    ],
    [SHO_REQUEST_SIGN_DOCUMENT]: [
      "send",
      "documents_requestSign",
      "Запит на підпис надіслано.",
    ],
  };

  it("plans each intent as the document id and nothing else", () => {
    for (const [action, [verb, toolName, reply]] of Object.entries(verbs)) {
      expect(
        planOf(commandOf(onFocusDocument(action, verb, OUR_DOCUMENT))),
      ).toEqual({
        kind: "call",
        toolName,
        reply,
        input: { documentId: OUR_DOCUMENT },
      });
    }
  });

  it("pauses each one on the preview like every other Шо write", () => {
    for (const [action, [verb, toolName]] of Object.entries(verbs)) {
      expect(
        whitelisted(
          resultOf(commandOf(onFocusDocument(action, verb, OUR_DOCUMENT))),
          NOW,
        ),
      ).toMatchObject({ kind: "call", toolName, writes: true });
    }
  });

  it("leaves the share link and its token to the action's own preview", () => {
    const plan = whitelisted(
      resultOf(
        commandOf(onFocusDocument(SHO_SHARE_DOCUMENT, "send", OUR_DOCUMENT)),
      ),
      NOW,
    );
    expect(plan).toEqual({
      kind: "call",
      toolName: "documents_share",
      reply: "Посилання на документ готове.",
      input: { documentId: OUR_DOCUMENT },
      writes: true,
    });
  });

  it("refuses a share the parse described by a channel and a customer", () => {
    expect(planOf(commandOf(parseOf("flowers-01-029")))).toEqual({
      kind: "fallback",
      reason: "unsupported_param",
    });
  });

  it("refuses a spoken document number: the action takes only an id", () => {
    expect(
      planOf(
        commandOf(
          onFocusDocument(SHO_CANCEL_DOCUMENT, "cancel", OUR_DOCUMENT),
          {
            params: { document_ref: { text: "57", value: 57 } },
          },
        ),
      ),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });

  it("refuses a resolved document ref: only the focus binds a document", () => {
    expect(
      planOf(
        commandOf(
          onFocusDocument(SHO_CANCEL_DOCUMENT, "cancel", OUR_DOCUMENT),
          {
            params: {
              document_ref: {
                text: "його",
                status: "resolved",
                id: OUR_DOCUMENT,
                name: "РФ-12",
              },
            },
          },
        ),
      ),
    ).toEqual({ kind: "fallback", reason: "unsupported_param" });
  });
});

describe("a document the focus does not hold is never written to", () => {
  it("refuses another company's document id against this turn's focus", () => {
    expect(
      shoFocusHolds(
        commandOf(
          onFocusDocument(
            SHO_CANCEL_DOCUMENT,
            "cancel",
            ANOTHER_COMPANYS_DOCUMENT,
          ),
        ),
        [orderInFocus(OUR_ORDER)],
      ),
    ).toBe(false);
  });

  it("holds no document at all, so even our own id stays the LLM's", () => {
    expect(
      shoFocusHolds(
        commandOf(onFocusDocument(SHO_CANCEL_DOCUMENT, "cancel", OUR_DOCUMENT)),
        [orderInFocus(OUR_ORDER)],
      ),
    ).toBe(false);
  });

  it("refuses another company's order id against this turn's focus", () => {
    expect(
      shoFocusHolds(commandOf(createOnFocusOrder(ANOTHER_COMPANYS_DOCUMENT)), [
        orderInFocus(OUR_ORDER),
      ]),
    ).toBe(false);
  });

  it("holds the order the same turn put in focus", () => {
    expect(
      shoFocusHolds(commandOf(createOnFocusOrder(OUR_ORDER)), [
        orderInFocus(OUR_ORDER),
      ]),
    ).toBe(true);
  });

  it("refuses a context reference the parse left without an id", () => {
    expect(
      planOf(
        commandOf(createOnFocusOrder(OUR_ORDER), {
          params: {
            document_type: { value: "payment_invoice" },
            order_number: { text: "його", status: "context" },
          },
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "conversation_dependent" });
  });

  it("refuses a focus id that is not shaped like one of ours", () => {
    expect(planOf(commandOf(createOnFocusOrder("o-7001")))).toEqual({
      kind: "fallback",
      reason: "unsupported_param",
    });
  });
});

describe("the document write planners stay inside the Шо write protocol", () => {
  it("declares writes on every document planner", () => {
    for (const action of SHO_DOCUMENT_WRITE_ACTIONS) {
      expect({
        action,
        writes: SHO_DOCUMENT_WRITE_PLANNERS[action]?.writes,
      }).toEqual({ action, writes: true });
    }
  });

  it("names the four document actions and their mapped params", () => {
    expect(SHO_DOCUMENT_WRITE_ACTIONS).toEqual([
      SHO_CREATE_DOCUMENT,
      SHO_CANCEL_DOCUMENT,
      SHO_SHARE_DOCUMENT,
      SHO_REQUEST_SIGN_DOCUMENT,
    ]);
    expect(SHO_DOCUMENT_WRITE_PLANNER_PARAMS).toEqual({
      [SHO_CREATE_DOCUMENT]: ["order_number", "document_type", "counterparty"],
      [SHO_CANCEL_DOCUMENT]: ["document_ref"],
      [SHO_SHARE_DOCUMENT]: ["document_ref"],
      [SHO_REQUEST_SIGN_DOCUMENT]: ["document_ref"],
    });
  });

  it("refuses a document parse that arrives with a read's effect", () => {
    expect(
      whitelisted(
        resultOf(
          commandOf(createOnFocusOrder(OUR_ORDER), {
            kind: "read",
            effect: "read",
            confirm: "none",
          }),
        ),
        NOW,
      ),
    ).toEqual({ kind: "fallback", reason: "effect_mismatch" });
  });

  it("plans nothing for a document write no deployment whitelisted", () => {
    expect(
      createShoPlanner({
        actions: [...SHO_READ_ACTIONS, ...SHO_WRITE_ACTIONS],
      })(resultOf(commandOf(createOnFocusOrder(OUR_ORDER))), NOW),
    ).toEqual({ kind: "fallback", reason: "not_whitelisted" });
  });
});
