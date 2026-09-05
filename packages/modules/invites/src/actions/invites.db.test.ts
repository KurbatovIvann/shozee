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
  PermissionDeniedError,
  ValidationError,
} from "@showzy/core/errors";
import {
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
import { companyMembers } from "@showzy/db/schema/companies";
import { customerGroups } from "@showzy/db/schema/customers";
import { companyCustomerInvites } from "@showzy/db/schema/invites";
import { priceLists } from "@showzy/db/schema/pricing";
import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createInvite } from "./create.js";
import { INVITE_COPY_URL_PREFIX } from "./create.contract.js";
import { getInvite } from "./get.js";
import { listInvites } from "./list.js";
import { revokeInvite } from "./revoke.js";
import { invitesCreated } from "../events/created.js";
import { invitesRevoked } from "../events/revoked.js";
import { hashInviteToken } from "../services/token-hash.js";

const TEST_CREATED_CONSUMER = "invites.test-created-noop";
const TEST_REVOKED_CONSUMER = "invites.test-revoked-noop";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function isoFromNow(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

const futureExpiry = isoFromNow(7 * DAY_MS);

const fixtures = {
  groupA: randomUUID(),
  groupB: randomUUID(),
  listA: randomUUID(),
  listB: randomUUID(),
  getA: randomUUID(),
  getB: randomUUID(),
  isolationRevokeA: randomUUID(),
  isolationRevokeB: randomUUID(),
  idemRevoke: randomUUID(),
  idemRevokeConflict: randomUUID(),
  eventRevoke: randomUUID(),
  listNewest: randomUUID(),
  listOlder: randomUUID(),
  expired: randomUUID(),
  exhausted: randomUUID(),
  alreadyRevoked: randomUUID(),
  foreign: randomUUID(),
};

const clerks = {
  employee: randomUUID(),
};

const createIsolationInput = {
  isReusable: false as const,
  expiresAt: futureExpiry,
  name: "Isolation create",
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
  expect(objectKeys(value)).not.toContain("url");
}

async function countCompanyInvites(companyId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ value: count() })
    .from(companyCustomerInvites)
    .where(eq(companyCustomerInvites.companyId, companyId));
  return rows[0]?.value ?? 0;
}

async function countRevoked(companyId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ value: count() })
    .from(companyCustomerInvites)
    .where(
      and(
        eq(companyCustomerInvites.companyId, companyId),
        eq(companyCustomerInvites.status, "revoked"),
      ),
    );
  return rows[0]?.value ?? 0;
}

