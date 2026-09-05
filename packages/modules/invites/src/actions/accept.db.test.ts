import { randomUUID } from "node:crypto";

import { defineActionContract } from "@showzy/core/contract";
import {
  defineEventHandler,
  eventEnvelopeSchema,
  implementAction,
} from "@showzy/core";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "@showzy/core/errors";
import {
  createCapturingLogger,
  createTestKit,
  crossTenantSuite,
  eventSuite,
  idempotencySuite,
  isolationCase,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { auditLog, domainEvents, eventDeliveries } from "@showzy/db";
import { user } from "@showzy/db/schema/auth";
import { orderCards } from "@showzy/db/schema/chat";
import {
  companyCustomers,
  counterparties,
  customerGroups,
} from "@showzy/db/schema/customers";
import {
  companyCustomerInviteRedemptions,
  companyCustomerInvites,
} from "@showzy/db/schema/invites";
import { priceLists } from "@showzy/db/schema/pricing";
import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { acceptInvite } from "./accept.js";
import { createInvite } from "./create.js";
import { invitesAccepted } from "../events/accepted.js";
import {
  acceptCustomerInvite,
  acceptInviteColumns,
  assertCustomerAcceptCtx,
} from "../services/accept-invite.js";
import { hashInviteToken } from "../services/token-hash.js";

const TEST_ACCEPTED_CONSUMER = "invites.test-accepted-noop";
const NOT_FOUND_MESSAGE = "The requested resource was not found.";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const UNLINKED_PHONE = "+380501998877";
const UNLINKED_EMAIL = "unlinked-invite@kit.test";

function isoFromNow(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

const futureExpiry = isoFromNow(7 * DAY_MS);

function invitePlaintext(id: string): string {
  return `invite-row-${id}`;
}

const fixtures = {
  groupA: randomUUID(),
  groupA2: randomUUID(),
  groupB: randomUUID(),
  listA: randomUUID(),
  listA2: randomUUID(),
  listB: randomUUID(),
  isolationPersonal: randomUUID(),
  idemAccept: randomUUID(),
  idemAcceptConflict: randomUUID(),
  idemAcceptFresh: randomUUID(),
  eventAccept: randomUUID(),
  expired: randomUUID(),
  revoked: randomUUID(),
  exhaustedOther: randomUUID(),
};

const acceptors = {
  fresh: randomUUID(),
  linked: randomUUID(),
  unlinked: randomUUID(),
  reusable1: randomUUID(),
  reusable2: randomUUID(),
  archived: randomUUID(),
  replayArchived: randomUUID(),
  fill: randomUUID(),
  keep: randomUUID(),
  conflict: randomUUID(),
  tenant: randomUUID(),
  nameless: randomUUID(),
  guardNonPending: randomUUID(),
};

let kit: TestKit;

function objectKeys(value: unknown): string[] {
  const keys: string[] = [];
  const walk = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      for (const item of entry) {
        walk(item);
      }
      return;
    }
    if (entry !== null && typeof entry === "object") {
      for (const [key, child] of Object.entries(entry)) {
        keys.push(key);
        walk(child);
      }
    }
  };
  walk(value);
  return keys;
}

function expectNoInviteSecrets(value: unknown): void {
  expect(objectKeys(value)).not.toContain("token");
  expect(objectKeys(value)).not.toContain("tokenHash");
}

async function countRedemptions(companyId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ value: count() })
    .from(companyCustomerInviteRedemptions)
    .where(eq(companyCustomerInviteRedemptions.companyId, companyId));
  return rows[0]?.value ?? 0;
}

async function inviteRow(inviteId: string) {
  const rows = await kit.db.runtime.db
    .select()
    .from(companyCustomerInvites)
    .where(eq(companyCustomerInvites.id, inviteId));
  return rows[0];
}

async function customerByUser(companyId: string, userId: string) {
  const rows = await kit.db.runtime.db
    .select()
    .from(companyCustomers)
    .where(
      and(
        eq(companyCustomers.companyId, companyId),
        eq(companyCustomers.userId, userId),
      ),
    );
  return rows[0];
}

