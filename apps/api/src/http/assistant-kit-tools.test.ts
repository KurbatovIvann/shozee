/**
 * The real façades, adapted to the kit's outcome type.
 *
 * The domain is reached through a fake `execute`, so this suite needs no
 * database — but the tools, their schemas, their descriptions and the surface
 * composition are the production ones. What is under test is the adaptation:
 * a value becomes `ok` with a card, a picker CONFLICT becomes `pause`, any
 * other domain refusal becomes `error`.
 */
import {
  CUSTOMERS_GET_CUSTOMER_TOOL_NAME,
  ORDERS_CREATE_ACTION_NAME,
  ORDERS_CREATE_TOOL_NAME,
  ORDERS_LIST_COUNTS_TOOL_NAME,
  ORDERS_LIST_PAGE_TOOL_NAME,
  filterStaffAiTools,
  staffAssistantTools,
  type ActionToolExecute,
} from "@showzy/ai";
import {
  createAssistantKit,
  runHostTurn,
  type ToolOutcome,
  type ToolSet,
} from "@showzy/assistant-kit";
import {
  stubModel,
  stubTextStep,
  stubToolCallStep,
  testDeps,
} from "@showzy/assistant-kit/testing";
import {
  AssistantConfirmationRequired,
  assistantInteractions,
  assistantKitIdempotencyKey,
  assistantKitTurnTools,
  assistantPreviewLevel,
  confirmation,
  confirmationAlso,
  confirmationPause,
  createResolveAnswer,
  withChosenId,
  choice,
  type AssistantToolLogger,
  type ChoiceOptionSecret,
  type ChoiceSecret,
  type ConfirmationAlsoSecret,
  type ConfirmationSecret,
  type ReSummarizeAction,
  type ResolveAnswerDeps,
  type RunConfirmedAction,
} from "@showzy/assistant-runtime";
import {
  ConfirmationRequiredError,
  ConflictError,
  CoreInvariantError,
  NotFoundError,
} from "@showzy/core/errors";
import { ENTITY_LOOKUP_OPTIONS_MAX } from "@showzy/module-kit/entity-lookup";
import {
  ASSISTANT_CHOICE_OPTIONS_MAX,
  assistantConfirmationPromptSchema,
} from "@showzy/validation/assistant-chat";
import { describe, expect, it } from "vitest";

import { createActionRegistry } from "../registry.js";
import { testStaffProvider } from "@showzy/ai/test";

const registry = createActionRegistry();
const CONTRACTS = filterStaffAiTools(registry.contracts(), {
  role: "owner",
  permissions: [
    "orders:view",
    "orders:edit",
    "customers:view",
    "assistant:use",
  ],
});

const ORDER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CUSTOMER_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CUSTOMER_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const ANOTHER_COMPANY = "b12eb0de-b12e-4b12-8b12-b12eb0deb12e";

const LEAKY_REFUSAL = new NotFoundError("Клієнта не знайдено.", {
  internalMessage: `customer ${CUSTOMER_B} belongs to company ${ANOTHER_COMPANY}`,
});

/** No `status` of its own: the façade envelope owns that key. */
const CREATED_ORDER = {
  orderId: ORDER_ID,
  orderNumber: "CO-1",
  customerNameSnapshot: "Катя Самбука",
  totalGrossMinor: "12000",
  currency: "UAH",
};

/** The picker CONFLICT the domain raises, duck-typed exactly as it does. */
function pickerConflict(target: unknown): ConflictError {
  const error = new ConflictError("choose one");
  return Object.assign(error, {
    reason: "ambiguous",
    target,
    options: [
      { id: CUSTOMER_A, label: "Катя Самбука" },
      { id: CUSTOMER_B, label: "Катя Іванова" },
    ],
    optionsTruncated: false,
  });
}

type Warn = {
  readonly fields: Record<string, unknown>;
  readonly message: string;
};

/** Collects what the tool layer reports, so a silent path is a failing test. */
function capturingLogger(): {
  logger: AssistantToolLogger;
  warnings: Warn[];
} {
  const warnings: Warn[] = [];
  return {
    logger: {
      warn: (fields, message) => {
        warnings.push({ fields, message });
      },
    },
    warnings,
  };
}

function tools(
  execute: ActionToolExecute,
  logger?: AssistantToolLogger,
): ToolSet {
  return assistantKitTurnTools(
    staffAssistantTools(CONTRACTS, execute, testStaffProvider),
    logger ?? capturingLogger().logger,
  );
}

/**
 * A catalog terminal: nothing to pick between, so it is correctly an error.
 * The domain raises these with an empty option list.
 */
function terminalConflict(): ConflictError {
  const error = new ConflictError("this product is archived");
  return Object.assign(error, {
    reason: "archived",
    target: { kind: "order_line_product", lineIndex: 0, query: "торт" },
    options: [],
    optionsTruncated: false,
  });
}

async function run(
  set: ToolSet,
  name: string,
  input: unknown,
  toolCallId = "toolu_1",
): Promise<ToolOutcome> {
  const execute = set[name]?.execute;
  if (execute === undefined) throw new Error(`no tool ${name}`);
  return (await execute(input, {
    toolCallId,
    messages: [],
  } as never)) as ToolOutcome;
}

const CREATE_BY_QUERY = {
  customerQuery: "Катя",
  items: [{ productQuery: "Наполеон", quantityDecimal: "3" }],
};

const UAH_12000 = [{ currency: "UAH", grossAmountMinor: "12000" }];
const NEW_BUCKET = {
  identity: { kind: "status", status: "new" },
  label: "new",
  orderCount: 1,
  grossByCurrency: UAH_12000,
};

/** `orders.list` as the domain answers it: a page, or a status rollup. */
const ordersListExecute: ActionToolExecute = (_action, input) =>
  Promise.resolve(
    (input as { readonly kind?: unknown }).kind === "aggregate"
      ? {
          status: "completed",
          kind: "aggregate",
          orderCount: 1,
          grossByCurrency: UAH_12000,
          buckets: [NEW_BUCKET],
          statusBuckets: [NEW_BUCKET],
          bucketsTruncated: false,
          customerMatchTruncated: false,
        }
      : {
          status: "completed",
          kind: "page.summary",
          items: [
            {
              orderId: ORDER_ID,
              orderNumber: "CO-1",
              customer: {
                nameSnapshot: "Катя Самбука",
                linkedCustomerId: null,
              },
              status: "new",
              itemCount: 1,
              totalGrossMinor: "12000",
              currency: "UAH",
              createdAt: "2026-09-10T09:00:00.000Z",
            },
          ],
          nextCursor: null,
          customerMatchTruncated: false,
        },
  );

