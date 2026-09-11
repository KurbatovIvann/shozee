/**
 * SHO-553. Both halves of a confirmation, against core's real protocol.
 *
 * The unit suites prove each adaptation with a fake on the other side. This one
 * exists because what matters is neither side alone: it is whether what the
 * pause keeps is exactly what core bound the challenge to. A resume that
 * presented one field differently — another idempotency key, an input that did
 * not survive JSON — would not fail loudly. Core would issue a fresh challenge,
 * the person would see the card again, and nothing would ever run.
 *
 * So the challenge, its store and the action are real: `customers.deleteCustomer`
 * against a seeded archived customer, driven through `createAssistantKitRuntime`.
 */
import { randomUUID } from "node:crypto";

import type { ToolOutcome } from "@showzy/assistant-kit";
import {
  assistantKitIdempotencyKey,
  confirmation,
  type AssistantToolContext,
  type ConfirmationSecret,
} from "@showzy/assistant-runtime";
import {
  createConfirmationHook,
  createInMemoryConfirmationStore,
  type ActionPipelineDeps,
} from "@showzy/core";
import {
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { companyCustomers } from "@showzy/db/schema/customers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createActionRegistry } from "../composition.js";
import type { AssistantKitRuntime } from "./assistant-kit-http.js";
import { createAssistantKitRuntime } from "./assistant-kit-runtime.js";

const DELETE_TOOL = "customers_deleteCustomer";
const DELETE_ACTION = "customers.deleteCustomer";

type Pause = Extract<ToolOutcome, { kind: "pause" }>;

let kit: TestKit;

/**
 * A runtime whose pipeline issues real challenges. One per test: the call that
 * asks and the answer that resumes must share a challenge store, as they share
 * Redis in production.
 */
function runtimeWithChallenges(): AssistantKitRuntime {
  const pipeline: ActionPipelineDeps = {
    ...kit.pipeline,
    hooks: {
      ...kit.pipeline.hooks,
      confirmation: createConfirmationHook({
        store: createInMemoryConfirmationStore(),
      }),
    },
  };
  return createAssistantKitRuntime({
    auth: { api: { getSession: () => Promise.resolve(null) } },
    registry: createActionRegistry(),
    pipeline,
    model: "mock",
    // Tools and answers only: nothing here opens or claims a pause.
    redis: {} as never,
  });
}

/** Anna, in her own company. Every request carries its own command. */
function request(conversationId: string): AssistantToolContext {
  return {
    userId: kitIdentities.users.anna,
    companySelector: kitIdentities.companies.a,
    conversationId,
    commandId: randomUUID(),
    requestId: randomUUID(),
    clientIp: "127.0.0.1",
  };
}

async function archivedCustomer(): Promise<string> {
  const id = randomUUID();
  await kit.db.runtime.db.insert(companyCustomers).values({
    id,
    companyId: kitIdentities.companies.a,
    name: "Катя Самбука",
    email: `katya-${id}@example.com`,
    status: "archived",
  });
  return id;
}

async function customerExists(id: string): Promise<boolean> {
  const found = await kit.db.admin.query(
    "select 1 from company_customers where id = $1",
    [id],
  );
  return found.rowCount === 1;
}

/** The model's tool call, run the way the host runs it. */
async function askToDelete(
  runtime: AssistantKitRuntime,
  context: AssistantToolContext,
  customerId: string,
): Promise<Pause> {
  const tools = await runtime.tools(context);
  const execute = tools[DELETE_TOOL]?.execute;
  if (execute === undefined) {
    throw new Error(`${DELETE_TOOL} is not offered to an owner`);
  }
  const outcome = (await execute({ id: customerId }, {
    toolCallId: "toolu_delete",
    messages: [],
  } as never)) as ToolOutcome;
  if (outcome.kind !== "pause") {
    throw new Error(`expected a pause, got ${outcome.kind}`);
  }
  return outcome;
}

/**
 * What a claim hands the resolver. The pause store keeps the secret as JSON, so
 * it goes through JSON here too: that round trip is one of the ways a resume
 * could stop matching what core hashed.
 */
function approve(pause: Pause): unknown {
  const secret = JSON.parse(JSON.stringify(pause.secret)) as ConfirmationSecret;
  const resolution = confirmation.resolve({
    answer: { approved: true },
    secret,
  });
  if (resolution.kind !== "resolved") {
    throw new Error("a confirmation always resolves");
  }
  return resolution.value;
}

async function answer(
  runtime: AssistantKitRuntime,
  context: AssistantToolContext,
  value: unknown,
): Promise<ToolOutcome> {
  return await runtime.resolveAnswer({
    toolName: DELETE_TOOL,
    kind: "confirmation",
    value,
    tools: await runtime.tools(context),
    context,
  });
}

beforeAll(async () => {
  kit = await createTestKit();
}, 180_000);

afterAll(async () => {
  await kit.db.close();
});

describe("a delete the assistant asks for", () => {
  it("waits for the person, and runs once they confirm", async () => {
    const runtime = runtimeWithChallenges();
    const conversationId = randomUUID();
    const customerId = await archivedCustomer();

    const pause = await askToDelete(
      runtime,
      request(conversationId),
      customerId,
    );

    expect(pause.interaction).toBe("confirmation");
    expect(await customerExists(customerId)).toBe(true);
    // Core's redacted summary, and nothing about the record or the attempt.
    expect(pause.prompt).toEqual({ summary: expect.any(String) as unknown });
    expect(JSON.stringify(pause.prompt)).not.toContain("Катя");
    expect(JSON.stringify(pause.prompt)).not.toContain(customerId);

    // A separate request with its own command, as a real answer is.
    const outcome = await answer(
      runtime,
      request(conversationId),
      approve(pause),
    );

    expect(outcome).toEqual({ kind: "ok", result: { id: customerId } });
    expect(await customerExists(customerId)).toBe(false);
  });

  /**
   * A second real run would find nothing to delete and answer `NOT_FOUND`, and
   * a refused replay would ask again — either one differs from the first answer.
   */
  it("replays rather than running again when a confirmed answer is retried", async () => {
    const runtime = runtimeWithChallenges();
    const conversationId = randomUUID();
    const customerId = await archivedCustomer();
    const pause = await askToDelete(
      runtime,
      request(conversationId),
      customerId,
    );
    const approval = approve(pause);

    const first = await answer(runtime, request(conversationId), approval);
    const retry = await answer(runtime, request(conversationId), approval);

    expect(first).toEqual({ kind: "ok", result: { id: customerId } });
    expect(retry).toEqual(first);
  });

  /**
   * The failure this design exists to prevent, forced on purpose: the approval
   * presented under the answer's own idempotency key instead of the stored one.
   */
  it("asks again, and runs nothing, when the attempt presented is not the one core challenged", async () => {
    const runtime = runtimeWithChallenges();
    const conversationId = randomUUID();
    const customerId = await archivedCustomer();
    const pause = await askToDelete(
      runtime,
      request(conversationId),
      customerId,
    );

    const answering = request(conversationId);
    const recomputed = {
      ...(approve(pause) as Record<string, unknown>),
      idempotencyKey: assistantKitIdempotencyKey(answering, DELETE_ACTION),
    };
    const refused = await answer(runtime, answering, recomputed);

    expect(refused).toMatchObject({
      kind: "pause",
      interaction: "confirmation",
    });
    expect(await customerExists(customerId)).toBe(true);

    // And the challenge presented wrongly is spent, not left to be retried.
    const late = await answer(runtime, request(conversationId), approve(pause));
    expect(late).toMatchObject({ kind: "pause", interaction: "confirmation" });
    expect(await customerExists(customerId)).toBe(true);
  });
});
