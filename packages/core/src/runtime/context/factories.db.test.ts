/**
 * Integration tests for the seven principal context factories (fnd-T11 /
 * fnd-T11B — core.md §3; ADR-0013, ADR-0018, ADR-0020, ADR-0022) against
 * the shared Testcontainers harness: staff selector/membership verification
 * and permission precedence, resolver-proved customer/public-target/share
 * scope, explicit system scope, grant-bound public-global reads,
 * session-required consumer/account, unauthenticated share (no session),
 * `effectiveCompanyId` per mode, and the bound log fields
 * (security-operations §6).
 */
import { createHash, randomUUID } from "node:crypto";

import {
  companies,
  companyMembers,
  rolePermissionDefaults,
  type ReadTx,
} from "@showzy/db";
import { user } from "@showzy/db/schema/auth";
import { createTestDatabase, type TestDatabase } from "@showzy/db/testing";
import {
  createParityFixtureTables,
  fixtureCompanies,
  fixtureCrmCustomers,
  fixtureDiscoveryGrant,
  parityIds,
  seedParityFixtures,
} from "@showzy/db/testing/fixtures";
import { eq } from "drizzle-orm";
import { pino, type Logger } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CoreError,
  CoreInvariantError,
  NotFoundError,
  PermissionDeniedError,
} from "../../errors/index.js";
import type { ResolvedTarget, TargetResolutionEnv } from "../types.js";
import {
  createAccountContext,
  createConsumerContext,
  createCustomerContext,
  createPublicContext,
  createShareContext,
  createStaffContext,
  createSystemContext,
  effectiveCompanyId,
  type ActionRequestMeta,
  type ContextRuntime,
} from "./factories.js";
import { staffHasPermission } from "./permissions.js";

let db: TestDatabase;

const users = {
  anna: "user_anna",
  boris: "user_boris",
  carol: "user_carol",
} as const;
const companyA = randomUUID();
const companyB = randomUUID();

beforeAll(async () => {
  db = await createTestDatabase();
  await db.runtime.db.insert(user).values([
    { id: users.anna, name: "Anna", email: "anna@example.test" },
    { id: users.boris, name: "Boris", email: "boris@example.test" },
    { id: users.carol, name: "Carol", email: "carol@example.test" },
  ]);
  await db.runtime.db.insert(companies).values([
    { id: companyA, name: "Company A", slug: "company-a", prefix: "CA" },
    { id: companyB, name: "Company B", slug: "company-b", prefix: "CB" },
  ]);
  await db.runtime.db.insert(rolePermissionDefaults).values([
    { role: "manager", permission: "orders:view" },
    { role: "manager", permission: "orders:create" },
    { role: "employee", permission: "orders:view" },
  ]);
  await db.runtime.db.insert(companyMembers).values([
    {
      companyId: companyA,
      userId: users.anna,
      role: "owner",
      // Owner-all must win even over an explicit deny row.
      permissions: { granted: [], denied: ["orders:view"] },
    },
    {
      companyId: companyB,
      userId: users.boris,
      role: "manager",
      permissions: { granted: ["pricing:manage"], denied: ["orders:create"] },
    },
  ]);
  // Customer/public-target/public-global cases run against the parity
  // fixture dataset (fnd-T5A) instead of inventing new tables.
  await createParityFixtureTables(db.admin);
  await seedParityFixtures(db.runtime.db);
});

afterAll(async () => {
  await db.close();
});

function requestMeta(
  overrides: Partial<ActionRequestMeta> = {},
): ActionRequestMeta {
  return {
    action: "fixture.doThing",
    requestId: randomUUID(),
    correlationId: randomUUID(),
    channel: "ui",
    clientIp: "203.0.113.7",
    ...overrides,
  };
}

