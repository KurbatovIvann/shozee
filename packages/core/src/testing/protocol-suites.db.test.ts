/**
 * Self-tests for the fnd-T22 protocol suites and the blueprint §2.1
 * invariant verification run over the fixture module (core.md §12–§13).
 *
 * Isolation suites stay in `kit.db.test.ts`. This file instantiates
 * idempotency / event / atomic suites the way a later module will, plus
 * social desired-state, null-company audit, and projection-ownership
 * checks. Seeded violations must fail the same `run*` helpers.
 */
import { randomUUID } from "node:crypto";

import { auditLog } from "@showzy/db";
import {
  fixtureCompanyFollows,
  fixtureDiscoveryCompanies,
  fixtureDiscoveryProducts,
  fixtureProductComments,
  readCrmSentinel,
} from "@showzy/db/testing/fixtures";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RateLimitError } from "../errors/index.js";
import { createRateLimitHook } from "../runtime/rate-limit/create-rate-limit-hook.js";
import { createInMemoryRateLimitStore } from "../runtime/rate-limit/token-bucket.js";
import { invokeConfirmedAction } from "./confirmation-gate.js";
import { createCorrectFixtureActions } from "./fixture-actions.js";
import { createProtocolFixtureActions } from "./fixture-module.js";
import { kitIdentities } from "./identities.js";
import {
  createCapturingLogger,
  createTestKit,
  invokeAction,
  type TestKit,
} from "./kit.js";
import {
  atomicCallSuite,
  eventSuite,
  idempotencySuite,
  runAtomicCallCase,
  runEventSuiteCase,
  runIdempotencyCase,
  runSocialDesiredStateCase,
} from "./protocol-suites.js";

let kit: TestKit;
const isolation = createCorrectFixtureActions();
const protocol = createProtocolFixtureActions();
let stockProductId: string;

const gatedFollows = {
  replay: randomUUID(),
  conflict: randomUUID(),
  concurrent: randomUUID(),
  guard: randomUUID(),
  guardConcurrent: randomUUID(),
};

beforeAll(async () => {
  kit = await createTestKit();
  stockProductId = await seedStock(5);
  await kit.db.runtime.db.insert(fixtureCompanyFollows).values(
    Object.values(gatedFollows).map((companyId) => ({
      userId: kitIdentities.users.anna,
      companyId,
    })),
  );
});

afterAll(async () => {
  await kit.db.close();
});

function noteInput(body: string, failAfterEmit = false) {
  return { noteId: randomUUID(), body, failAfterEmit };
}

async function seedStock(unitsLeft: number): Promise<string> {
  const productId = randomUUID();
  await kit.db.runtime.db.insert(fixtureDiscoveryProducts).values({
    productId,
    companyId: kitIdentities.companies.a,
    name: "Tracked stock",
    likeCount: unitsLeft,
    commentCount: 0,
  });
  return productId;
}

async function noteRowCount(noteId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ id: fixtureProductComments.id })
    .from(fixtureProductComments)
    .where(eq(fixtureProductComments.id, noteId));
  return rows.length;
}

async function confirmedOrderCount(): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ id: fixtureProductComments.id })
    .from(fixtureProductComments)
    .where(eq(fixtureProductComments.body, "confirmed"));
  return rows.length;
}

async function stockOf(productId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ units: fixtureDiscoveryProducts.likeCount })
    .from(fixtureDiscoveryProducts)
    .where(eq(fixtureDiscoveryProducts.productId, productId));
  return rows[0]?.units ?? -1;
}

async function publishedCommentCount(): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ count: fixtureDiscoveryProducts.commentCount })
    .from(fixtureDiscoveryProducts)
    .where(
      eq(fixtureDiscoveryProducts.productId, kitIdentities.products.published),
    );
  return rows[0]?.count ?? -1;
}

async function followerCount(): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ count: fixtureDiscoveryCompanies.followerCount })
    .from(fixtureDiscoveryCompanies)
    .where(eq(fixtureDiscoveryCompanies.companyId, kitIdentities.companies.a));
  return rows[0]?.count ?? -1;
}