/** What the rollup above becomes on a list card. */
const NEW_CHIPS = [{ status: "new", orderCount: 1 }];

describe("the façades still carry their own descriptions", () => {
  it("keeps the learned wording rather than restating the schema", () => {
    const set = tools(() => Promise.resolve({}));

    const description = set[ORDERS_LIST_PAGE_TOOL_NAME]?.description ?? "";

    // Sampled, not exhaustive: these are rules learned from use, and the point
    // of adapting rather than rewriting is that they come along untouched.
    expect(description).toContain("nominative");
    expect(description).toContain('One empty page is not "does not exist"');
    expect(description).toContain("Europe/Kyiv");
  });
});

describe("a value becomes ok, with the card the surface registry composes", () => {
  it("maps a created order to an order-entity card", async () => {
    const set = tools((action) => {
      expect(action).toBe(ORDERS_CREATE_ACTION_NAME);
      return Promise.resolve({ status: "completed", ...CREATED_ORDER });
    });

    const outcome = await run(set, ORDERS_CREATE_TOOL_NAME, {
      customerId: CUSTOMER_A,
      items: [{ productId: ORDER_ID, quantityDecimal: "3" }],
    });

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.card?.type).toBe("order-entity");
    expect(outcome.card?.cardId).toBe(`order-entity:${ORDER_ID}`);
  });

  /**
   * This used to read `if (page.card !== undefined && counts.card !== undefined)`
   * before comparing ids — and the rollup it was fed composed to nothing, so the
   * comparison never ran. Both cards are asserted to exist first now.
   */
  it("gives a page and the rollup after it the same card id, so the second updates the first", async () => {
    const set = tools(ordersListExecute);

    const page = await run(set, ORDERS_LIST_PAGE_TOOL_NAME, { limit: 5 });
    const counts = await run(
      set,
      ORDERS_LIST_COUNTS_TOOL_NAME,
      { groupBy: "status" },
      "toolu_2",
    );

    expect(page).toMatchObject({ kind: "ok", card: { type: "orders-list" } });
    expect(counts).toMatchObject({ kind: "ok", card: { type: "orders-list" } });
    if (page.kind !== "ok" || counts.kind !== "ok") return;
    expect(counts.card?.cardId).toBe(page.card?.cardId);
    expect(counts.card?.payload).toMatchObject({ chips: NEW_CHIPS });
  });

  it("gives a rollup and the page after it the same card id, so the list takes the aggregate's place", async () => {
    const set = tools(ordersListExecute);

    const counts = await run(set, ORDERS_LIST_COUNTS_TOOL_NAME, {
      groupBy: "status",
    });
    const page = await run(
      set,
      ORDERS_LIST_PAGE_TOOL_NAME,
      { limit: 5 },
      "toolu_2",
    );

    expect(counts).toMatchObject({
      kind: "ok",
      card: { type: "orders-aggregate" },
    });
    expect(page).toMatchObject({ kind: "ok", card: { type: "orders-list" } });
    if (page.kind !== "ok" || counts.kind !== "ok") return;
    expect(page.card?.cardId).toBe(counts.card?.cardId);
  });
});

/**
 * SHO-551 over the production pieces end to end: the façades, the composer, the
 * kit's loop and its message writer. Two calls that compose into one surface
 * must leave one card in the message, not one per call.
 */
describe("two calls that compose into one surface leave one card", () => {
  const CONVERSATION = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const MESSAGE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const PAGE_CALL = [ORDERS_LIST_PAGE_TOOL_NAME, { limit: 5 }] as const;
  const COUNTS_CALL = [
    ORDERS_LIST_COUNTS_TOOL_NAME,
    { groupBy: "status" },
  ] as const;

  async function turnOf(calls: readonly (readonly [string, unknown])[]) {
    const kit = createAssistantKit(testDeps(assistantInteractions));
    const scope = { conversationId: CONVERSATION, bind: "user-1:company-1" };
    const turn = await runHostTurn({
      kit,
      ...scope,
      messageId: MESSAGE,
      model: stubModel([
        ...calls.map(([name, input], index) =>
          stubToolCallStep(`toolu_${String(index + 1)}`, name, input),
        ),
        stubTextStep("Ось замовлення."),
      ]),
      messages: [{ role: "user", content: "покажи замовлення" }],
      tools: tools(ordersListExecute),
    });
    const cards = (await kit.messages.read(scope)).messages
      .flatMap((message) => message.parts)
      .filter((part) => part.kind === "card");
    return { turn, cards };
  }

  it.each([
    ["a page, then its rollup", [PAGE_CALL, COUNTS_CALL]],
    ["a rollup, then a page", [COUNTS_CALL, PAGE_CALL]],
  ])("%s", async (_name, calls) => {
    const { turn, cards } = await turnOf(calls);

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      type: "orders-list",
      revision: 2,
      payload: { chips: NEW_CHIPS },
    });
    // What the turn reports is what a reload reads.
    expect(turn.parts.filter((part) => part.kind === "card")).toEqual(cards);
  });
});

describe("a CONFLICT that cannot open a picker", () => {
  /**
   * The gap this closes: from outside, a terminal refusal and a picker the
   * extractor could not read look identical — the model gets an error and
   * explains it in prose. Nobody could tell which one had happened, and the
   * second is a bug while the first is correct behaviour.
   */
  it("says so in the log, with the shape and not the content", async () => {
    const { logger, warnings } = capturingLogger();
    const set = tools(() => Promise.reject(terminalConflict()), logger);

    const outcome = await run(set, ORDERS_CREATE_TOOL_NAME, CREATE_BY_QUERY);

    expect(outcome.kind).toBe("error");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields).toMatchObject({
      tool_name: ORDERS_CREATE_TOOL_NAME,
      code: "CONFLICT",
      conflict_reason: "archived",
      target_kind: "order_line_product",
      option_count: 0,
    });
    // The staff member's own words about their customers do not go in logs.
    expect(JSON.stringify(warnings[0])).not.toContain("торт");
  });

  it("stays quiet when the conflict did open a picker", async () => {
    const { logger, warnings } = capturingLogger();
    const set = tools(
      () => Promise.reject(pickerConflict({ kind: "customer", query: "Катя" })),
      logger,
    );

    const outcome = await run(set, ORDERS_CREATE_TOOL_NAME, CREATE_BY_QUERY);

    expect(outcome.kind).toBe("pause");
    expect(warnings).toEqual([]);
  });

  it("stays quiet for a refusal that was never a choice", async () => {
    const { logger, warnings } = capturingLogger();
    const set = tools(() => Promise.reject(new NotFoundError()), logger);

    expect(
      (await run(set, ORDERS_CREATE_TOOL_NAME, CREATE_BY_QUERY)).kind,
    ).toBe("error");
    expect(warnings).toEqual([]);
  });
});