function runtimeFor<TDb>(
  dbCapability: TDb,
  logger?: Logger,
): ContextRuntime<TDb> {
  return {
    db: dbCapability,
    logger: logger ?? pino({ enabled: false }),
    deadline: Date.now() + 5_000,
    signal: new AbortController().signal,
    // The pipeline owns the real buffered emit (fnd-T16), `ctx.call`
    // (fnd-T19), and `ctx.callAtomic` (fnd-T19A); factory tests never
    // emit or call.
    emit: () => {
      throw new Error("fixture contexts cannot emit");
    },
    enqueue: () => {
      throw new Error("fixture contexts cannot enqueue");
    },
    call: () => {
      throw new Error("fixture contexts cannot call");
    },
    callAtomic: () => {
      throw new Error("fixture contexts cannot call atomically");
    },
  };
}

function captureLogger(): {
  logger: Logger;
  entries: () => Record<string, unknown>[];
} {
  const lines: string[] = [];
  const logger = pino(
    { base: null },
    {
      write(chunk: string) {
        lines.push(chunk);
      },
    },
  );
  return {
    logger,
    entries: () =>
      lines
        .flatMap((chunk) => chunk.split("\n"))
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

async function expectCoreError<T extends CoreError>(
  promise: Promise<unknown>,
  errorClass: new (...args: never[]) => T,
): Promise<T> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(errorClass);
    return error as T;
  }
  throw new Error(`expected ${errorClass.name}, but the promise resolved`);
}

describe("createStaffContext", () => {
  it("derives company scope from the verified membership row", async () => {
    const runtime = runtimeFor(db.runtime.db);
    const ctx = await createStaffContext({
      request: requestMeta(),
      runtime,
      session: { userId: users.anna },
      companySelector: companyA,
    });

    expect(ctx.principal).toBe("staff");
    expect(ctx.userId).toBe(users.anna);
    expect(ctx.companyId).toBe(companyA);
    expect(ctx.membership.role).toBe("owner");
    expect(ctx.actor).toEqual({ type: "user", id: users.anna });
    expect(ctx.db).toBe(runtime.db);
    expect(effectiveCompanyId(ctx)).toBe(companyA);
  });

  it("denies without a session", async () => {
    await expectCoreError(
      createStaffContext({
        request: requestMeta(),
        runtime: runtimeFor(db.runtime.db),
        session: null,
        companySelector: companyA,
      }),
      PermissionDeniedError,
    );
  });

  it("denies a missing and a malformed selector identically", async () => {
    const missing = await expectCoreError(
      createStaffContext({
        request: requestMeta(),
        runtime: runtimeFor(db.runtime.db),
        session: { userId: users.anna },
        companySelector: null,
      }),
      PermissionDeniedError,
    );
    const malformed = await expectCoreError(
      createStaffContext({
        request: requestMeta(),
        runtime: runtimeFor(db.runtime.db),
        session: { userId: users.anna },
        companySelector: "not-a-uuid",
      }),
      PermissionDeniedError,
    );
    expect(malformed.clientMessage).toBe(missing.clientMessage);
  });

  it("denies a foreign membership and a nonexistent company identically", async () => {
    // Anna is a member of A only; the selector is never authority.
    const foreign = await expectCoreError(
      createStaffContext({
        request: requestMeta(),
        runtime: runtimeFor(db.runtime.db),
        session: { userId: users.anna },
        companySelector: companyB,
      }),
      PermissionDeniedError,
    );
    const nonexistent = await expectCoreError(
      createStaffContext({
        request: requestMeta(),
        runtime: runtimeFor(db.runtime.db),
        session: { userId: users.anna },
        companySelector: randomUUID(),
      }),
      PermissionDeniedError,
    );
    // Same client message — a denied caller cannot probe company existence.
    expect(foreign.clientMessage).toBe(nonexistent.clientMessage);
  });

  it("denies a user with no memberships at all", async () => {
    await expectCoreError(
      createStaffContext({
        request: requestMeta(),
        runtime: runtimeFor(db.runtime.db),
        session: { userId: users.carol },
        companySelector: companyA,
      }),
      PermissionDeniedError,
    );
  });

  it("applies permission precedence: owner-all, deny wins, grant, role default", async () => {
    const owner = await createStaffContext({
      request: requestMeta(),
      runtime: runtimeFor(db.runtime.db),
      session: { userId: users.anna },
      companySelector: companyA,
    });
    // Owner-all beats even the explicit deny row seeded for Anna.
    expect(staffHasPermission(owner.membership, "orders:view")).toBe(true);
    expect(staffHasPermission(owner.membership, "anything:atAll")).toBe(true);

    const manager = await createStaffContext({
      request: requestMeta(),
      runtime: runtimeFor(db.runtime.db),
      session: { userId: users.boris },
      companySelector: companyB,
    });
    // Deny wins over the manager role default.
    expect(staffHasPermission(manager.membership, "orders:create")).toBe(false);
    // Explicit grant outside the role defaults.
    expect(staffHasPermission(manager.membership, "pricing:manage")).toBe(true);
    // Role default without overrides.
    expect(staffHasPermission(manager.membership, "orders:view")).toBe(true);
    // Nothing grants this one.
    expect(staffHasPermission(manager.membership, "customers:view")).toBe(
      false,
    );
  });
});