async function followExists(userId: string): Promise<boolean> {
  const rows = await kit.db.runtime.db
    .select({ companyId: fixtureCompanyFollows.companyId })
    .from(fixtureCompanyFollows)
    .where(
      and(
        eq(fixtureCompanyFollows.userId, userId),
        eq(fixtureCompanyFollows.companyId, kitIdentities.companies.a),
      ),
    );
  return rows[0] !== undefined;
}

const replayNote = noteInput("hello");

async function confirmFollowOkAudits(): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "kitFixture.confirmFollow"),
        eq(auditLog.outcome, "ok"),
      ),
    );
  return rows.length;
}

idempotencySuite(
  () => kit,
  [
    {
      action: protocol.createNote,
      input: replayNote,
      conflictingInput: { ...replayNote, body: "changed" },
      freshInput: () => noteInput("concurrent"),
      readEffect: () => noteRowCount(replayNote.noteId),
    },
    {
      action: isolation.accountConfirmFollow,
      input: { companyId: gatedFollows.replay },
      conflictingInput: { companyId: gatedFollows.conflict },
      freshInput: () => ({ companyId: gatedFollows.concurrent }),
      readEffect: confirmFollowOkAudits,
    },
  ],
);

eventSuite(() => kit, {
  module: "kitFixture",
  emitAction: protocol.createNote,
  emitInput: noteInput("emitted"),
  failingEmitAction: protocol.createNote,
  failingEmitInput: noteInput("rolled-back", true),
  eventName: "kitFixture.noted",
  subscription: protocol.noteProjector,
  readProjection: publishedCommentCount,
});

atomicCallSuite(
  () => kit,
  [
    {
      root: protocol.confirmOrder,
      get successInput() {
        return {
          orderId: randomUUID(),
          productId: stockProductId,
          quantity: 1,
          failAfterCall: false,
        };
      },
      get failureInput() {
        return {
          orderId: randomUUID(),
          productId: stockProductId,
          quantity: 1,
          failAfterCall: true,
        };
      },
      readRootEffect: confirmedOrderCount,
      readCalleeEffect: () => stockOf(stockProductId),
      get undeclared() {
        return {
          action: protocol.confirmUndeclared,
          input: { productId: stockProductId },
        };
      },
      get mismatch() {
        return { action: protocol.confirmMismatch, input: {} };
      },
      get nested() {
        return {
          action: protocol.confirmNested,
          input: { productId: stockProductId },
        };
      },
    },
  ],
);

describe("idempotencySuite drives the confirmation gate", () => {
  it("leaves the kit's shared hooks untouched and frozen", async () => {
    const hooks = kit.pipeline.hooks;
    const confirmation = hooks?.confirmation;
    await runIdempotencyCase(kit, {
      action: isolation.accountConfirmFollow,
      input: { companyId: gatedFollows.guard },
      conflictingInput: { companyId: gatedFollows.conflict },
      freshInput: () => ({ companyId: gatedFollows.guardConcurrent }),
      readEffect: confirmFollowOkAudits,
    });
    expect(kit.pipeline.hooks).toBe(hooks);
    expect(kit.pipeline.hooks?.confirmation).toBe(confirmation);
    expect(Object.isFrozen(hooks)).toBe(true);
    expect(() =>
      Object.assign(hooks as object, { confirmation: undefined }),
    ).toThrow(TypeError);
  });

  it("replays a completed key without issuing a second card", async () => {
    const companyId = randomUUID();
    await kit.db.runtime.db
      .insert(fixtureCompanyFollows)
      .values({ userId: kitIdentities.users.anna, companyId });
    const idempotencyKey = randomUUID();
    const confirmed = await invokeConfirmedAction(
      kit,
      isolation.accountConfirmFollow,
      { companyId },
      {},
      { request: { idempotencyKey } },
    );
    const before = await confirmFollowOkAudits();
    const replay = await invokeAction(
      kit,
      isolation.accountConfirmFollow,
      { companyId },
      {},
      { request: { idempotencyKey } },
    );
    expect(replay).toEqual(confirmed);
    expect(await confirmFollowOkAudits()).toBe(before);
  });
});