describe("a picker CONFLICT becomes a pause, not an error", () => {
  it("carries the options, and keeps the tool input to replay", async () => {
    const set = tools(() =>
      Promise.reject(pickerConflict({ kind: "customer", query: "Катя" })),
    );

    const outcome = await run(set, ORDERS_CREATE_TOOL_NAME, CREATE_BY_QUERY);

    expect(outcome.kind).toBe("pause");
    if (outcome.kind !== "pause") return;
    expect(outcome.interaction).toBe("choice");
    expect(outcome.prompt).toMatchObject({
      subject: "Катя",
      optionsTruncated: false,
      options: [
        { optionId: CUSTOMER_A, label: "Катя Самбука" },
        { optionId: CUSTOMER_B, label: "Катя Іванова" },
      ],
    });

    const secret = outcome.secret as ChoiceSecret;
    expect(secret.toolName).toBe(ORDERS_CREATE_TOOL_NAME);
    expect(secret.target).toEqual({ kind: "customer", query: "Катя" });
    expect(secret.input).toEqual(CREATE_BY_QUERY);
    // The entity ids stay on the server side of the record.
    expect(JSON.stringify(outcome.prompt)).not.toContain("byOption");
  });

  it("fails the turn when the create option id is one of the record ids", async () => {
    const collision = Object.assign(new ConflictError("choose one"), {
      reason: "ambiguous",
      target: { kind: "customer", query: "Катя" },
      options: [{ id: CUSTOMER_A, label: "Катя Самбука" }],
      optionsTruncated: false,
      create: { optionId: CUSTOMER_A },
    });
    const set = tools(() => Promise.reject(collision));

    await expect(
      run(set, ORDERS_CREATE_TOOL_NAME, CREATE_BY_QUERY),
    ).rejects.toBeInstanceOf(CoreInvariantError);
  });

  it("names the product line as the subject when the ambiguity is a line", async () => {
    const set = tools(() =>
      Promise.reject(
        pickerConflict({
          kind: "order_line_product",
          lineIndex: 0,
          query: "Наполеон",
        }),
      ),
    );

    const outcome = await run(set, ORDERS_CREATE_TOOL_NAME, CREATE_BY_QUERY);

    expect(outcome.kind).toBe("pause");
    if (outcome.kind !== "pause") return;
    expect(outcome.prompt).toMatchObject({ subject: "Наполеон" });
  });
});

function nearestConflict(): ConflictError {
  const error = new ConflictError("nothing matched");
  return Object.assign(error, {
    reason: "unmatched_query",
    target: { kind: "customer", query: "Галя" },
    options: [{ id: CUSTOMER_A, label: "Галина Петренко" }],
    optionsTruncated: false,
  });
}

describe("a picker CONFLICT produces v2 options", () => {
  it("numbers them by position and marks each one a record", async () => {
    const set = tools(() =>
      Promise.reject(pickerConflict({ kind: "customer", query: "Катя" })),
    );

    const outcome = await run(set, ORDERS_CREATE_TOOL_NAME, CREATE_BY_QUERY);

    expect(outcome.kind).toBe("pause");
    if (outcome.kind !== "pause") return;
    expect(outcome.prompt).toEqual({
      subject: "Катя",
      optionsTruncated: false,
      nearest: false,
      problem: "More than one record matches.",
      options: [
        { optionId: CUSTOMER_A, label: "Катя Самбука", kind: "record" },
        { optionId: CUSTOMER_B, label: "Катя Іванова", kind: "record" },
      ],
    });
  });

  it("asks under «можливо, ви мали на увазі» when nothing matched", async () => {
    const set = tools(() => Promise.reject(nearestConflict()));

    const outcome = await run(set, ORDERS_CREATE_TOOL_NAME, CREATE_BY_QUERY);

    expect(outcome.kind).toBe("pause");
    if (outcome.kind !== "pause") return;
    expect(outcome.prompt).toMatchObject({
      subject: "Галя",
      nearest: true,
      problem: "Nothing matches that exactly.",
    });
  });

  it("names the variant problem in its own words", async () => {
    const error = new ConflictError("pick a variant");
    const set = tools(() =>
      Promise.reject(
        Object.assign(error, {
          reason: "variant_required",
          target: {
            kind: "order_line_variant",
            lineIndex: 0,
            productId: ORDER_ID,
            productName: "Наполеон",
          },
          options: [{ id: CUSTOMER_A, label: "1 кг" }],
          optionsTruncated: false,
        }),
      ),
    );

    const outcome = await run(set, ORDERS_CREATE_TOOL_NAME, CREATE_BY_QUERY);

    expect(outcome.kind).toBe("pause");
    if (outcome.kind !== "pause") return;
    expect(outcome.prompt).toMatchObject({
      subject: "Наполеон",
      nearest: false,
      problem: "This product is sold by variant.",
    });
  });
});

describe("any other domain refusal becomes an error", () => {
  it("passes the code through instead of inventing a picker", async () => {
    const set = tools(() => Promise.reject(new NotFoundError("no such thing")));

    const outcome = await run(set, ORDERS_CREATE_TOOL_NAME, CREATE_BY_QUERY);

    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") return;
    expect(outcome.code).toBe("NOT_FOUND");
  });

  it("lets an unknown fault escape rather than dressing it as an answer", async () => {
    const set = tools(() => Promise.reject(new TypeError("boom")));

    await expect(
      run(set, ORDERS_CREATE_TOOL_NAME, CREATE_BY_QUERY),
    ).rejects.toThrow("boom");
  });
});