async function inviteRow(inviteId: string) {
  const rows = await kit.db.runtime.db
    .select()
    .from(companyCustomerInvites)
    .where(eq(companyCustomerInvites.id, inviteId));
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

const emitCreatedThenFail = implementAction(
  defineActionContract({
    name: "invites.emitCreatedThenFail",
    description:
      "Test-local emitter that fails after buffering invites.created.",
    principal: "staff",
    transport: "internal",
    input: z.object({ inviteId: z.uuid() }),
    output: z.object({ inviteId: z.uuid() }),
    permissions: ["customers:invite"],
    aiExposure: "internal",
    risk: "write",
    requiresConfirmation: false,
    idempotent: true,
    emits: ["invites.created"],
    atomicCalls: [],
    atomicCallers: [],
    audit: true,
    timeout: 5_000,
  }),
  {
    handler: (input, ctx) => {
      ctx.emit(invitesCreated, {
        aggregate: { type: "invite", id: input.inviteId },
        payload: {
          inviteId: input.inviteId,
          isReusable: false,
          expiresAt: futureExpiry,
        },
      });
      throw new ConflictError("Injected emit-then-fail.");
    },
    auditTarget: () => ({ type: "invite", id: "test-created-fail" }),
  },
);

const emitRevokedThenFail = implementAction(
  defineActionContract({
    name: "invites.emitRevokedThenFail",
    description:
      "Test-local emitter that fails after buffering invites.revoked.",
    principal: "staff",
    transport: "internal",
    input: z.object({ inviteId: z.uuid() }),
    output: z.object({ inviteId: z.uuid() }),
    permissions: ["customers:invite"],
    aiExposure: "internal",
    risk: "write",
    requiresConfirmation: false,
    idempotent: true,
    emits: ["invites.revoked"],
    atomicCalls: [],
    atomicCallers: [],
    audit: true,
    timeout: 5_000,
  }),
  {
    handler: (input, ctx) => {
      ctx.emit(invitesRevoked, {
        aggregate: { type: "invite", id: input.inviteId },
        payload: { inviteId: input.inviteId },
      });
      throw new ConflictError("Injected emit-then-fail.");
    },
    auditTarget: () => ({ type: "invite", id: "test-revoked-fail" }),
  },
);

const projectCreatedTest = implementAction(
  defineActionContract({
    name: "invites.projectCreatedTest",
    description: "Test-local no-op consumer of invites.created.",
    principal: "system",
    systemScope: "tenant",
    transport: "internal",
    input: eventEnvelopeSchema(invitesCreated.payload),
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
    auditTarget: () => ({ type: "invite", id: "test-created-noop" }),
  },
);

const projectRevokedTest = implementAction(
  defineActionContract({
    name: "invites.projectRevokedTest",
    description: "Test-local no-op consumer of invites.revoked.",
    principal: "system",
    systemScope: "tenant",
    transport: "internal",
    input: eventEnvelopeSchema(invitesRevoked.payload),
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
    auditTarget: () => ({ type: "invite", id: "test-revoked-noop" }),
  },
);

const createdNoop = defineEventHandler({
  event: invitesCreated,
  consumer: TEST_CREATED_CONSUMER,
  action: projectCreatedTest,
});

const revokedNoop = defineEventHandler({
  event: invitesRevoked,
  consumer: TEST_REVOKED_CONSUMER,
  action: projectRevokedTest,
});

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
  readonly updatedAt?: Date;
  readonly createdAt?: Date;
}): Promise<void> {
  await kit.db.runtime.db.insert(companyCustomerInvites).values({
    id: values.id,
    companyId: values.companyId,
    invitedBy: kitIdentities.users.anna,
    tokenHash: hashInviteToken(`invite-row-${values.id}`),
    isReusable: values.isReusable ?? false,
    maxUses: values.maxUses === undefined ? 1 : values.maxUses,
    usesCount: values.usesCount ?? 0,
    expiresAt: values.expiresAt,
    status: values.status ?? "pending",
    groupId: values.groupId,
    priceListId: values.priceListId,
    name: values.name,
    createdAt: values.createdAt,
    updatedAt: values.updatedAt,
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
      id: fixtures.groupB,
      companyId: companyB,
      name: "Foreign group",
      slug: `foreign-${fixtures.groupB}`,
    },
  ]);

  await insertInvite({
    id: fixtures.getA,
    companyId: companyA,
    expiresAt: future,
    groupId: fixtures.groupA,
    priceListId: fixtures.listA,
    name: "Get Alpha",
  });
  await insertInvite({
    id: fixtures.getB,
    companyId: companyB,
    expiresAt: future,
    name: "Get Bravo",
  });
  await insertInvite({
    id: fixtures.isolationRevokeA,
    companyId: companyA,
    expiresAt: future,
    name: "Isolation revoke A",
  });
  await insertInvite({
    id: fixtures.isolationRevokeB,
    companyId: companyB,
    expiresAt: future,
    name: "Isolation revoke B",
  });
  await insertInvite({
    id: fixtures.idemRevoke,
    companyId: companyA,
    expiresAt: future,
    name: "Idem revoke",
  });
  await insertInvite({
    id: fixtures.idemRevokeConflict,
    companyId: companyA,
    expiresAt: future,
    name: "Idem revoke conflict",
  });
  await insertInvite({
    id: fixtures.eventRevoke,
    companyId: companyA,
    expiresAt: future,
    name: "Event revoke",
  });
  await insertInvite({
    id: fixtures.listNewest,
    companyId: companyA,
    expiresAt: future,
    name: "List newest",
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
  });
  await insertInvite({
    id: fixtures.listOlder,
    companyId: companyA,
    expiresAt: future,
    name: "List older",
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    updatedAt: new Date("2026-03-01T00:00:00.000Z"),
  });
  await insertInvite({
    id: fixtures.expired,
    companyId: companyA,
    expiresAt: past,
    name: "Expired",
  });
  await insertInvite({
    id: fixtures.exhausted,
    companyId: companyA,
    expiresAt: future,
    maxUses: 1,
    usesCount: 1,
    name: "Exhausted",
  });
  await insertInvite({
    id: fixtures.alreadyRevoked,
    companyId: companyA,
    expiresAt: future,
    status: "revoked",
    name: "Already revoked",
  });
  await insertInvite({
    id: fixtures.foreign,
    companyId: companyB,
    expiresAt: future,
    name: "Foreign list",
  });

  await kit.db.runtime.db.insert(user).values({
    id: clerks.employee,
    name: "Employee",
    email: "employee@invites-writes.test",
  });
  await kit.db.runtime.db.insert(companyMembers).values({
    companyId: companyA,
    userId: clerks.employee,
    role: "employee",
    permissions: { granted: ["customers:view"], denied: [] },
  });
});