describe("idempotencySuite fails on a non-idempotent twin", () => {
  it("detects replay that re-runs the handler", async () => {
    const input = noteInput("leaky");
    await expect(
      runIdempotencyCase(kit, {
        action: protocol.leakyCreateNote,
        input,
        conflictingInput: { ...input, body: "other" },
        freshInput: () => noteInput("leaky-concurrent"),
        readEffect: publishedCommentCount,
      }),
    ).rejects.toThrow(/replay re-ran the handler|accepted the same key/);
  });
});

describe("blueprint §2.1 — observability / audit", () => {
  it("writes a tenant audit row for a staff mutation", async () => {
    const requestId = randomUUID();
    const input = noteInput("audited");
    await invokeAction(
      kit,
      protocol.createNote,
      input,
      {},
      { request: { requestId } },
    );
    const rows = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("kitFixture.createNote");
    expect(rows[0]?.actorType).toBe("user");
    expect(rows[0]?.actorId).toBe(kitIdentities.users.anna);
    expect(rows[0]?.channel).toBe("ui");
    expect(rows[0]?.companyId).toBe(kitIdentities.companies.a);
    expect(rows[0]?.outcome).toBe("ok");
  });

  it("writes a null-company audit row for an account mutation", async () => {
    const requestId = randomUUID();
    await invokeAction(
      kit,
      protocol.setFollow,
      { companyId: kitIdentities.companies.a, following: true },
      { userId: kitIdentities.users.anna },
      { request: { requestId } },
    );
    const rows = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("kitFixture.setFollow");
    expect(rows[0]?.actorId).toBe(kitIdentities.users.anna);
    expect(rows[0]?.companyId).toBeNull();
  });

  it("does not write an audit row for a public-global read", async () => {
    const requestId = randomUUID();
    const capturing = createCapturingLogger();
    await invokeAction(
      kit,
      isolation.publicBrowseDiscovery,
      {},
      {},
      {
        request: { requestId },
        deps: { ...kit.pipeline, logger: capturing.logger },
      },
    );
    const rows = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(rows).toHaveLength(0);
    const finished = capturing
      .entries()
      .find((line) => line["msg"] === "action finished");
    expect(finished?.["actor_type"]).toBe("anonymous");
    expect(finished?.["company_id"]).toBeNull();
  });
});

describe("blueprint §2.1 — projections never own domain state", () => {
  it("discovery browse and social writes leave the CRM sentinel unchanged", async () => {
    const before = await readCrmSentinel(kit.db.runtime.db);
    await invokeAction(kit, isolation.publicBrowseDiscovery, {});
    await invokeAction(kit, isolation.consumerBrowseDiscovery, {});
    await invokeAction(
      kit,
      protocol.setFollow,
      { companyId: kitIdentities.companies.a, following: true },
      { userId: kitIdentities.users.anna },
    );
    const after = await readCrmSentinel(kit.db.runtime.db);
    expect(after).toEqual(before);
  });
});