describe("the chosen id goes back into the tool's own input", () => {
  it("replaces the query it was ambiguous about", () => {
    const patched = withChosenId(
      CREATE_BY_QUERY,
      { kind: "customer", query: "Катя" },
      CUSTOMER_A,
    );

    expect(patched.kind).toBe("patched");
    if (patched.kind !== "patched") return;
    expect(patched.input).toEqual({
      customerId: CUSTOMER_A,
      items: [{ productQuery: "Наполеон", quantityDecimal: "3" }],
    });
  });

  it("fills a product line, and a variant line, by index", () => {
    const product = withChosenId(
      CREATE_BY_QUERY,
      { kind: "order_line_product", lineIndex: 0, query: "Наполеон" },
      ORDER_ID,
    );
    const variant = withChosenId(
      CREATE_BY_QUERY,
      { lineIndex: 0, productId: ORDER_ID, productName: "Наполеон" },
      CUSTOMER_B,
    );

    expect(product.kind === "patched" ? product.input : null).toEqual({
      customerQuery: "Катя",
      items: [{ productId: ORDER_ID, quantityDecimal: "3" }],
    });
    expect(variant.kind === "patched" ? variant.input : null).toEqual({
      customerQuery: "Катя",
      items: [
        {
          productQuery: "Наполеон",
          variantId: CUSTOMER_B,
          quantityDecimal: "3",
        },
      ],
    });
  });

  it("refuses a line index the input does not have", () => {
    const patched = withChosenId(
      { customerQuery: "Катя", items: [] },
      { kind: "order_line_product", lineIndex: 4, query: "x" },
      ORDER_ID,
    );

    expect(patched.kind).toBe("unpatchable");
  });
});

/** The request an answer arrives on — a different command from the turn's. */
const ANSWER_CONTEXT = {
  userId: "user-1",
  companySelector: "company-1",
  conversationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  commandId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  requestId: "request-answer",
  clientIp: "127.0.0.1",
};

/** For a resolver that must never reach a confirmed action. */
const NEVER_RESUMMARIZED: ReSummarizeAction = () =>
  Promise.reject(new Error("no re-summarize was expected here"));

const SILENT_LOGGER: AssistantToolLogger = { warn: () => {} };

const NEVER_CONFIRMED: ResolveAnswerDeps = {
  runConfirmed: () =>
    Promise.reject(new Error("no confirmation was expected here")),
  reSummarize: NEVER_RESUMMARIZED,
  logger: SILENT_LOGGER,
};

describe("resolveAnswer calls the same tool again", () => {
  it("sends the patched input to the same action and returns its card", async () => {
    const seen: unknown[] = [];
    const set = tools((action, input) => {
      seen.push({ action, input });
      return Promise.resolve({ status: "completed", ...CREATED_ORDER });
    });
    const resolveAnswer = createResolveAnswer(NEVER_CONFIRMED);

    const outcome = await resolveAnswer({
      toolName: ORDERS_CREATE_TOOL_NAME,
      kind: "choice",
      value: {
        entityId: CUSTOMER_A,
        toolName: ORDERS_CREATE_TOOL_NAME,
        input: CREATE_BY_QUERY,
        target: { kind: "customer", query: "Катя" },
      },
      tools: set,
      context: ANSWER_CONTEXT,
    });

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.card?.type).toBe("order-entity");

    // One call, through the same action, with the customer no longer a query.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ action: ORDERS_CREATE_ACTION_NAME });
    expect(JSON.stringify(seen[0])).toContain(CUSTOMER_A);
    expect(JSON.stringify(seen[0])).not.toContain("customerQuery");
  });

  it("returns another pause when settling one ambiguity uncovers the next", async () => {
    const set = tools(() =>
      Promise.reject(
        pickerConflict({
          kind: "order_line_product",
          lineIndex: 0,
          query: "Наполеон",
        }),
      ),
    );

    const outcome = await createResolveAnswer(NEVER_CONFIRMED)({
      toolName: ORDERS_CREATE_TOOL_NAME,
      kind: "choice",
      value: {
        entityId: CUSTOMER_A,
        toolName: ORDERS_CREATE_TOOL_NAME,
        input: CREATE_BY_QUERY,
        target: { kind: "customer", query: "Катя" },
      },
      tools: set,
      context: ANSWER_CONTEXT,
    });

    // Not a failure: the next question, on the same job.
    expect(outcome.kind).toBe("pause");
    if (outcome.kind !== "pause") return;
    expect(outcome.prompt).toMatchObject({ subject: "Наполеон" });
  });
});

/**
 * SHO-553. An action core will not run without a person's authorisation, and
 * the answer that resumes it. Core's protocol itself is exercised end to end in
 * `assistant-kit-confirmation.db.test.ts`; these pin the adaptation on each side.
 */