afterAll(async () => {
  await kit.db.close();
});

crossTenantSuite(
  () => kit,
  [
    isolationCase(
      createInvite,
      { input: createIsolationInput },
      { input: createIsolationInput, companyId: kitIdentities.companies.b },
    ),
    isolationCase(
      getInvite,
      { input: { id: fixtures.getA } },
      { input: { id: fixtures.getB } },
    ),
    isolationCase(
      listInvites,
      { input: {} },
      {
        input: {},
        companyId: kitIdentities.companies.b,
        userId: kitIdentities.users.anna,
      },
    ),
    isolationCase(
      revokeInvite,
      { input: { id: fixtures.isolationRevokeA } },
      { input: { id: fixtures.isolationRevokeB } },
    ),
  ],
);

idempotencySuite(
  () => kit,
  [
    {
      action: createInvite,
      input: {
        isReusable: true,
        expiresAt: futureExpiry,
        name: "Idem create",
      },
      conflictingInput: {
        isReusable: true,
        expiresAt: futureExpiry,
        name: "Idem create other",
      },
      readEffect: () => countCompanyInvites(kitIdentities.companies.a),
    },
    {
      action: revokeInvite,
      input: { id: fixtures.idemRevoke },
      conflictingInput: { id: fixtures.idemRevokeConflict },
      readEffect: () => countRevoked(kitIdentities.companies.a),
    },
  ],
);

eventSuite(() => kit, {
  module: "invites",
  emitAction: createInvite,
  emitInput: {
    isReusable: true,
    expiresAt: futureExpiry,
    name: "Event create",
  },
  failingEmitAction: emitCreatedThenFail,
  failingEmitInput: { inviteId: randomUUID() },
  eventName: "invites.created",
  subscription: createdNoop,
  readProjection: () => processedDeliveries(TEST_CREATED_CONSUMER),
});

eventSuite(() => kit, {
  module: "invites",
  emitAction: revokeInvite,
  emitInput: { id: fixtures.eventRevoke },
  failingEmitAction: emitRevokedThenFail,
  failingEmitInput: { inviteId: randomUUID() },
  eventName: "invites.revoked",
  subscription: revokedNoop,
  readProjection: () => processedDeliveries(TEST_REVOKED_CONSUMER),
});