type CrmRow = typeof fixtureCrmCustomers.$inferSelect;

/**
 * A typical customer resolver: loads the referenced resource and proves
 * ownership by the authenticated user; anything else is `NotFoundError`.
 */
async function resolveOwnCrmRecord(
  input: { customerId: string },
  env: TargetResolutionEnv,
): Promise<ResolvedTarget<CrmRow>> {
  if (env.principal.mode !== "customer") {
    throw new NotFoundError();
  }
  const rows = await env.tx
    .select()
    .from(fixtureCrmCustomers)
    .where(eq(fixtureCrmCustomers.id, input.customerId))
    .limit(1);
  const row = rows[0];
  if (row === undefined || row.userId !== env.principal.userId) {
    throw new NotFoundError();
  }
  return { companyId: row.companyId, resource: row };
}

describe("createCustomerContext", () => {
  it("resolves ownership through the typed resolver", async () => {
    const ctx = await createCustomerContext({
      request: requestMeta(),
      runtime: runtimeFor(db.runtime.db),
      session: { userId: parityIds.users.boris },
      input: { customerId: parityIds.crmSentinel },
      resolveTarget: resolveOwnCrmRecord,
    });

    expect(ctx.principal).toBe("customer");
    expect(ctx.userId).toBe(parityIds.users.boris);
    expect(ctx.target.companyId).toBe(parityIds.companies.published);
    expect(ctx.target.resource.id).toBe(parityIds.crmSentinel);
    expect(ctx.actor).toEqual({ type: "user", id: parityIds.users.boris });
    expect(effectiveCompanyId(ctx)).toBe(parityIds.companies.published);
  });

  it("turns a foreign resource into NotFoundError — no existence leak", async () => {
    // The row exists but belongs to Boris; Anna gets the same error as for
    // a nonexistent id.
    await expectCoreError(
      createCustomerContext({
        request: requestMeta(),
        runtime: runtimeFor(db.runtime.db),
        session: { userId: parityIds.users.anna },
        input: { customerId: parityIds.crmSentinel },
        resolveTarget: resolveOwnCrmRecord,
      }),
      NotFoundError,
    );
  });

  it("denies without a session", async () => {
    await expectCoreError(
      createCustomerContext({
        request: requestMeta(),
        runtime: runtimeFor(db.runtime.db),
        session: null,
        input: { customerId: parityIds.crmSentinel },
        resolveTarget: resolveOwnCrmRecord,
      }),
      PermissionDeniedError,
    );
  });

  it("hands the resolver a read-only capability even over a writable runtime", async () => {
    let seenEnv: TargetResolutionEnv | undefined;
    await createCustomerContext({
      request: requestMeta(),
      runtime: runtimeFor(db.runtime.db),
      session: { userId: parityIds.users.boris },
      input: { customerId: parityIds.crmSentinel },
      resolveTarget: async (input: { customerId: string }, env) => {
        seenEnv = env;
        return resolveOwnCrmRecord(input, env);
      },
    });
    expect(seenEnv).toBeDefined();
    // The facade simply has no mutation members — nothing to escape to.
    const resolverTx = seenEnv?.tx ?? {};
    expect("insert" in resolverTx).toBe(false);
    expect("execute" in resolverTx).toBe(false);
    expect(Object.keys(resolverTx).sort()).toEqual([
      "$count",
      "select",
      "selectDistinct",
      "selectDistinctOn",
    ]);
  });

  it("treats a nested resolver crossing tenants as a core invariant violation", async () => {
    await expectCoreError(
      createCustomerContext({
        request: requestMeta(),
        runtime: runtimeFor(db.runtime.db),
        session: { userId: parityIds.users.boris },
        input: { customerId: parityIds.crmSentinel },
        resolveTarget: resolveOwnCrmRecord,
        // The caller's verified scope differs from what the resolver returns.
        inheritedCompanyId: parityIds.companies.unpublished,
      }),
      CoreInvariantError,
    );
  });
});