describe("social desired-state writes", () => {
  it("retries do not duplicate counters; opposite state reverses", async () => {
    await runSocialDesiredStateCase(kit, {
      action: protocol.setFollow,
      desiredInput: {
        companyId: kitIdentities.companies.a,
        following: true,
      },
      oppositeInput: {
        companyId: kitIdentities.companies.a,
        following: false,
      },
      actor: { userId: kitIdentities.users.anna },
      readCount: followerCount,
    });
    expect(await followExists(kitIdentities.users.anna)).toBe(true);
  });

  it("detects a retry-unsafe counter bump", async () => {
    await expect(
      runSocialDesiredStateCase(kit, {
        action: protocol.leakySetFollow,
        desiredInput: {
          companyId: kitIdentities.companies.a,
          following: true,
        },
        oppositeInput: {
          companyId: kitIdentities.companies.a,
          following: false,
        },
        actor: { userId: kitIdentities.users.anna },
        readCount: followerCount,
      }),
    ).rejects.toThrow(/retry of the same desired state changed the counter/);
  });

  it("keeps user B out of user A's follow collection", async () => {
    expect(await followExists(kitIdentities.users.anna)).toBe(true);
    await invokeAction(
      kit,
      protocol.setFollow,
      { companyId: kitIdentities.companies.a, following: false },
      { userId: kitIdentities.users.boris },
    );
    expect(await followExists(kitIdentities.users.anna)).toBe(true);
    expect(await followExists(kitIdentities.users.boris)).toBe(false);
  });

  it("enforces the per-action abuse rate limit", async () => {
    const logger = createCapturingLogger().logger;
    const now = () => 1_000_000;
    const deps = {
      ...kit.pipeline,
      logger,
      hooks: {
        ...kit.pipeline.hooks,
        rateLimit: createRateLimitHook({
          store: createInMemoryRateLimitStore({ now }),
          ipHmacSecret: "test-kit-ip-hmac-secret",
          logger,
          now,
        }),
      },
    };
    const input = {
      companyId: kitIdentities.companies.a,
      following: true,
    };
    const actor = { userId: kitIdentities.users.anna };
    for (let i = 0; i < 3; i += 1) {
      await invokeAction(kit, protocol.setFollow, input, actor, { deps });
    }
    await expect(
      invokeAction(kit, protocol.setFollow, input, actor, { deps }),
    ).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe("atomicCallSuite fails on seeded violations", () => {
  it("detects rollback that leaves domain_events rows", async () => {
    const productId = await seedStock(3);
    const leaky = protocol.createLeakyConfirmOrder(kit.db.runtime.db);
    await expect(
      runAtomicCallCase(kit, {
        root: leaky,
        successInput: {
          orderId: randomUUID(),
          productId,
          quantity: 1,
          failAfterCall: false,
        },
        failureInput: {
          orderId: randomUUID(),
          productId,
          quantity: 1,
          failAfterCall: true,
        },
        readRootEffect: confirmedOrderCount,
        readCalleeEffect: () => stockOf(productId),
        undeclared: {
          action: protocol.confirmUndeclared,
          input: { productId },
        },
        mismatch: { action: protocol.confirmMismatch, input: {} },
        nested: {
          action: protocol.confirmNested,
          input: { productId },
        },
      }),
    ).rejects.toThrow(/rollback left domain_events/);
  });

  it("detects an undeclared probe that does not fail", async () => {
    const productId = await seedStock(3);
    await expect(
      runAtomicCallCase(kit, {
        root: protocol.confirmOrder,
        successInput: {
          orderId: randomUUID(),
          productId,
          quantity: 1,
          failAfterCall: false,
        },
        failureInput: {
          orderId: randomUUID(),
          productId,
          quantity: 1,
          failAfterCall: true,
        },
        readRootEffect: confirmedOrderCount,
        readCalleeEffect: () => stockOf(productId),
        undeclared: {
          action: protocol.createNote,
          input: noteInput("not-undeclared"),
        },
        mismatch: { action: protocol.confirmMismatch, input: {} },
        nested: {
          action: protocol.confirmNested,
          input: { productId },
        },
      }),
    ).rejects.toThrow(/undeclared edge/);
  });
});

describe("protocol suite run* helpers against the fixture module", () => {
  it("eventSuite commit + dedup holds on a second module bundle", async () => {
    await runEventSuiteCase(kit, {
      module: "kitChat",
      emitAction: protocol.createNote,
      emitInput: noteInput("second-emit"),
      failingEmitAction: protocol.createNote,
      failingEmitInput: noteInput("second-fail", true),
      eventName: "kitFixture.noted",
      subscription: protocol.noteProjector,
      readProjection: publishedCommentCount,
    });
  });

  it("atomicCallSuite holds on a freshly seeded stock row", async () => {
    const productId = await seedStock(3);
    await runAtomicCallCase(kit, {
      root: protocol.confirmOrder,
      successInput: {
        orderId: randomUUID(),
        productId,
        quantity: 1,
        failAfterCall: false,
      },
      failureInput: {
        orderId: randomUUID(),
        productId,
        quantity: 1,
        failAfterCall: true,
      },
      readRootEffect: confirmedOrderCount,
      readCalleeEffect: () => stockOf(productId),
      undeclared: {
        action: protocol.confirmUndeclared,
        input: { productId },
      },
      mismatch: { action: protocol.confirmMismatch, input: {} },
      nested: {
        action: protocol.confirmNested,
        input: { productId },
      },
    });
  });
});