async function processedDeliveries(consumer: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ eventId: eventDeliveries.eventId })
    .from(eventDeliveries)
    .where(
      and(
        eq(eventDeliveries.consumer, consumer),
        eq(eventDeliveries.status, "processed"),
      ),
    );
  return rows.length;
}

const emitAcceptedThenFail = implementAction(
  defineActionContract({
    name: "invites.emitAcceptedThenFail",
    description:
      "Test-local emitter that fails after buffering invites.accepted.",
    principal: "customer",
    transport: "internal",
    input: z.object({
      inviteId: z.uuid(),
      customerId: z.uuid(),
    }),
    output: z.object({ inviteId: z.uuid() }),
    permissions: [],
    aiExposure: "internal",
    risk: "write",
    requiresConfirmation: false,
    idempotent: true,
    emits: ["invites.accepted"],
    atomicCalls: [],
    atomicCallers: [],
    audit: true,
    timeout: 5_000,
  }),
  {
    resolveTarget: () =>
      Promise.resolve({
        companyId: kitIdentities.companies.a,
        resource: { companyId: kitIdentities.companies.a },
      }),
    handler: (input, ctx) => {
      ctx.emit(invitesAccepted, {
        aggregate: { type: "invite", id: input.inviteId },
        payload: {
          inviteId: input.inviteId,
          customerId: input.customerId,
          created: true,
        },
      });
      throw new ConflictError("Injected emit-then-fail.");
    },
    auditTarget: () => ({ type: "invite", id: "test-accepted-fail" }),
  },
);

const projectAcceptedTest = implementAction(
  defineActionContract({
    name: "invites.projectAcceptedTest",
    description: "Test-local no-op consumer of invites.accepted.",
    principal: "system",
    systemScope: "tenant",
    transport: "internal",
    input: eventEnvelopeSchema(invitesAccepted.payload),
    output: z.object({ ok: z.literal(true) }),
    permissions: [],
    aiExposure: "internal",
    risk: "write",
    requiresConfirmation: false,
    idempotent: true,
    emits: [],
    atomicCalls: [],
    atomicCallers: [],
    audit: true,
    timeout: 5_000,
  }),
  {
    handler: () => {
      return Promise.resolve({ ok: true as const });
    },
    auditTarget: () => ({ type: "invite", id: "test-accepted-noop" }),
  },
);

const acceptedNoop = defineEventHandler({
  event: invitesAccepted,
  consumer: TEST_ACCEPTED_CONSUMER,
  action: projectAcceptedTest,
});

const acceptNonPendingDirect = implementAction(
  defineActionContract({
    name: "invites.acceptNonPendingDirect",
    description:
      "Test-local accept that resolves a token even when derived status is not pending, so the handler pending-guard can be proven before CRM.",
    principal: "customer",
    transport: "internal",
    input: z.strictObject({ token: z.string().min(1) }),
    output: z.strictObject({
      inviteId: z.uuid(),
      customerId: z.uuid(),
      created: z.boolean(),
    }),
    permissions: [],
    aiExposure: "internal",
    risk: "write",
    requiresConfirmation: false,
    idempotent: true,
    emits: [],
    atomicCalls: [],
    atomicCallers: [],
    audit: true,
    timeout: 10_000,
  }),
  {
    resolveTarget: async (input, env) => {
      if (env.principal.mode !== "customer") {
        throw new NotFoundError();
      }
      const row = (
        await env.tx
          .select(acceptInviteColumns)
          .from(companyCustomerInvites)
          .where(
            eq(companyCustomerInvites.tokenHash, hashInviteToken(input.token)),
          )
          .limit(1)
      )[0];
      if (row === undefined) {
        throw new NotFoundError();
      }
      return { companyId: row.companyId, resource: row };
    },
    handler: async (_input, ctx) => {
      assertCustomerAcceptCtx(ctx);
      const result = await acceptCustomerInvite({ ctx });
      return {
        inviteId: result.inviteId,
        customerId: result.customerId,
        created: result.created,
      };
    },
    auditTarget: () => ({ type: "invite", id: "test-non-pending-direct" }),
  },
);