type FixtureCompanyRow = typeof fixtureCompanies.$inferSelect;

/** A typical public-target resolver: the publication state is the proof. */
async function resolvePublishedCompany(
  input: { companyId: string },
  env: TargetResolutionEnv,
): Promise<ResolvedTarget<FixtureCompanyRow>> {
  const rows = await env.tx
    .select()
    .from(fixtureCompanies)
    .where(eq(fixtureCompanies.id, input.companyId))
    .limit(1);
  const row = rows[0];
  if (row === undefined || !row.published) {
    throw new NotFoundError();
  }
  return { companyId: row.id, resource: row };
}

describe("createPublicContext — target scope", () => {
  it("resolves a published company anonymously", async () => {
    const ctx = await createPublicContext({
      request: requestMeta(),
      runtime: runtimeFor<ReadTx>(db.runtime.db),
      publicScope: "target",
      input: { companyId: parityIds.companies.published },
      resolveTarget: resolvePublishedCompany,
    });

    expect(ctx.principal).toBe("public");
    expect(ctx.scope).toBe("target");
    expect(ctx.actor).toEqual({ type: "anonymous", id: "anonymous" });
    expect(ctx.clientIp).toBe("203.0.113.7");
    expect(ctx.target.companyId).toBe(parityIds.companies.published);
    expect(effectiveCompanyId(ctx)).toBe(parityIds.companies.published);
  });

  it("hides an unpublished company behind NotFoundError", async () => {
    await expectCoreError(
      createPublicContext({
        request: requestMeta(),
        runtime: runtimeFor<ReadTx>(db.runtime.db),
        publicScope: "target",
        input: { companyId: parityIds.companies.unpublished },
        resolveTarget: resolvePublishedCompany,
      }),
      NotFoundError,
    );
  });

  it("refuses to construct without a trusted-proxy clientIp", async () => {
    await expectCoreError(
      createPublicContext({
        request: {
          action: "fixture.doThing",
          requestId: randomUUID(),
          correlationId: randomUUID(),
          channel: "ui",
        },
        runtime: runtimeFor<ReadTx>(db.runtime.db),
        publicScope: "target",
        input: { companyId: parityIds.companies.published },
        resolveTarget: resolvePublishedCompany,
      }),
      CoreInvariantError,
    );
  });
});

