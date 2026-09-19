import { randomUUID } from "node:crypto";

import type { ToolOutcome } from "@showzy/assistant-kit";
import type { AssistantToolContext } from "@showzy/assistant-runtime";
import {
  createTestKit,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import {
  companyCustomers,
  customerGroups,
} from "@showzy/db/schema/customers";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createActionRegistry } from "../registry.js";
import type { AssistantKitRuntime } from "./assistant-kit-http.js";
import { createAssistantKitRuntime } from "./assistant-kit-runtime.js";

const LIST_TOOL = "customers_list_customers";
const UPDATE_TOOL = "customers_updateCustomer";
const KEPT_NOTE = "Дзвонити після 18:00";

type CompactCustomerRow = {
  readonly id: string;
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
};

let kit: TestKit;

function runtime(): AssistantKitRuntime {
  return createAssistantKitRuntime({
    auth: { api: { getSession: () => Promise.resolve(null) } },
    registry: createActionRegistry(),
    pipeline: kit.pipeline,
    model: "mock",
    redis: {} as never,
  });
}

function request(): AssistantToolContext {
  return {
    userId: kitIdentities.users.anna,
    companySelector: kitIdentities.companies.a,
    conversationId: randomUUID(),
    commandId: randomUUID(),
    requestId: randomUUID(),
    clientIp: "127.0.0.1",
  };
}

async function seededCustomer(name: string): Promise<string> {
  const id = randomUUID();
  await kit.db.runtime.db.insert(companyCustomers).values({
    id,
    companyId: kitIdentities.companies.a,
    name,
    phone: "0670000101",
    email: `${id}@example.com`,
    notes: KEPT_NOTE,
  });
  return id;
}

async function seededGroup(): Promise<string> {
  const id = randomUUID();
  await kit.db.runtime.db.insert(customerGroups).values({
    id,
    companyId: kitIdentities.companies.a,
    name: `VIP ${id}`,
    slug: `vip-${id}`,
  });
  return id;
}

async function storedCustomer(id: string) {
  const found = await kit.db.runtime.db
    .select({
      phone: companyCustomers.phone,
      email: companyCustomers.email,
      notes: companyCustomers.notes,
      groupId: companyCustomers.groupId,
    })
    .from(companyCustomers)
    .where(eq(companyCustomers.id, id));
  return found[0];
}

async function callTool(
  context: AssistantToolContext,
  toolName: string,
  input: unknown,
): Promise<unknown> {
  const tools = await runtime().tools(context);
  const execute = tools[toolName]?.execute;
  if (execute === undefined) {
    throw new Error(`${toolName} is not offered to an owner`);
  }
  const outcome = (await execute(input, {
    toolCallId: `toolu_${randomUUID()}`,
    messages: [],
  } as never)) as ToolOutcome;
  if (outcome.kind !== "ok") {
    throw new Error(`${toolName} ended ${outcome.kind}`);
  }
  return outcome.result;
}

async function listedRow(
  context: AssistantToolContext,
  name: string,
  id: string,
): Promise<CompactCustomerRow> {
  const page = (await callTool(context, LIST_TOOL, { search: name })) as {
    readonly items: readonly CompactCustomerRow[];
  };
  const row = page.items.find((item) => item.id === id);
  if (row === undefined) {
    throw new Error(`${name} is not on the listed page`);
  }
  return row;
}

beforeAll(async () => {
  kit = await createTestKit();
}, 180_000);

afterAll(async () => {
  await kit.db.close();
});

describe("a customer edit the assistant makes from a listed row", () => {
  it("keeps notes and email when only the phone is changed", async () => {
    const name = `Наталія Гук ${randomUUID()}`;
    const id = await seededCustomer(name);
    const context = request();
    const row = await listedRow(context, name, id);

    await callTool(context, UPDATE_TOOL, {
      id: row.id,
      name: row.name,
      phone: "0671112233",
    });

    const stored = await storedCustomer(id);
    expect(stored?.phone).toBe("0671112233");
    expect(stored?.email).toBe(`${id}@example.com`);
    expect(stored?.notes).toBe(KEPT_NOTE);
  });

  it("keeps notes when the customer is added to a group", async () => {
    const name = `Тетяна Мороз ${randomUUID()}`;
    const id = await seededCustomer(name);
    const groupId = await seededGroup();
    const context = request();
    const row = await listedRow(context, name, id);

    await callTool(context, UPDATE_TOOL, {
      id: row.id,
      name: row.name,
      phone: row.phone,
      email: row.email,
      groupId,
    });

    const stored = await storedCustomer(id);
    expect(stored?.groupId).toBe(groupId);
    expect(stored?.notes).toBe(KEPT_NOTE);
  });
});