describe("invites.create / list / get / revoke", () => {
  it("creates personal and reusable invites, returns the plaintext once, and stores only the hash", async () => {
    const personal = await kit.invoke(createInvite, {
      isReusable: false,
      expiresAt: futureExpiry,
      name: "  Марія  ",
      phone: "  +380501112233  ",
      email: "  maria@kit.test  ",
      groupId: fixtures.groupA,
      priceListId: fixtures.listA,
    });

    expect(personal.isReusable).toBe(false);
    expect(personal.maxUses).toBe(1);
    expect(personal.usesCount).toBe(0);
    expect(personal.status).toBe("pending");
    expect(personal.name).toBe("Марія");
    expect(personal.phone).toBe("+380501112233");
    expect(personal.email).toBe("maria@kit.test");
    expect(personal.groupId).toBe(fixtures.groupA);
    expect(personal.priceListId).toBe(fixtures.listA);
    expect(personal.invitedBy).toBe(kitIdentities.users.anna);
    expect(personal.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(personal.url).toBe(`${INVITE_COPY_URL_PREFIX}${personal.token}`);
    expect(objectKeys(personal)).not.toContain("tokenHash");
    expect(objectKeys(personal)).not.toContain("companyId");

    const stored = await inviteRow(personal.id);
    expect(stored?.tokenHash).toBe(hashInviteToken(personal.token));
    expect(stored).not.toHaveProperty("token");

    const audits = await kit.db.runtime.db
      .select({
        inputSnapshot: auditLog.inputSnapshot,
        targetId: auditLog.targetId,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "invites.create"),
          eq(auditLog.targetId, personal.id),
          eq(auditLog.outcome, "ok"),
        ),
      );
    expect(audits.length).toBeGreaterThan(0);
    for (const row of audits) {
      expect(row.inputSnapshot).toBeNull();
      expect(JSON.stringify(row)).not.toContain(personal.token);
    }

    const events = await kit.db.runtime.db
      .select({ payload: domainEvents.payload, name: domainEvents.name })
      .from(domainEvents)
      .where(eq(domainEvents.name, "invites.created"));
    expect(
      events.some((row) =>
        JSON.stringify(row.payload).includes(personal.token),
      ),
    ).toBe(false);

    const fetched = await kit.invoke(getInvite, { id: personal.id });
    expect(fetched.id).toBe(personal.id);
    expectNoInviteSecrets(fetched);
    expect(fetched).not.toEqual(
      expect.objectContaining({ token: personal.token }),
    );

    const reusable = await kit.invoke(createInvite, {
      isReusable: true,
      expiresAt: futureExpiry,
      maxUses: 25,
    });
    expect(reusable.isReusable).toBe(true);
    expect(reusable.maxUses).toBe(25);
    expect(reusable.token).not.toBe(personal.token);
    expect(reusable.groupId).toBeNull();
    expect(reusable.priceListId).toBeNull();

    const unlimited = await kit.invoke(createInvite, {
      isReusable: true,
      expiresAt: futureExpiry,
    });
    expect(unlimited.maxUses).toBeNull();
  });

  it("lists own-tenant invites without secrets and derives expired/exhausted/revoked", async () => {
    const page = await kit.invoke(listInvites, { limit: 50 });
    const byId = new Map(page.items.map((row) => [row.id, row]));

    expect(byId.has(fixtures.foreign)).toBe(false);
    expect(byId.has(fixtures.getB)).toBe(false);
    expectNoInviteSecrets(page);

    expect(byId.get(fixtures.expired)?.status).toBe("expired");
    expect(byId.get(fixtures.exhausted)?.status).toBe("exhausted");
    expect(byId.get(fixtures.alreadyRevoked)?.status).toBe("revoked");
    expect(byId.get(fixtures.getA)?.status).toBe("pending");

    const firstPage = await kit.invoke(listInvites, { limit: 1 });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    const secondPage = await kit.invoke(listInvites, {
      limit: 1,
      cursor: firstPage.nextCursor ?? undefined,
    });
    expect(secondPage.items[0]?.id).not.toBe(firstPage.items[0]?.id);
  });

  it("gets derived status and the same not-found for missing or foreign ids", async () => {
    await expect(
      kit.invoke(getInvite, { id: fixtures.expired }),
    ).resolves.toMatchObject({ id: fixtures.expired, status: "expired" });
    await expect(
      kit.invoke(getInvite, { id: fixtures.exhausted }),
    ).resolves.toMatchObject({ id: fixtures.exhausted, status: "exhausted" });
    await expect(
      kit.invoke(getInvite, { id: fixtures.alreadyRevoked }),
    ).resolves.toMatchObject({
      id: fixtures.alreadyRevoked,
      status: "revoked",
    });

    const missing = randomUUID();
    await expect(kit.invoke(getInvite, { id: missing })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      kit.invoke(getInvite, { id: fixtures.getB }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      kit.invoke(revokeInvite, { id: randomUUID() }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("revokes a pending invite and treats already-revoked as a no-op", async () => {
    const created = await kit.invoke(createInvite, {
      isReusable: true,
      expiresAt: futureExpiry,
      name: "Revoke target",
    });
    const eventsBefore = await kit.db.runtime.db
      .select({ id: domainEvents.id })
      .from(domainEvents)
      .where(eq(domainEvents.name, "invites.revoked"));

    const first = await kit.invoke(revokeInvite, { id: created.id });
    expect(first.status).toBe("revoked");
    expectNoInviteSecrets(first);

    const eventsAfterFirst = await kit.db.runtime.db
      .select({ id: domainEvents.id })
      .from(domainEvents)
      .where(eq(domainEvents.name, "invites.revoked"));
    expect(eventsAfterFirst.length).toBe(eventsBefore.length + 1);

    const second = await kit.invoke(revokeInvite, { id: created.id });
    expect(second.status).toBe("revoked");
    expect(second.id).toBe(created.id);

    const eventsAfterSecond = await kit.db.runtime.db
      .select({ id: domainEvents.id })
      .from(domainEvents)
      .where(eq(domainEvents.name, "invites.revoked"));
    expect(eventsAfterSecond.length).toBe(eventsAfterFirst.length);

    const already = await kit.invoke(revokeInvite, {
      id: fixtures.alreadyRevoked,
    });
    expect(already.status).toBe("revoked");
  });

  it("lets an employee list and get but denies create and revoke", async () => {
    const actor = {
      userId: clerks.employee,
      companyId: kitIdentities.companies.a,
    };
    const listed = await kit.invoke(listInvites, {}, actor);
    expect(Array.isArray(listed.items)).toBe(true);
    await expect(
      kit.invoke(getInvite, { id: fixtures.getA }, actor),
    ).resolves.toMatchObject({ id: fixtures.getA });
    await expect(
      kit.invoke(
        createInvite,
        { isReusable: true, expiresAt: futureExpiry },
        actor,
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      kit.invoke(revokeInvite, { id: fixtures.getA }, actor),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("rejects expiry out of range, personal maxUses other than 1, and companyId", async () => {
    await expect(
      kit.invoke(createInvite, {
        isReusable: true,
        expiresAt: isoFromNow(30 * 60 * 1000),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(createInvite, {
        isReusable: true,
        expiresAt: isoFromNow(400 * DAY_MS),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(createInvite, {
        isReusable: false,
        expiresAt: futureExpiry,
        maxUses: 2,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(createInvite, {
        isReusable: false,
        expiresAt: futureExpiry,
        companyId: kitIdentities.companies.a,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("returns the same not-found for missing and foreign group or price list", async () => {
    const missing = randomUUID();
    await expect(
      kit.invoke(createInvite, {
        isReusable: true,
        expiresAt: futureExpiry,
        groupId: missing,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      kit.invoke(createInvite, {
        isReusable: true,
        expiresAt: futureExpiry,
        groupId: fixtures.groupB,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      kit.invoke(createInvite, {
        isReusable: true,
        expiresAt: futureExpiry,
        priceListId: missing,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      kit.invoke(createInvite, {
        isReusable: true,
        expiresAt: futureExpiry,
        priceListId: fixtures.listB,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
