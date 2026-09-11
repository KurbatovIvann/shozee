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
  confirmation,
  createResolveAnswer,
  withChosenId,
  type AssistantToolLogger,
  type ChoiceSecret,
  type ResolveAnswerDeps,
} from "@showzy/assistant-runtime";
import { ConflictError, NotFoundError } from "@showzy/core/errors";
import { describe, expect, it } from "vitest";

import { createActionRegistry } from "../composition.js";

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
    staffAssistantTools(CONTRACTS, execute),
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
const NEVER_CONFIRMED: ResolveAnswerDeps = {
  runConfirmed: () =>
    Promise.reject(new Error("no confirmation was expected here")),
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
  const CHALLENGE = {
    challengeId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    summary: "The customer will be deleted permanently.",
    expiresAt: "2026-09-10T12:05:00.000Z",
  };

  /** What a claim hands the resolver, produced by the kind's own `resolve`. */
  function approved(): unknown {
    const resolution = confirmation.resolve({
      answer: { approved: true },
      secret: {
        actionName: ATTEMPT.actionName,
        canonicalInput: ATTEMPT.input,
        idempotencyKey: ATTEMPT.idempotencyKey,
        challengeId: CHALLENGE.challengeId,
      },
    });
    if (resolution.kind !== "resolved") {
      throw new Error("a confirmation always resolves");
    }
    return resolution.value;
  }

  function answerWith(deps: ResolveAnswerDeps): Promise<ToolOutcome> {
    return createResolveAnswer(deps)({
      toolName: "customers_deleteCustomer",
      kind: "confirmation",
      value: approved(),
      // Nothing is looked up by tool name: the stored attempt says what runs.
      tools: {},
      context: ANSWER_CONTEXT,
    });
  }

  it("pauses on a confirmation that shows the summary and keeps the attempt server-side", async () => {
    const set = tools(() =>
      Promise.reject(new AssistantConfirmationRequired(ATTEMPT, CHALLENGE)),
    );

    const outcome = await run(set, "customers_deleteCustomer", {
      id: CUSTOMER_A,
    });

    expect(outcome).toEqual({
      kind: "pause",
      interaction: "confirmation",
      prompt: { summary: CHALLENGE.summary },
      secret: {
        actionName: ATTEMPT.actionName,
        canonicalInput: ATTEMPT.input,
        idempotencyKey: ATTEMPT.idempotencyKey,
        challengeId: CHALLENGE.challengeId,
      },
    });
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
        Promise.reject(new AssistantConfirmationRequired(ATTEMPT, fresh)),
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
    const refusal = new NotFoundError();

    const outcome = await answerWith({
      runConfirmed: () => Promise.reject(refusal),
    });

    expect(outcome).toMatchObject({ kind: "error", code: refusal.code });
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
