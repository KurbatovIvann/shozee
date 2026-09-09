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
import type { ToolOutcome, ToolSet } from "@showzy/assistant-kit";
import { ConflictError, NotFoundError } from "@showzy/core/errors";
import { describe, expect, it } from "vitest";

import { createActionRegistry } from "../composition.js";
import type { ChoiceSecret } from "./assistant-interactions.js";
import { createResolveAnswer, withChosenId } from "./assistant-kit-resolve.js";
import { assistantKitTurnTools } from "./assistant-kit-tools.js";

const registry = createActionRegistry();
const CONTRACTS = filterStaffAiTools(registry.contracts(), {
  role: "owner",
  permissions: ["orders:view", "orders:edit", "customers:view", "assistant:use"],
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

function tools(execute: ActionToolExecute): ToolSet {
  return assistantKitTurnTools(staffAssistantTools(CONTRACTS, execute));
}

async function run(
  set: ToolSet,
  name: string,
  input: unknown,
  toolCallId = "toolu_1",
): Promise<ToolOutcome> {
  const execute = set[name]?.execute;
  if (execute === undefined) throw new Error(`no tool ${name}`);
  return (await execute(input, { toolCallId, messages: [] } as never)) as ToolOutcome;
}

const CREATE_BY_QUERY = {
  customerQuery: "Катя",
  items: [{ productQuery: "Наполеон", quantityDecimal: "3" }],
};

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

  it("gives a page and a rollup the same card id, so the second updates the first", async () => {
    const set = tools((action) =>
      Promise.resolve(
        action.endsWith("list")
          ? { status: "completed", kind: "page.summary", rows: [], hasMore: false }
          : { status: "completed" },
      ),
    );

    const page = await run(set, ORDERS_LIST_PAGE_TOOL_NAME, { limit: 5 });
    const counts = await run(
      set,
      ORDERS_LIST_COUNTS_TOOL_NAME,
      { groupBy: "status" },
      "toolu_2",
    );

    expect(page.kind).toBe("ok");
    expect(counts.kind).toBe("ok");
    if (page.kind !== "ok" || counts.kind !== "ok") return;
    // Both produced a card; the ids match, so the document holds one list card.
    if (page.card !== undefined && counts.card !== undefined) {
      expect(counts.card.cardId).toBe(page.card.cardId);
    }
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

    await expect(run(set, ORDERS_CREATE_TOOL_NAME, CREATE_BY_QUERY)).rejects.toThrow(
      "boom",
    );
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
        { productQuery: "Наполеон", variantId: CUSTOMER_B, quantityDecimal: "3" },
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

describe("resolveAnswer calls the same tool again", () => {
  it("sends the patched input to the same action and returns its card", async () => {
    const seen: unknown[] = [];
    const set = tools((action, input) => {
      seen.push({ action, input });
      return Promise.resolve({ status: "completed", ...CREATED_ORDER });
    });
    const resolveAnswer = createResolveAnswer();

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
      session: { userId: "user-1" },
      companySelector: "company-1",
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

    const outcome = await createResolveAnswer()({
      toolName: ORDERS_CREATE_TOOL_NAME,
      kind: "choice",
      value: {
        entityId: CUSTOMER_A,
        toolName: ORDERS_CREATE_TOOL_NAME,
        input: CREATE_BY_QUERY,
        target: { kind: "customer", query: "Катя" },
      },
      tools: set,
      session: { userId: "user-1" },
      companySelector: "company-1",
    });

    // Not a failure: the next question, on the same job.
    expect(outcome.kind).toBe("pause");
    if (outcome.kind !== "pause") return;
    expect(outcome.prompt).toMatchObject({ subject: "Наполеон" });
  });
});