describe("an action that needs a person's authorisation", () => {
  const ATTEMPT = {
    actionName: "customers.deleteCustomer",
    input: { id: CUSTOMER_A },
    idempotencyKey: "tool:the-turn-that-asked",
  };
  const CARD = {
    title: "The customer will be deleted permanently.",
    lines: [{ label: "Контакт", value: "+380 50 000 00 00" }],
    notes: ["Цю дію не можна скасувати."],
  };
  const CHALLENGE = {
    challengeId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    summary: CARD.title,
    expiresAt: "2026-09-10T12:05:00.000Z",
    preview: CARD,
  };
  const SECOND_ATTEMPT = {
    actionName: "customers.updateCustomer",
    input: { id: CUSTOMER_A, name: "Галина" },
    idempotencyKey: "tool:the-turn-that-asked:second",
  };
  const SECOND_CHALLENGE = {
    challengeId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    summary: "Змінити клієнта: Галина",
    expiresAt: "2026-09-10T12:05:00.000Z",
    preview: { title: "Змінити клієнта: Галина", lines: [], notes: [] },
  };

  const SECOND_ALSO: ConfirmationAlsoSecret = {
    actionName: SECOND_ATTEMPT.actionName,
    canonicalInput: SECOND_ATTEMPT.input,
    idempotencyKey: SECOND_ATTEMPT.idempotencyKey,
    challengeId: SECOND_CHALLENGE.challengeId,
    preview: SECOND_CHALLENGE.preview,
    level: "card",
  };

  function storedBeforeAlso(): ConfirmationSecret {
    const stored: Omit<ConfirmationSecret, "also"> = {
      actionName: ATTEMPT.actionName,
      canonicalInput: ATTEMPT.input,
      idempotencyKey: ATTEMPT.idempotencyKey,
      challengeId: CHALLENGE.challengeId,
    };
    return stored as ConfirmationSecret;
  }

  /** What a claim hands the resolver, produced by the kind's own `resolve`. */
  function approvedFrom(secret: ConfirmationSecret): unknown {
    const resolution = confirmation.resolve({
      answer: { approved: true },
      secret,
    });
    if (resolution.kind !== "resolved") {
      throw new Error("a confirmation always resolves");
    }
    return resolution.value;
  }

  function approved(also: readonly ConfirmationAlsoSecret[] = []): unknown {
    return approvedFrom({
      actionName: ATTEMPT.actionName,
      canonicalInput: ATTEMPT.input,
      idempotencyKey: ATTEMPT.idempotencyKey,
      challengeId: CHALLENGE.challengeId,
      also,
    });
  }

  function answerWith(
    deps: Partial<ResolveAnswerDeps> & Pick<ResolveAnswerDeps, "runConfirmed">,
    also: readonly ConfirmationAlsoSecret[] = [],
  ): Promise<ToolOutcome> {
    return createResolveAnswer({
      reSummarize: NEVER_RESUMMARIZED,
      logger: SILENT_LOGGER,
      ...deps,
    })({
      toolName: "customers_deleteCustomer",
      kind: "confirmation",
      value: approved(also),
      // Nothing is looked up by tool name: the stored attempt says what runs.
      tools: {},
      context: ANSWER_CONTEXT,
    });
  }

  it("pauses on a confirmation that carries the whole card and keeps the attempt server-side", async () => {
    const set = tools(() =>
      Promise.reject(
        new AssistantConfirmationRequired(
          ATTEMPT,
          new ConfirmationRequiredError(CHALLENGE),
          "strong",
        ),
      ),
    );

    const outcome = await run(set, "customers_deleteCustomer", {
      id: CUSTOMER_A,
    });

    expect(outcome).toEqual({
      kind: "pause",
      interaction: "confirmation",
      prompt: {
        summary: CHALLENGE.summary,
        preview: CARD,
        also: [],
        level: "strong",
      },
      secret: {
        actionName: ATTEMPT.actionName,
        canonicalInput: ATTEMPT.input,
        idempotencyKey: ATTEMPT.idempotencyKey,
        challengeId: CHALLENGE.challengeId,
        also: [],
      },
    });
  });

  it("falls back to the summary when the action presents no structured card", () => {
    const { preview } = assistantConfirmationPromptSchema.parse(
      confirmationPause(
        new AssistantConfirmationRequired(
          ATTEMPT,
          new ConfirmationRequiredError({
            challengeId: CHALLENGE.challengeId,
            summary: "Підписати документ",
            expiresAt: CHALLENGE.expiresAt,
          }),
        ),
      ).prompt,
    );

    expect(preview).toEqual({
      title: "Підписати документ",
      lines: [],
      notes: [],
    });
  });

  it("puts both actions on one card, and keeps each attempt whole", () => {
    const pause = confirmationPause(
      new AssistantConfirmationRequired(
        ATTEMPT,
        new ConfirmationRequiredError(CHALLENGE),
        "strong",
      ),
      [
        confirmationAlso(
          new AssistantConfirmationRequired(
            SECOND_ATTEMPT,
            new ConfirmationRequiredError(SECOND_CHALLENGE),
            "card",
          ),
        ),
      ],
    );

    const prompt = assistantConfirmationPromptSchema.parse(pause.prompt);
    expect(prompt.also).toEqual([SECOND_CHALLENGE.preview]);
    expect(prompt.level).toBe("strong");
    expect(pause.secret).toMatchObject({
      idempotencyKey: ATTEMPT.idempotencyKey,
      challengeId: CHALLENGE.challengeId,
      also: [
        {
          actionName: SECOND_ATTEMPT.actionName,
          canonicalInput: SECOND_ATTEMPT.input,
          idempotencyKey: SECOND_ATTEMPT.idempotencyKey,
          challengeId: SECOND_CHALLENGE.challengeId,
        },
      ],
    });
  });

  it("runs one card's actions as separate attempts, each under its own key", async () => {
    const seen: unknown[] = [];

    const outcome = await answerWith(
      {
        runConfirmed: (args) => {
          seen.push({
            actionName: args.actionName,
            idempotencyKey: args.idempotencyKey,
            challengeId: args.challengeId,
          });
          return Promise.resolve({ ran: args.actionName });
        },
      },
      [SECOND_ALSO],
    );

    expect(seen).toEqual([
      {
        actionName: ATTEMPT.actionName,
        idempotencyKey: ATTEMPT.idempotencyKey,
        challengeId: CHALLENGE.challengeId,
      },
      {
        actionName: SECOND_ATTEMPT.actionName,
        idempotencyKey: SECOND_ATTEMPT.idempotencyKey,
        challengeId: SECOND_CHALLENGE.challengeId,
      },
    ]);
    expect(outcome).toEqual({
      kind: "ok",
      result: {
        done: [
          { action: ATTEMPT.actionName, result: { ran: ATTEMPT.actionName } },
          {
            action: SECOND_ATTEMPT.actionName,
            result: { ran: SECOND_ATTEMPT.actionName },
          },
        ],
      },
    });
  });

  it("reports the first as done when the second of one card fails", async () => {
    const refusal = LEAKY_REFUSAL;

    const outcome = await answerWith(
      {
        runConfirmed: (args) =>
          args.actionName === ATTEMPT.actionName
            ? Promise.resolve({ id: CUSTOMER_A })
            : Promise.reject(refusal),
      },
      [SECOND_ALSO],
    );

    expect(outcome).toEqual({
      kind: "ok",
      result: {
        done: [{ action: ATTEMPT.actionName, result: { id: CUSTOMER_A } }],
        failed: {
          action: SECOND_ATTEMPT.actionName,
          code: refusal.code,
          message: refusal.clientMessage,
        },
      },
    });
    expect(JSON.stringify(outcome)).not.toContain(ANOTHER_COMPANY);
  });

  it("tells the model the client text when a carried action asks again", async () => {
    const refusedAgain = new ConfirmationRequiredError(
      SECOND_CHALLENGE,
      "Підтвердіть цю дію ще раз.",
      { internalMessage: `challenge issued for ${ANOTHER_COMPANY}` },
    );

    const outcome = await answerWith(
      {
        runConfirmed: (args) =>
          args.actionName === ATTEMPT.actionName
            ? Promise.resolve({ id: CUSTOMER_A })
            : Promise.reject(
                new AssistantConfirmationRequired(SECOND_ATTEMPT, refusedAgain),
              ),
      },
      [SECOND_ALSO],
    );

    expect(outcome).toEqual({
      kind: "ok",
      result: {
        done: [{ action: ATTEMPT.actionName, result: { id: CUSTOMER_A } }],
        failed: {
          action: SECOND_ATTEMPT.actionName,
          code: refusedAgain.code,
          message: refusedAgain.clientMessage,
        },
      },
    });
    expect(JSON.stringify(outcome)).not.toContain(ANOTHER_COMPANY);
  });

  const DRIFTED_CHALLENGE = {
    ...CHALLENGE,
    challengeId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
  };
  const SECOND_RESUMMARIZED = {
    challengeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    summary: "Змінити клієнта: Галина Петрівна",
    expiresAt: SECOND_CHALLENGE.expiresAt,
    preview: {
      title: "Змінити клієнта: Галина Петрівна",
      lines: [],
      notes: [],
    },
  };

  const driftsOnFirst: RunConfirmedAction = () =>
    Promise.reject(
      new AssistantConfirmationRequired(
        ATTEMPT,
        new ConfirmationRequiredError(DRIFTED_CHALLENGE),
      ),
    );

  it("asks again with the fresh card when the first action of one card drifts", async () => {
    const seen: unknown[] = [];
    const reSummarized: unknown[] = [];

    const outcome = await answerWith(
      {
        runConfirmed: (args) => {
          seen.push({
            actionName: args.actionName,
            input: args.input,
            idempotencyKey: args.idempotencyKey,
            challengeId: args.challengeId,
          });
          return driftsOnFirst(args);
        },
        reSummarize: (args) => {
          reSummarized.push({
            actionName: args.actionName,
            input: args.input,
            idempotencyKey: args.idempotencyKey,
          });
          return Promise.reject(
            new AssistantConfirmationRequired(
              SECOND_ATTEMPT,
              new ConfirmationRequiredError(SECOND_RESUMMARIZED),
            ),
          );
        },
      },
      [SECOND_ALSO],
    );

    expect(seen).toEqual([
      {
        actionName: ATTEMPT.actionName,
        input: ATTEMPT.input,
        idempotencyKey: ATTEMPT.idempotencyKey,
        challengeId: CHALLENGE.challengeId,
      },
    ]);
    expect(reSummarized).toEqual([
      {
        actionName: SECOND_ATTEMPT.actionName,
        input: SECOND_ATTEMPT.input,
        idempotencyKey: SECOND_ATTEMPT.idempotencyKey,
      },
    ]);
    expect(outcome).toMatchObject({
      kind: "pause",
      interaction: "confirmation",
      prompt: {
        preview: CARD,
        also: [SECOND_RESUMMARIZED.preview],
      },
      secret: {
        challengeId: DRIFTED_CHALLENGE.challengeId,
        idempotencyKey: ATTEMPT.idempotencyKey,
        also: [
          {
            ...SECOND_ALSO,
            challengeId: SECOND_RESUMMARIZED.challengeId,
            preview: SECOND_RESUMMARIZED.preview,
          },
        ],
      },
    });
  });

  it("drops a carried action whose key already committed, and says so", async () => {
    const warned: Record<string, unknown>[] = [];

    const outcome = await answerWith(
      {
        runConfirmed: driftsOnFirst,
        reSummarize: () => Promise.resolve({ id: CUSTOMER_A }),
        logger: { warn: (fields) => warned.push(fields) },
      },
      [SECOND_ALSO],
    );

    expect(outcome).toMatchObject({
      kind: "pause",
      prompt: { also: [] },
      secret: { challengeId: DRIFTED_CHALLENGE.challengeId, also: [] },
    });
    expect(warned).toEqual([
      {
        action: SECOND_ATTEMPT.actionName,
        idempotencyKey: SECOND_ATTEMPT.idempotencyKey,
        outcome: "done",
      },
    ]);
  });

  it("drops a carried action it cannot re-ask, so the tap never runs it", async () => {
    const warned: Record<string, unknown>[] = [];

    const outcome = await answerWith(
      {
        runConfirmed: driftsOnFirst,
        reSummarize: () => Promise.reject(LEAKY_REFUSAL),
        logger: { warn: (fields) => warned.push(fields) },
      },
      [SECOND_ALSO],
    );

    expect(outcome).toMatchObject({
      kind: "pause",
      prompt: { also: [] },
      secret: { also: [] },
    });
    expect(warned).toEqual([
      {
        action: SECOND_ATTEMPT.actionName,
        idempotencyKey: SECOND_ATTEMPT.idempotencyKey,
        outcome: "failed",
        code: LEAKY_REFUSAL.code,
      },
    ]);
    expect(JSON.stringify(outcome)).not.toContain(ANOTHER_COMPANY);
  });

  const THIRD_ALSO: ConfirmationAlsoSecret = {
    actionName: "orders.create",
    canonicalInput: { customerId: CUSTOMER_A, items: [] },
    idempotencyKey: "tool:the-turn-that-asked:third",
    challengeId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    preview: { title: "Створити замовлення: Галина", lines: [], notes: [] },
    level: "card",
  };

  it("names on the card both carried actions the re-ask dropped", async () => {
    const outcome = await answerWith(
      {
        runConfirmed: driftsOnFirst,
        reSummarize: (args) =>
          args.idempotencyKey === SECOND_ATTEMPT.idempotencyKey
            ? Promise.resolve({ id: CUSTOMER_A })
            : Promise.reject(LEAKY_REFUSAL),
      },
      [SECOND_ALSO, THIRD_ALSO],
    );

    expect(outcome).toMatchObject({
      kind: "pause",
      prompt: {
        preview: {
          title: CARD.title,
          notes: [
            `Вже виконано: «${SECOND_ALSO.preview.title}»`,
            `Більше не можна виконати: «${THIRD_ALSO.preview.title}»`,
            ...CARD.notes,
          ],
        },
        also: [],
      },
      secret: { also: [] },
    });
    expect(JSON.stringify(outcome)).not.toContain(ANOTHER_COMPANY);
  });

  it("leaves the card's own notes alone when nothing was dropped", async () => {
    const outcome = await answerWith(
      {
        runConfirmed: driftsOnFirst,
        reSummarize: () =>
          Promise.reject(
            new AssistantConfirmationRequired(
              SECOND_ATTEMPT,
              new ConfirmationRequiredError(SECOND_RESUMMARIZED),
            ),
          ),
      },
      [SECOND_ALSO],
    );

    expect(outcome).toMatchObject({
      kind: "pause",
      prompt: {
        preview: CARD,
        also: [SECOND_RESUMMARIZED.preview],
      },
    });
  });

  it("re-asks a carried high-risk action and the whole card turns strong", async () => {
    const outcome = await answerWith(
      {
        runConfirmed: driftsOnFirst,
        reSummarize: () =>
          Promise.reject(
            new AssistantConfirmationRequired(
              SECOND_ATTEMPT,
              new ConfirmationRequiredError(SECOND_RESUMMARIZED),
              "strong",
            ),
          ),
      },
      [SECOND_ALSO],
    );

    expect(outcome).toMatchObject({
      kind: "pause",
      prompt: { also: [SECOND_RESUMMARIZED.preview], level: "strong" },
      secret: {
        also: [
          {
            ...SECOND_ALSO,
            challengeId: SECOND_RESUMMARIZED.challengeId,
            preview: SECOND_RESUMMARIZED.preview,
            level: "strong",
          },
        ],
      },
    });
  });

  it("fails the turn rather than re-asking when core reports an invariant", async () => {
    await expect(
      answerWith(
        {
          runConfirmed: driftsOnFirst,
          reSummarize: () =>
            Promise.reject(new CoreInvariantError("gate returned a grant")),
        },
        [SECOND_ALSO],
      ),
    ).rejects.toBeInstanceOf(CoreInvariantError);
  });

  it("re-presents a carried action unchanged, so core answers the same attempt", async () => {
    const seen: unknown[] = [];

    await answerWith(
      {
        runConfirmed: (args) => {
          seen.push({
            actionName: args.actionName,
            input: args.input,
            idempotencyKey: args.idempotencyKey,
            challengeId: args.challengeId,
          });
          return Promise.resolve({ ran: args.actionName });
        },
      },
      [SECOND_ALSO],
    );

    expect(seen[1]).toEqual({
      actionName: SECOND_ALSO.actionName,
      input: SECOND_ALSO.canonicalInput,
      idempotencyKey: SECOND_ALSO.idempotencyKey,
      challengeId: SECOND_ALSO.challengeId,
    });
  });

  it("re-approving a drifted card runs the actions that never ran", async () => {
    const ran: string[] = [];
    const outcome = await createResolveAnswer({
      runConfirmed: (args) => {
        ran.push(args.actionName);
        return Promise.resolve({ ran: args.actionName });
      },
      reSummarize: NEVER_RESUMMARIZED,
      logger: SILENT_LOGGER,
    })({
      toolName: "customers_deleteCustomer",
      kind: "confirmation",
      value: approvedFrom({
        actionName: ATTEMPT.actionName,
        canonicalInput: ATTEMPT.input,
        idempotencyKey: ATTEMPT.idempotencyKey,
        challengeId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
        also: [SECOND_ALSO],
      }),
      tools: {},
      context: ANSWER_CONTEXT,
    });

    expect(ran).toEqual([ATTEMPT.actionName, SECOND_ATTEMPT.actionName]);
    expect(outcome).toMatchObject({ kind: "ok" });
  });

  it("runs a pause whose stored secret carries no also list", async () => {
    const seen: string[] = [];

    const outcome = await createResolveAnswer({
      runConfirmed: (args) => {
        seen.push(args.actionName);
        return Promise.resolve({ id: CUSTOMER_A });
      },
      reSummarize: NEVER_RESUMMARIZED,
      logger: SILENT_LOGGER,
    })({
      toolName: "customers_deleteCustomer",
      kind: "confirmation",
      value: approvedFrom(storedBeforeAlso()),
      tools: {},
      context: ANSWER_CONTEXT,
    });

    expect(seen).toEqual([ATTEMPT.actionName]);
    expect(outcome).toEqual({ kind: "ok", result: { id: CUSTOMER_A } });
  });

  it("has no answer that declines and still runs", () => {
    expect(confirmation.answer.safeParse({ approved: false }).success).toBe(
      false,
    );
    expect(confirmation.answer.safeParse({}).success).toBe(false);
  });

  it("stops the assistant on writes, loudly on high risk, and never on a draft", () => {
    expect(assistantPreviewLevel("write")).toBe("card");
    expect(assistantPreviewLevel("high")).toBe("strong");
    expect(assistantPreviewLevel("draft")).toBeUndefined();
    expect(assistantPreviewLevel("read")).toBeUndefined();
  });

  it("presents the stored attempt again, under its own key rather than the answer's", async () => {
    const seen: unknown[] = [];

    const outcome = await answerWith({
      runConfirmed: (args) => {
        seen.push(args);
        return Promise.resolve({ id: CUSTOMER_A });
      },
    });

    expect(outcome).toEqual({ kind: "ok", result: { id: CUSTOMER_A } });
    expect(seen).toEqual([
      {
        context: ANSWER_CONTEXT,
        actionName: ATTEMPT.actionName,
        input: ATTEMPT.input,
        idempotencyKey: ATTEMPT.idempotencyKey,
        challengeId: CHALLENGE.challengeId,
      },
    ]);
  });

  it("asks again when core issues a fresh challenge, instead of running", async () => {
    const fresh = {
      ...CHALLENGE,
      challengeId: "abababab-abab-4bab-8bab-abababababab",
    };

    const outcome = await answerWith({
      runConfirmed: () =>
        Promise.reject(
          new AssistantConfirmationRequired(
            ATTEMPT,
            new ConfirmationRequiredError(fresh),
          ),
        ),
    });

    expect(outcome).toMatchObject({
      kind: "pause",
      interaction: "confirmation",
      secret: {
        challengeId: fresh.challengeId,
        idempotencyKey: ATTEMPT.idempotencyKey,
      },
    });
  });

  it("reports a domain refusal after the approval as an error", async () => {
    const refusal = LEAKY_REFUSAL;

    const outcome = await answerWith({
      runConfirmed: () => Promise.reject(refusal),
    });

    expect(outcome).toEqual({
      kind: "error",
      code: refusal.code,
      message: refusal.clientMessage,
    });
    expect(refusal.message).toContain(ANOTHER_COMPANY);
    expect(JSON.stringify(outcome)).not.toContain(ANOTHER_COMPANY);
  });

  it("refuses a kind it has no resolver for instead of guessing one", async () => {
    const outcome = await createResolveAnswer(NEVER_CONFIRMED)({
      toolName: "anything",
      kind: "survey",
      value: {},
      tools: {},
      context: ANSWER_CONTEXT,
    });

    expect(outcome).toMatchObject({ kind: "error", code: "CONFLICT" });
  });
});