async function insertInvite(values: {
  readonly id: string;
  readonly companyId: string;
  readonly isReusable?: boolean;
  readonly maxUses?: number | null;
  readonly usesCount?: number;
  readonly expiresAt: Date;
  readonly status?: "pending" | "revoked";
  readonly groupId?: string | null;
  readonly priceListId?: string | null;
  readonly name?: string | null;
  readonly phone?: string | null;
  readonly email?: string | null;
}): Promise<void> {
  await kit.db.runtime.db.insert(companyCustomerInvites).values({
    id: values.id,
    companyId: values.companyId,
    invitedBy: kitIdentities.users.anna,
    tokenHash: hashInviteToken(invitePlaintext(values.id)),
    isReusable: values.isReusable ?? false,
    maxUses: values.maxUses === undefined ? 1 : values.maxUses,
    usesCount: values.usesCount ?? 0,
    expiresAt: values.expiresAt,
    status: values.status ?? "pending",
    groupId: values.groupId,
    priceListId: values.priceListId,
    name: values.name,
    phone: values.phone,
    email: values.email,
  });
}

beforeAll(async () => {
  kit = await createTestKit();
  const companyA = kitIdentities.companies.a;
  const companyB = kitIdentities.companies.b;
  const future = new Date(futureExpiry);
  const past = new Date("2020-01-01T00:00:00.000Z");

  await kit.db.runtime.db.insert(priceLists).values([
    { id: fixtures.listA, companyId: companyA, name: "Retail A" },
    { id: fixtures.listA2, companyId: companyA, name: "Wholesale A" },
    { id: fixtures.listB, companyId: companyB, name: "Retail B" },
  ]);
  await kit.db.runtime.db.insert(customerGroups).values([
    {
      id: fixtures.groupA,
      companyId: companyA,
      name: "Wholesale",
      slug: `wholesale-${fixtures.groupA}`,
    },
    {
      id: fixtures.groupA2,
      companyId: companyA,
      name: "Retail group",
      slug: `retail-${fixtures.groupA2}`,
    },
    {
      id: fixtures.groupB,
      companyId: companyB,
      name: "Foreign group",
      slug: `foreign-${fixtures.groupB}`,
    },
  ]);

  await kit.db.runtime.db.insert(user).values(
    Object.entries(acceptors).map(([key, id]) => ({
      id,
      name: `Acceptor ${key}`,
      email: `${key}@invite-accept.test`,
    })),
  );

  await insertInvite({
    id: fixtures.isolationPersonal,
    companyId: companyA,
    expiresAt: future,
    name: "Isolation accept",
  });
  await insertInvite({
    id: fixtures.idemAccept,
    companyId: companyA,
    expiresAt: future,
    name: "Idem accept",
  });
  await insertInvite({
    id: fixtures.idemAcceptConflict,
    companyId: companyA,
    expiresAt: future,
    name: "Idem accept conflict",
  });
  await insertInvite({
    id: fixtures.idemAcceptFresh,
    companyId: companyA,
    expiresAt: future,
    name: "Idem accept fresh",
  });
  await insertInvite({
    id: fixtures.eventAccept,
    companyId: companyA,
    expiresAt: future,
    name: "Event accept",
  });
  await insertInvite({
    id: fixtures.expired,
    companyId: companyA,
    expiresAt: past,
    name: "Expired accept",
  });
  await insertInvite({
    id: fixtures.revoked,
    companyId: companyA,
    expiresAt: future,
    status: "revoked",
    name: "Revoked accept",
  });
  await insertInvite({
    id: fixtures.exhaustedOther,
    companyId: companyA,
    expiresAt: future,
    maxUses: 1,
    usesCount: 1,
    name: "Exhausted other",
  });
});

afterAll(async () => {
  await kit.db.close();
});