describe("createPublicContext — globalProjection scope", () => {
  it("binds the context to the declared grant with no resolver and no company", async () => {
    const ctx = await createPublicContext({
      request: requestMeta(),
      runtime: runtimeFor<ReadTx>(db.runtime.db),
      publicScope: "globalProjection",
      grant: fixtureDiscoveryGrant,
    });

    expect(ctx.principal).toBe("public");
    expect(ctx.scope).toBe("globalProjection");
    expect(ctx.projectionGrant).toBe("fixture.discovery");
    expect(ctx.actor).toEqual({ type: "anonymous", id: "anonymous" });
    expect(ctx.companyId).toBeUndefined();
    expect(effectiveCompanyId(ctx)).toBeNull();
  });

  it("exposes only granted tables and allowlisted columns", async () => {
    const ctx = await createPublicContext({
      request: requestMeta(),
      runtime: runtimeFor<ReadTx>(db.runtime.db),
      publicScope: "globalProjection",
      grant: fixtureDiscoveryGrant,
    });

    const rows = await ctx.db.from("discoveryCompanies");
    expect(rows).toHaveLength(1);
    // `internal_note` is seeded in the projection table but not granted.
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      "companyId",
      "followerCount",
      "name",
      "productCount",
    ]);
    // The capability has no generic query surface to escape through: the
    // facade carries `from` over granted tables and nothing else.
    expect("select" in ctx.db).toBe(false);
    expect("insert" in ctx.db).toBe(false);
    expect("execute" in ctx.db).toBe(false);
  });
});

describe("createSystemContext", () => {
  it("tenant scope carries the explicit companyId", () => {
    const ctx = createSystemContext(
      "outbox-dispatcher",
      { scope: "tenant", companyId: companyA },
      {
        request: requestMeta({ channel: "system" }),
        runtime: runtimeFor(db.runtime.db),
      },
    );
    expect(ctx.principal).toBe("system");
    expect(ctx.serviceName).toBe("outbox-dispatcher");
    expect(ctx.scope).toBe("tenant");
    expect(ctx.companyId).toBe(companyA);
    expect(ctx.actor).toEqual({ type: "system", id: "outbox-dispatcher" });
    expect(effectiveCompanyId(ctx)).toBe(companyA);
  });

  it("global scope carries no company at all", () => {
    const ctx = createSystemContext(
      "np-dictionary-sync",
      { scope: "global" },
      {
        request: requestMeta({ channel: "system" }),
        runtime: runtimeFor(db.runtime.db),
      },
    );
    expect(ctx.scope).toBe("global");
    expect(ctx.companyId).toBeUndefined();
    expect(effectiveCompanyId(ctx)).toBeNull();
  });

  it("rejects an empty service name and a malformed tenant companyId", () => {
    expect(() =>
      createSystemContext(
        "",
        { scope: "global" },
        {
          request: requestMeta({ channel: "system" }),
          runtime: runtimeFor(db.runtime.db),
        },
      ),
    ).toThrow(CoreInvariantError);
    expect(() =>
      createSystemContext(
        "outbox-dispatcher",
        { scope: "tenant", companyId: "not-a-uuid" },
        {
          request: requestMeta({ channel: "system" }),
          runtime: runtimeFor(db.runtime.db),
        },
      ),
    ).toThrow(CoreInvariantError);
  });
});

describe("createConsumerContext", () => {
  it("requires a session and carries no company, membership, or target", () => {
    expect(() =>
      createConsumerContext({
        request: requestMeta(),
        runtime: runtimeFor<ReadTx>(db.runtime.db),
        session: null,
      }),
    ).toThrow(PermissionDeniedError);

    const ctx = createConsumerContext({
      request: requestMeta(),
      runtime: runtimeFor<ReadTx>(db.runtime.db),
      session: { userId: users.anna },
    });
    expect(ctx.principal).toBe("consumer");
    expect(ctx.userId).toBe(users.anna);
    expect(ctx.clientIp).toBe("203.0.113.7");
    expect(ctx.companyId).toBeUndefined();
    expect(ctx.membership).toBeUndefined();
    expect(ctx.target).toBeUndefined();
    expect(effectiveCompanyId(ctx)).toBeNull();
    // Consumer is read-only by construction, not just by type.
    expect("insert" in ctx.db).toBe(false);
  });

  it("refuses to construct without a clientIp", () => {
    expect(() =>
      createConsumerContext({
        request: {
          action: "fixture.doThing",
          requestId: randomUUID(),
          correlationId: randomUUID(),
          channel: "ui",
        },
        runtime: runtimeFor<ReadTx>(db.runtime.db),
        session: { userId: users.anna },
      }),
    ).toThrow(CoreInvariantError);
  });
});

