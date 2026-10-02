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
import { assistantConfirmationPromptSchema } from "@showzy/validation/assistant-chat";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createActionRegistry } from "../registry.js";
import type { AssistantKitRuntime } from "./assistant-kit-http.js";
import { createAssistantKitRuntime } from "./assistant-kit-runtime.js";
import { testStaffProvider } from "@showzy/ai/test";

const DELETE_TOOL = "customers_deleteCustomer";
const DELETE_ACTION = "customers.deleteCustomer";
const UPDATE_TOOL = "customers_updateCustomer";
const UPDATE_ACTION = "customers.updateCustomer";

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
    provider: testStaffProvider,
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

function boris(conversationId: string): AssistantToolContext {
  return {
    ...request(conversationId),
    userId: kitIdentities.users.boris,
    companySelector: kitIdentities.companies.b,
  };
}

async function seedCustomer(
  status: "archived" | "active",
  name = "Катя Самбука",
): Promise<string> {
  const id = randomUUID();
  await kit.db.runtime.db.insert(companyCustomers).values({
    id,
    companyId: kitIdentities.companies.a,
    name,
    email: `katya-${randomUUID()}@example.com`,
    status,
  });
  return id;
}

async function archivedCustomer(): Promise<string> {
  return await seedCustomer("archived");
}

async function storedName(id: string): Promise<string | undefined> {
  const found = await kit.db.runtime.db
    .select({ name: companyCustomers.name })
    .from(companyCustomers)
    .where(eq(companyCustomers.id, id));
  return found[0]?.name;
}

async function customerExists(id: string): Promise<boolean> {
  const found = await kit.db.runtime.db
    .select({ id: companyCustomers.id })
    .from(companyCustomers)
    .where(eq(companyCustomers.id, id));
  return found.length === 1;
}

/** The model's tool call, run the way the host runs it. */
async function call(
  runtime: AssistantKitRuntime,
  context: AssistantToolContext,
  toolName: string,
  input: unknown,
): Promise<ToolOutcome> {
  const tools = await runtime.tools(context);
  const execute = tools[toolName]?.execute;
  if (execute === undefined) {
    throw new Error(`${toolName} is not offered to an owner`);
  }
  return (await execute(input, {
    toolCallId: `toolu_${toolName}`,
    messages: [],
  } as never)) as ToolOutcome;
}

async function ask(
  runtime: AssistantKitRuntime,
  context: AssistantToolContext,
  toolName: string,
  input: unknown,
): Promise<Pause> {
  const outcome = await call(runtime, context, toolName, input);
  if (outcome.kind !== "pause") {
    throw new Error(`expected a pause, got ${outcome.kind}`);
  }
  return outcome;
}

async function askToDelete(
  runtime: AssistantKitRuntime,
  context: AssistantToolContext,
  customerId: string,
): Promise<Pause> {
  return await ask(runtime, context, DELETE_TOOL, { id: customerId });
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
    const prompt = assistantConfirmationPromptSchema.parse(pause.prompt);
    expect(prompt.summary).toBe(prompt.preview.title);
    expect(prompt.preview.title).toContain("Катя Самбука");
    expect(prompt.preview.lines.length).toBeGreaterThan(0);
    expect(prompt.preview.notes.length).toBeGreaterThan(0);
    expect(prompt.level).toBe("strong");
    expect(prompt.also).toEqual([]);
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

describe("a write the handler refused can be corrected in the same turn", () => {
  it("gives the corrected call its own key, and keeps one key for an untouched retry", async () => {
    const id = await seedCustomer("active");
    const runtime = runtimeWithChallenges();
    const context = request(randomUUID());
    const update = (input: unknown) =>
      call(runtime, context, UPDATE_TOOL, input);
    const fields = { name: "Катерина Самбука" };

    const missing = await update({ id: randomUUID(), ...fields });
    expect(missing).toMatchObject({ kind: "error", code: "NOT_FOUND" });

    const corrected = await update({ id, ...fields });
    expect(corrected).toMatchObject({ kind: "pause" });
    const again = await update({ id, ...fields });
    expect(again).toMatchObject({ kind: "pause" });
    expect(await storedName(id)).toBe("Катя Самбука");

    const confirmed = await answer(
      runtime,
      request(randomUUID()),
      approve(corrected as Pause),
    );
    expect(confirmed).toMatchObject({ kind: "ok" });
    expect(await storedName(id)).toBe("Катерина Самбука");

    expect(assistantKitIdempotencyKey(context, UPDATE_ACTION)).not.toBe(
      assistantKitIdempotencyKey(context, UPDATE_ACTION, 1),
    );
  });
});

describe("an ordinary write the assistant makes", () => {
  it("pauses on its card, writes nothing while it is open, and runs once approved", async () => {
    const runtime = runtimeWithChallenges();
    const id = await seedCustomer("active");

    const pause = await ask(runtime, request(randomUUID()), UPDATE_TOOL, {
      id,
      name: "Катерина Самбука",
    });

    const prompt = assistantConfirmationPromptSchema.parse(pause.prompt);
    expect(prompt.level).toBe("card");
    expect(prompt.preview.title).toContain("Катя Самбука");
    expect(prompt.preview.lines.length).toBeGreaterThan(0);
    expect(await storedName(id)).toBe("Катя Самбука");

    const outcome = await answer(
      runtime,
      request(randomUUID()),
      approve(pause),
    );

    expect(outcome).toMatchObject({ kind: "ok" });
    expect(await storedName(id)).toBe("Катерина Самбука");
  });

  it("refuses a challenge presented from another company, and writes nothing", async () => {
    const runtime = runtimeWithChallenges();
    const id = await seedCustomer("active");
    const pause = await ask(runtime, request(randomUUID()), UPDATE_TOOL, {
      id,
      name: "Катерина Самбука",
    });

    const outcome = await answer(runtime, boris(randomUUID()), approve(pause));

    expect(outcome).not.toMatchObject({ kind: "ok" });
    expect(await storedName(id)).toBe("Катя Самбука");
  });

  it("asks again with the new card when the record moved under it, then runs once", async () => {
    const runtime = runtimeWithChallenges();
    const id = await seedCustomer("active");
    const pause = await ask(runtime, request(randomUUID()), UPDATE_TOOL, {
      id,
      name: "Катерина Самбука",
    });

    await kit.db.runtime.db
      .update(companyCustomers)
      .set({ name: "Катя С." })
      .where(eq(companyCustomers.id, id));

    const drifted = await answer(
      runtime,
      request(randomUUID()),
      approve(pause),
    );

    expect(drifted).toMatchObject({ kind: "pause" });
    const again = drifted as Pause;
    const secret = again.secret as ConfirmationSecret;
    const first = pause.secret as ConfirmationSecret;
    expect(secret.challengeId).not.toBe(first.challengeId);
    expect(secret.idempotencyKey).toBe(first.idempotencyKey);
    expect(
      assistantConfirmationPromptSchema.parse(again.prompt).preview.title,
    ).toContain("Катя С.");
    expect(await storedName(id)).toBe("Катя С.");

    const outcome = await answer(
      runtime,
      request(randomUUID()),
      approve(again),
    );

    expect(outcome).toMatchObject({ kind: "ok" });
    expect(await storedName(id)).toBe("Катерина Самбука");
  });
});