crossTenantSuite(
  () => kit,
  [
    isolationCase(
      acceptInvite,
      { input: { token: invitePlaintext(fixtures.isolationPersonal) } },
      {
        input: { token: invitePlaintext(fixtures.isolationPersonal) },
        userId: kitIdentities.users.anna,
      },
    ),
  ],
);

idempotencySuite(
  () => kit,
  [
    {
      action: acceptInvite,
      input: { token: invitePlaintext(fixtures.idemAccept) },
      conflictingInput: {
        token: invitePlaintext(fixtures.idemAcceptConflict),
      },
      freshInput: () => ({
        token: invitePlaintext(fixtures.idemAcceptFresh),
      }),
      readEffect: () => countRedemptions(kitIdentities.companies.a),
    },
  ],
);

eventSuite(() => kit, {
  module: "invites",
  emitAction: acceptInvite,
  emitInput: { token: invitePlaintext(fixtures.eventAccept) },
  failingEmitAction: emitAcceptedThenFail,
  failingEmitInput: {
    inviteId: randomUUID(),
    customerId: randomUUID(),
  },
  eventName: "invites.accepted",
  subscription: acceptedNoop,
  readProjection: () => processedDeliveries(TEST_ACCEPTED_CONSUMER),
});

describe("invites.accept", () => {
  it("creates CRM on first accept and does not write counterparties or chat", async () => {
    const created = await kit.invoke(createInvite, {
      isReusable: false,
      expiresAt: futureExpiry,
      name: "  Марія  ",
      phone: "  +380501112233  ",
      email: "  maria-accept@kit.test  ",
      groupId: fixtures.groupA,
      priceListId: fixtures.listA,
    });

    const result = await kit.invoke(
      acceptInvite,
      { token: created.token },
      { userId: acceptors.fresh },
    );

    expect(result.inviteId).toBe(created.id);
    expect(result.created).toBe(true);
    expectNoInviteSecrets(result);

    const crm = await customerByUser(
      kitIdentities.companies.a,
      acceptors.fresh,
    );
    expect(crm?.id).toBe(result.customerId);
    expect(crm?.name).toBe("Марія");
    expect(crm?.phone).toBe("+380501112233");
    expect(crm?.email).toBe("maria-accept@kit.test");
    expect(crm?.groupId).toBe(fixtures.groupA);
    expect(crm?.priceListId).toBe(fixtures.listA);
    expect(crm?.status).toBe("active");

    const stored = await inviteRow(created.id);
    expect(stored?.usesCount).toBe(1);

    const { logger, entries } = createCapturingLogger();
    await kit.invoke(
      acceptInvite,
      { token: created.token },
      { userId: acceptors.fresh },
      { deps: { ...kit.pipeline, logger } },
    );
    expect(JSON.stringify(entries())).not.toContain(created.token);
    const storedAfterRetry = await inviteRow(created.id);
    expect(storedAfterRetry?.usesCount).toBe(1);

    const parties = await kit.db.runtime.db
      .select({ id: counterparties.id })
      .from(counterparties)
      .where(eq(counterparties.companyId, kitIdentities.companies.a));
    expect(parties).toHaveLength(0);

    const cards = await kit.db.runtime.db
      .select({ id: orderCards.id })
      .from(orderCards);
    expect(cards).toHaveLength(0);

    const audits = await kit.db.runtime.db
      .select({
        inputSnapshot: auditLog.inputSnapshot,
        targetId: auditLog.targetId,
        action: auditLog.action,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "invites.accept"),
          eq(auditLog.targetId, created.id),
          eq(auditLog.outcome, "ok"),
        ),
      );
    expect(audits.length).toBeGreaterThan(0);
    for (const row of audits) {
      expect(row.inputSnapshot).toBeNull();
      expect(JSON.stringify(row)).not.toContain(created.token);
    }

    const acceptedEvents = await kit.db.runtime.db
      .select({ payload: domainEvents.payload })
      .from(domainEvents)
      .where(eq(domainEvents.name, "invites.accepted"));
    expect(
      acceptedEvents.some((row) =>
        JSON.stringify(row.payload).includes(created.token),
      ),
    ).toBe(false);
  });

  it("enriches an existing linked row without overwriting staff-set assignments", async () => {
    await kit.db.runtime.db.insert(companyCustomers).values({
      id: randomUUID(),
      companyId: kitIdentities.companies.a,
      name: "Staff linked",
      phone: "+380501000010",
      userId: acceptors.linked,
      groupId: fixtures.groupA,
      priceListId: fixtures.listA,
    });

    const created = await kit.invoke(createInvite, {
      isReusable: false,
      expiresAt: futureExpiry,
      name: "Invite name ignored on enrich",
      groupId: fixtures.groupA2,
      priceListId: fixtures.listA2,
    });

    const result = await kit.invoke(
      acceptInvite,
      { token: created.token },
      { userId: acceptors.linked },
    );
    expect(result.created).toBe(false);

    const crm = await customerByUser(
      kitIdentities.companies.a,
      acceptors.linked,
    );
    expect(crm?.id).toBe(result.customerId);
    expect(crm?.name).toBe("Staff linked");
    expect(crm?.groupId).toBe(fixtures.groupA);
    expect(crm?.priceListId).toBe(fixtures.listA);
  });

  it("matches an unlinked phone/email row and links userId", async () => {
    const unlinkedId = randomUUID();
    await kit.db.runtime.db.insert(companyCustomers).values({
      id: unlinkedId,
      companyId: kitIdentities.companies.a,
      name: "Walk-in",
      phone: UNLINKED_PHONE,
      email: UNLINKED_EMAIL,
      userId: null,
    });

    const created = await kit.invoke(createInvite, {
      isReusable: false,
      expiresAt: futureExpiry,
      phone: UNLINKED_PHONE,
      email: UNLINKED_EMAIL,
    });

    const result = await kit.invoke(
      acceptInvite,
      { token: created.token },
      { userId: acceptors.unlinked },
    );
    expect(result.created).toBe(false);
    expect(result.customerId).toBe(unlinkedId);

    const crm = await customerByUser(
      kitIdentities.companies.a,
      acceptors.unlinked,
    );
    expect(crm?.id).toBe(unlinkedId);
    expect(crm?.userId).toBe(acceptors.unlinked);
  });

  it("fills empty group and price-list assignments from the token", async () => {
    await kit.db.runtime.db.insert(companyCustomers).values({
      id: randomUUID(),
      companyId: kitIdentities.companies.a,
      name: "Empty assignments",
      userId: acceptors.fill,
    });

    const created = await kit.invoke(createInvite, {
      isReusable: false,
      expiresAt: futureExpiry,
      groupId: fixtures.groupA,
      priceListId: fixtures.listA,
    });

    await kit.invoke(
      acceptInvite,
      { token: created.token },
      { userId: acceptors.fill },
    );

    const crm = await customerByUser(kitIdentities.companies.a, acceptors.fill);
    expect(crm?.groupId).toBe(fixtures.groupA);
    expect(crm?.priceListId).toBe(fixtures.listA);
  });

  it("restores an archived row to active and still fills assignments empty-only", async () => {
    await kit.db.runtime.db.insert(companyCustomers).values({
      id: randomUUID(),
      companyId: kitIdentities.companies.a,
      name: "Archived client",
      userId: acceptors.archived,
      groupId: fixtures.groupA,
      status: "archived",
    });

    const created = await kit.invoke(createInvite, {
      isReusable: false,
      expiresAt: futureExpiry,
      groupId: fixtures.groupA2,
      priceListId: fixtures.listA,
    });

    const result = await kit.invoke(
      acceptInvite,
      { token: created.token },
      { userId: acceptors.archived },
    );
    expect(result.created).toBe(false);

    const crm = await customerByUser(
      kitIdentities.companies.a,
      acceptors.archived,
    );
    expect(crm?.status).toBe("active");
    expect(crm?.groupId).toBe(fixtures.groupA);
    expect(crm?.priceListId).toBe(fixtures.listA);
  });

  it("does not restore a staff-archived CRM on same-user accept retry", async () => {
    const created = await kit.invoke(createInvite, {
      isReusable: false,
      expiresAt: futureExpiry,
      name: "Replay archived",
      groupId: fixtures.groupA,
      priceListId: fixtures.listA,
    });

    const first = await kit.invoke(
      acceptInvite,
      { token: created.token },
      { userId: acceptors.replayArchived },
    );
    expect(first.created).toBe(true);

    const afterFirst = await customerByUser(
      kitIdentities.companies.a,
      acceptors.replayArchived,
    );
    expect(afterFirst?.id).toBe(first.customerId);
    expect(afterFirst?.status).toBe("active");

    await kit.db.runtime.db
      .update(companyCustomers)
      .set({ status: "archived" })
      .where(eq(companyCustomers.id, first.customerId));

    const usesBeforeRetry = (await inviteRow(created.id))?.usesCount;
    expect(usesBeforeRetry).toBe(1);
    const eventsBeforeRetry = await kit.db.runtime.db
      .select({ id: domainEvents.id })
      .from(domainEvents)
      .where(
        and(
          eq(domainEvents.name, "invites.accepted"),
          eq(domainEvents.aggregateId, created.id),
        ),
      );
    expect(eventsBeforeRetry).toHaveLength(1);

    const retry = await kit.invoke(
      acceptInvite,
      { token: created.token },
      { userId: acceptors.replayArchived },
    );
    expect(retry.customerId).toBe(first.customerId);
    expect(retry.created).toBe(false);

    const afterRetry = await customerByUser(
      kitIdentities.companies.a,
      acceptors.replayArchived,
    );
    expect(afterRetry?.id).toBe(first.customerId);
    expect(afterRetry?.status).toBe("archived");

    const storedAfterRetry = await inviteRow(created.id);
    expect(storedAfterRetry?.usesCount).toBe(usesBeforeRetry);

    const eventsAfterRetry = await kit.db.runtime.db
      .select({ id: domainEvents.id })
      .from(domainEvents)
      .where(
        and(
          eq(domainEvents.name, "invites.accepted"),
          eq(domainEvents.aggregateId, created.id),
        ),
      );
    expect(eventsAfterRetry).toHaveLength(eventsBeforeRetry.length);
  });

  it("lets a second reusable acceptor get another CRM row and retries without a second use", async () => {
    const created = await kit.invoke(createInvite, {
      isReusable: true,
      expiresAt: futureExpiry,
      maxUses: 5,
    });

    const first = await kit.invoke(
      acceptInvite,
      { token: created.token },
      { userId: acceptors.reusable1 },
    );
    expect(first.created).toBe(true);

    const second = await kit.invoke(
      acceptInvite,
      { token: created.token },
      { userId: acceptors.reusable2 },
    );
    expect(second.created).toBe(true);
    expect(second.customerId).not.toBe(first.customerId);

    const afterTwo = await inviteRow(created.id);
    expect(afterTwo?.usesCount).toBe(2);

    const retry = await kit.invoke(
      acceptInvite,
      { token: created.token },
      { userId: acceptors.reusable1 },
    );
    expect(retry.customerId).toBe(first.customerId);
    expect(retry.created).toBe(false);

    const afterRetry = await inviteRow(created.id);
    expect(afterRetry?.usesCount).toBe(2);

    const events = await kit.db.runtime.db
      .select({
        payload: domainEvents.payload,
        aggregateId: domainEvents.aggregateId,
      })
      .from(domainEvents)
      .where(
        and(
          eq(domainEvents.name, "invites.accepted"),
          eq(domainEvents.aggregateId, created.id),
        ),
      );
    expect(events).toHaveLength(2);
  });

  it("returns the same not-found for exhausted, expired, revoked, and unknown tokens", async () => {
    const personal = await kit.invoke(createInvite, {
      isReusable: false,
      expiresAt: futureExpiry,
    });
    await kit.invoke(
      acceptInvite,
      { token: personal.token },
      { userId: acceptors.keep },
    );

    const cases = [
      personal.token,
      invitePlaintext(fixtures.expired),
      invitePlaintext(fixtures.revoked),
      invitePlaintext(fixtures.exhaustedOther),
      "unknown-invite-token",
    ];

    for (const token of cases) {
      const error = await kit
        .invoke(acceptInvite, { token }, { userId: acceptors.reusable2 })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(NotFoundError);
      expect((error as NotFoundError).clientMessage).toBe(NOT_FOUND_MESSAGE);
    }
  });

  it("does not write company B CRM when accepting a company A token", async () => {
    const created = await kit.invoke(createInvite, {
      isReusable: false,
      expiresAt: futureExpiry,
      name: "Tenant A only",
    });

    await kit.invoke(
      acceptInvite,
      { token: created.token },
      { userId: acceptors.tenant },
    );

    const inA = await customerByUser(
      kitIdentities.companies.a,
      acceptors.tenant,
    );
    const inB = await customerByUser(
      kitIdentities.companies.b,
      acceptors.tenant,
    );
    expect(inA).toBeDefined();
    expect(inB).toBeUndefined();
  });

  it("conflicts when multiple unlinked rows match the invite phone or email", async () => {
    const phone = "+380501776655";
    await kit.db.runtime.db.insert(companyCustomers).values([
      {
        id: randomUUID(),
        companyId: kitIdentities.companies.a,
        name: "Dup one",
        phone,
      },
      {
        id: randomUUID(),
        companyId: kitIdentities.companies.a,
        name: "Dup two",
        phone,
      },
    ]);

    const created = await kit.invoke(createInvite, {
      isReusable: false,
      expiresAt: futureExpiry,
      phone,
    });

    await expect(
      kit.invoke(
        acceptInvite,
        { token: created.token },
        { userId: acceptors.conflict },
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("uses the stable placeholder name when the invite has no name", async () => {
    const created = await kit.invoke(createInvite, {
      isReusable: false,
      expiresAt: futureExpiry,
    });

    await kit.invoke(
      acceptInvite,
      { token: created.token },
      { userId: acceptors.nameless },
    );

    const crm = await customerByUser(
      kitIdentities.companies.a,
      acceptors.nameless,
    );
    expect(crm?.name).toBe("Invited customer");
  });

  it("rejects an empty token and companyId on the wire", async () => {
    await expect(
      kit.invoke(acceptInvite, { token: "" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(acceptInvite, {
        token: "secret",
        companyId: kitIdentities.companies.a,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("fails a non-pending invite before any CRM write", async () => {
    const customersBefore = await kit.db.runtime.db
      .select({ id: companyCustomers.id })
      .from(companyCustomers)
      .where(
        and(
          eq(companyCustomers.companyId, kitIdentities.companies.a),
          eq(companyCustomers.userId, acceptors.guardNonPending),
        ),
      );
    expect(customersBefore).toHaveLength(0);

    const { logger, entries } = createCapturingLogger();
    const error = await kit
      .invoke(
        acceptNonPendingDirect,
        { token: invitePlaintext(fixtures.revoked) },
        { userId: acceptors.guardNonPending },
        { deps: { ...kit.pipeline, logger } },
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).clientMessage).toBe(NOT_FOUND_MESSAGE);
    expect(JSON.stringify(entries())).not.toContain("applyInviteCrm");

    const crm = await customerByUser(
      kitIdentities.companies.a,
      acceptors.guardNonPending,
    );
    expect(crm).toBeUndefined();

    const redemptions = await kit.db.runtime.db
      .select({ id: companyCustomerInviteRedemptions.id })
      .from(companyCustomerInviteRedemptions)
      .where(
        and(
          eq(companyCustomerInviteRedemptions.inviteId, fixtures.revoked),
          eq(
            companyCustomerInviteRedemptions.userId,
            acceptors.guardNonPending,
          ),
        ),
      );
    expect(redemptions).toHaveLength(0);
  });
});