describe("createAccountContext", () => {
  it("requires a session and carries no company scope while keeping the writable capability", () => {
    expect(() =>
      createAccountContext({
        request: requestMeta(),
        runtime: runtimeFor(db.runtime.db),
        session: null,
      }),
    ).toThrow(PermissionDeniedError);

    const runtime = runtimeFor(db.runtime.db);
    const ctx = createAccountContext({
      request: requestMeta(),
      runtime,
      session: { userId: users.boris },
    });
    expect(ctx.principal).toBe("account");
    expect(ctx.userId).toBe(users.boris);
    expect(ctx.companyId).toBeUndefined();
    expect(ctx.membership).toBeUndefined();
    expect(ctx.target).toBeUndefined();
    expect(effectiveCompanyId(ctx)).toBeNull();
    // Account writes go through the capability the pipeline grants for the
    // action's declared risk — the factory does not narrow it.
    expect(ctx.db).toBe(runtime.db);
  });
});

const SHARE = {
  token: "factory-share-token",
  expired: "factory-share-expired",
  revoked: "factory-share-revoked",
  documentId: randomUUID(),
} as const;

function hashShare(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function resolveFactoryShare(
  input: { token: string; documentId: string },
  env: TargetResolutionEnv,
): Promise<ResolvedTarget<{ documentId: string }>> {
  if (env.principal.mode !== "share") {
    throw new NotFoundError();
  }
  if (input.token === SHARE.expired || input.token === SHARE.revoked) {
    throw new NotFoundError();
  }
  if (input.token !== SHARE.token || input.documentId !== SHARE.documentId) {
    throw new NotFoundError();
  }
  return Promise.resolve({
    companyId: companyA,
    resource: { documentId: input.documentId },
    tokenHash: hashShare(input.token),
  });
}

describe("createShareContext", () => {
  it("constructs without a session and binds the stored token hash", async () => {
    const ctx = await createShareContext({
      request: requestMeta(),
      runtime: runtimeFor<ReadTx>(db.runtime.db),
      input: { token: SHARE.token, documentId: SHARE.documentId },
      resolveTarget: resolveFactoryShare,
    });
    expect(ctx.principal).toBe("share");
    expect(ctx.actor).toEqual({ type: "anonymous", id: "anonymous" });
    expect(ctx.clientIp).toBe("203.0.113.7");
    expect(ctx.target.companyId).toBe(companyA);
    expect(ctx.tokenHash).toBe(hashShare(SHARE.token));
    expect(ctx.tokenHash).not.toBe(SHARE.token);
    expect(ctx.userId).toBeUndefined();
    expect(effectiveCompanyId(ctx)).toBe(companyA);
  });

  it("hides expired, revoked, and mismatched tokens behind NotFoundError", async () => {
    const runtime = runtimeFor<ReadTx>(db.runtime.db);
    await expectCoreError(
      createShareContext({
        request: requestMeta(),
        runtime,
        input: { token: SHARE.expired, documentId: SHARE.documentId },
        resolveTarget: resolveFactoryShare,
      }),
      NotFoundError,
    );
    await expectCoreError(
      createShareContext({
        request: requestMeta(),
        runtime,
        input: { token: SHARE.revoked, documentId: SHARE.documentId },
        resolveTarget: resolveFactoryShare,
      }),
      NotFoundError,
    );
    await expectCoreError(
      createShareContext({
        request: requestMeta(),
        runtime,
        input: { token: SHARE.token, documentId: randomUUID() },
        resolveTarget: resolveFactoryShare,
      }),
      NotFoundError,
    );
  });

  it("treats a resolver that omits tokenHash as a core invariant violation", async () => {
    await expectCoreError(
      createShareContext({
        request: requestMeta(),
        runtime: runtimeFor<ReadTx>(db.runtime.db),
        input: { token: SHARE.token, documentId: SHARE.documentId },
        resolveTarget: () =>
          Promise.resolve({
            companyId: companyA,
            resource: { documentId: SHARE.documentId },
          }),
      }),
      CoreInvariantError,
    );
  });

  it("treats a nested resolver crossing tenants as a core invariant violation", async () => {
    await expectCoreError(
      createShareContext({
        request: requestMeta(),
        runtime: runtimeFor<ReadTx>(db.runtime.db),
        input: { token: SHARE.token, documentId: SHARE.documentId },
        resolveTarget: resolveFactoryShare,
        inheritedCompanyId: companyB,
      }),
      CoreInvariantError,
    );
  });

  it("refuses to construct without a trusted-proxy clientIp", async () => {
    await expectCoreError(
      createShareContext({
        request: {
          action: "fixture.doThing",
          requestId: randomUUID(),
          correlationId: randomUUID(),
          channel: "ui",
        },
        runtime: runtimeFor<ReadTx>(db.runtime.db),
        input: { token: SHARE.token, documentId: SHARE.documentId },
        resolveTarget: resolveFactoryShare,
      }),
      CoreInvariantError,
    );
  });
});

describe("log binding (security-operations §6)", () => {
  it("binds request/actor/company/action onto every staff log line", async () => {
    const { logger, entries } = captureLogger();
    const request = requestMeta({
      channel: "ai",
      aiTraceId: "trace-1",
      toolCallId: "tool-1",
    });
    const ctx = await createStaffContext({
      request,
      runtime: runtimeFor(db.runtime.db, logger),
      session: { userId: users.anna },
      companySelector: companyA,
    });
    ctx.log.info("hello");

    const [line] = entries();
    expect(line).toMatchObject({
      request_id: request.requestId,
      correlation_id: request.correlationId,
      action: "fixture.doThing",
      channel: "ai",
      actor_type: "user",
      actor_id: users.anna,
      company_id: companyA,
      ai_trace_id: "trace-1",
      tool_call_id: "tool-1",
      msg: "hello",
    });
    // Raw IPs are transport/rate-limit data, never a bound log field.
    expect(line).not.toHaveProperty("clientIp");
    expect(line).not.toHaveProperty("client_ip");
  });

  it("binds the anonymous actor and a null company for public-global", async () => {
    const { logger, entries } = captureLogger();
    const ctx = await createPublicContext({
      request: requestMeta(),
      runtime: runtimeFor<ReadTx>(db.runtime.db, logger),
      publicScope: "globalProjection",
      grant: fixtureDiscoveryGrant,
    });
    ctx.log.info("browsing");

    const [line] = entries();
    expect(line).toMatchObject({
      actor_type: "anonymous",
      actor_id: "anonymous",
      company_id: null,
      msg: "browsing",
    });
  });

  it("binds the anonymous actor for share and never logs the raw token", async () => {
    const { logger, entries } = captureLogger();
    const ctx = await createShareContext({
      request: requestMeta(),
      runtime: runtimeFor<ReadTx>(db.runtime.db, logger),
      input: { token: SHARE.token, documentId: SHARE.documentId },
      resolveTarget: resolveFactoryShare,
    });
    ctx.log.info("co-signing");

    const [line] = entries();
    expect(line).toMatchObject({
      actor_type: "anonymous",
      actor_id: "anonymous",
      company_id: companyA,
      msg: "co-signing",
    });
    expect(JSON.stringify(line)).not.toContain(SHARE.token);
    expect(line).not.toHaveProperty("clientIp");
    expect(line).not.toHaveProperty("client_ip");
  });
});