describe("an idempotent write is given a key that survives a retry", () => {
  it("is the same for a retry of one command, and different per action", () => {
    // Found by running the path for real: without this, `orders.create` is a
    // flat VALIDATION and the assistant explains an internal failure to the
    // staff member. Seventy-eight green tests did not catch it, because none of
    // them called the real pipeline.
    const command = {
      conversationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      commandId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    };

    const first = assistantKitIdempotencyKey(
      command,
      ORDERS_CREATE_ACTION_NAME,
    );
    const retry = assistantKitIdempotencyKey(
      command,
      ORDERS_CREATE_ACTION_NAME,
    );
    const otherAction = assistantKitIdempotencyKey(command, "orders.list");
    const otherCommand = assistantKitIdempotencyKey(
      { ...command, commandId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
      ORDERS_CREATE_ACTION_NAME,
    );

    expect(first).toBe(retry);
    expect(first).not.toBe(otherAction);
    expect(first).not.toBe(otherCommand);
    // Never the model's own tool call id: it is regenerated, so a retry of the
    // same tap would read as a new write.
    expect(first).not.toContain("toolu_");
  });
});

describe("a create option is offered but has no producer yet", () => {
  const CREATE_TOOL = "customers_create";

  const byOption: Record<string, ChoiceOptionSecret> = {
    [CUSTOMER_A]: { kind: "record", entityId: CUSTOMER_A },
    create: {
      kind: "create",
      toolName: CREATE_TOOL,
      input: { name: "Галина" },
    },
  };

  const secret: ChoiceSecret = {
    byOption,
    toolName: ORDERS_CREATE_TOOL_NAME,
    input: CREATE_BY_QUERY,
    target: { kind: "customer", query: "Галя" },
  };

  it("refuses a create answer rather than resolving it to a write", () => {
    expect(choice.resolve({ answer: { optionId: "create" }, secret })).toEqual({
      kind: "unresolvable",
      reason: "create option create has no producer",
    });
  });

  it("leaves a record option settling the ambiguity the tool hit", () => {
    expect(
      choice.resolve({ answer: { optionId: CUSTOMER_A }, secret }),
    ).toEqual({
      kind: "resolved",
      value: {
        entityId: CUSTOMER_A,
        toolName: ORDERS_CREATE_TOOL_NAME,
        input: CREATE_BY_QUERY,
        target: { kind: "customer", query: "Галя" },
      },
    });
  });

  it("refuses an option the picker never offered, and keeps the card open", () => {
    expect(choice.resolve({ answer: { optionId: "nope" }, secret }).kind).toBe(
      "unresolvable",
    );
  });

  it.each(["constructor", "toString", "valueOf", "__proto__"])(
    "refuses the inherited key %s rather than reading Object.prototype",
    (optionId) => {
      expect(choice.resolve({ answer: { optionId }, secret })).toEqual({
        kind: "unresolvable",
        reason: `unknown option ${optionId}`,
      });
    },
  );
});

const NEAREST_GALYA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function unmatchedCustomer(
  options: readonly { id: string; label: string }[],
): NotFoundError {
  return Object.assign(new NotFoundError('Nothing matches "Галя".'), {
    reason: "unmatched_query",
    target: { kind: "customer", query: "Галя" },
    options,
    optionsTruncated: false,
  });
}

describe("«знайди X» with nothing matching", () => {
  it("passes a plain not-found through as an error", async () => {
    const set = tools(() => Promise.reject(new NotFoundError()));

    const outcome = await run(set, CUSTOMERS_GET_CUSTOMER_TOOL_NAME, {
      customerQuery: "Галя",
    });

    expect(outcome.kind).toBe("error");
  });

  it("pauses on the nearest customers plus create", async () => {
    const set = tools(() =>
      Promise.reject(
        unmatchedCustomer([{ id: NEAREST_GALYA, label: "Галина" }]),
      ),
    );

    const outcome = await run(set, CUSTOMERS_GET_CUSTOMER_TOOL_NAME, {
      customerQuery: "Галя",
    });

    expect(outcome.kind).toBe("pause");
    if (outcome.kind !== "pause") return;
    expect(outcome.prompt).toEqual({
      subject: "Галя",
      optionsTruncated: false,
      nearest: true,
      problem: "Nothing matches that exactly.",
      options: [
        { optionId: NEAREST_GALYA, label: "Галина", kind: "record" },
        { optionId: "create", label: "Галя", kind: "create" },
      ],
    });
    const secret = outcome.secret as ChoiceSecret;
    expect(secret.target).toEqual({ kind: "customer", query: "Галя" });
    expect(choice.resolve({ answer: { optionId: "create" }, secret })).toEqual({
      kind: "unresolvable",
      reason: "create option create has no producer",
    });
  });
});

describe("the domain option cap fits the choice card", () => {
  it("never offers more options than a choice card may carry", () => {
    expect(ENTITY_LOOKUP_OPTIONS_MAX).toBeLessThanOrEqual(
      ASSISTANT_CHOICE_OPTIONS_MAX,
    );
  });
});

describe("a chosen product settles a product lookup", () => {
  it("replaces the product query the lookup was ambiguous about", () => {
    const patched = withChosenId(
      { productQuery: "Наполеон" },
      { kind: "product", query: "Наполеон" },
      ORDER_ID,
    );

    expect(patched.kind).toBe("patched");
    if (patched.kind !== "patched") return;
    expect(patched.input).toEqual({ productId: ORDER_ID });
  });
});
