import { randomUUID } from "node:crypto";

import {
  ConflictError,
  CoreInvariantError,
  PermissionDeniedError,
  ValidationError,
} from "@showzy/core/errors";
import {
  accountIsolationSuite,
  createTestKit,
  crossTenantSuite,
  idempotencySuite,
  isolationCase,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { auditLog, domainEvents } from "@showzy/db";
import { user } from "@showzy/db/schema/auth";
import { companies, companyMembers } from "@showzy/db/schema/companies";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createCompany } from "./create.js";

const users = {
  creator: randomUUID(),
  rival: randomUUID(),
  replay: randomUUID(),
  raceA: randomUUID(),
  raceB: randomUUID(),
  prefix: randomUUID(),
  idem: randomUUID(),
  rollback: randomUUID(),
};

/**
 * The inherited account rate-limit assertion replays the exact identical
 * own creation, so the suite inputs are the kit companies' own name/slug
 * pairs — the domain-level replay returns the existing company instead of
 * creating rows or conflicting.
 */
const annaOwnCreate = {
  name: "Konditerska Anna",
  slug: "konditerska-anna",
};
const borisOwnCreate = {
  name: "Maisternya Boris",
  slug: "maisternya-boris",
};

let kit: TestKit;

async function countCompanies(): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ id: companies.id })
    .from(companies);
  return rows.length;
}

async function companyRowsBySlug(slug: string) {
  return kit.db.runtime.db
    .select()
    .from(companies)
    .where(eq(companies.slug, slug));
}

async function membershipRowsByCompany(companyId: string) {
  return kit.db.runtime.db
    .select()
    .from(companyMembers)
    .where(eq(companyMembers.companyId, companyId));
}

beforeAll(async () => {
  kit = await createTestKit();

  await kit.db.runtime.db.insert(user).values(
    Object.entries(users).map(([key, id]) => ({
      id,
      name: `Create ${key}`,
      email: `${key}@companies-create.test`,
    })),
  );

  // Occupies the "TT" numbering prefix so collision handling is observable.
  await kit.db.runtime.db.insert(companies).values({
    name: "Taken Prefix Co",
    slug: "taken-prefix-co",
    prefix: "TT",
  });
});

afterAll(async () => {
  await kit.db.close();
});

crossTenantSuite(
  () => kit,
  [
    isolationCase(
      createCompany,
      { input: annaOwnCreate, userId: kitIdentities.users.anna },
      { input: borisOwnCreate, userId: kitIdentities.users.boris },
      { noReference: true },
    ),
  ],
);

accountIsolationSuite(
  () => kit,
  [
    isolationCase(
      createCompany,
      { input: annaOwnCreate, userId: kitIdentities.users.anna },
      { input: borisOwnCreate, userId: kitIdentities.users.boris },
      { noReference: true },
    ),
  ],
);

idempotencySuite(
  () => kit,
  [
    {
      action: createCompany,
      input: { name: "Idem Co", slug: "idem-co" },
      conflictingInput: { name: "Idem Co Other", slug: "idem-co-other" },
      actor: { userId: users.idem },
      readEffect: () => countCompanies(),
      freshInput: () => ({ name: "Idem Concurrent", slug: "idem-concurrent" }),
    },
  ],
);

describe("companies.create", () => {
  it("creates one company and one owner membership and audits once with null company scope", async () => {
    const requestId = randomUUID();
    const result = await kit.invoke(
      createCompany,
      { name: "  Nova Pekarnya  ", slug: "nova-pekarnya" },
      { userId: users.creator },
      { request: { requestId } },
    );

    expect(result.role).toBe("owner");
    expect(result.permissions).toEqual([]);
    expect(result.company.name).toBe("Nova Pekarnya");
    expect(result.company.slug).toBe("nova-pekarnya");
    expect(result.company.prefix).toBe("NP");

    const companyRows = await companyRowsBySlug("nova-pekarnya");
    expect(companyRows).toHaveLength(1);
    expect(companyRows[0]).toMatchObject({
      id: result.company.id,
      name: "Nova Pekarnya",
      prefix: "NP",
    });

    const memberships = await membershipRowsByCompany(result.company.id);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({
      id: result.membershipId,
      userId: users.creator,
      role: "owner",
      permissions: { granted: [], denied: [] },
    });

    const auditRows = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "companies.create",
      companyId: null,
      actorType: "user",
      actorId: users.creator,
      targetType: "company",
      targetId: result.company.id,
      outcome: "ok",
      inputSnapshot: null,
    });

    const eventRows = await kit.db.runtime.db
      .select({ id: domainEvents.id })
      .from(domainEvents)
      .where(eq(domainEvents.requestId, requestId));
    expect(eventRows).toEqual([]);
  });

  it("denies a call without a session (defense in depth behind the 401 gate)", async () => {
    await expect(
      kit.buildTestContext("account", { session: null }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("rejects blank/oversized names, malformed slugs, and identifier fields", async () => {
    const valid = { name: "Valid Name", slug: "valid-slug" };
    const invalidInputs: unknown[] = [
      { name: "   ", slug: "valid-slug" },
      { name: "x".repeat(121), slug: "valid-slug" },
      { name: "Valid Name", slug: "ab" },
      { name: "Valid Name", slug: "-abc" },
      { name: "Valid Name", slug: "Upper-Case" },
      { ...valid, companyId: kitIdentities.companies.a },
      { ...valid, userId: users.rival },
      { ...valid, role: "owner" },
      { ...valid, prefix: "XX" },
      null,
    ];
    for (const input of invalidInputs) {
      await expect(
        kit.invoke(createCompany, input, { userId: users.creator }),
      ).rejects.toBeInstanceOf(ValidationError);
    }
    expect(await companyRowsBySlug("valid-slug")).toHaveLength(0);
  });

  it("rejects a missing idempotency key", async () => {
    await expect(
      kit.invoke(
        createCompany,
        { name: "Keyless Co", slug: "keyless-co" },
        { userId: users.creator },
        { request: { idempotencyKey: "" } },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await companyRowsBySlug("keyless-co")).toHaveLength(0);
  });

  it("maps an occupied slug to a typed conflict without leaking the occupying company", async () => {
    await kit.invoke(
      createCompany,
      { name: "Rival Co", slug: "shared-slug" },
      { userId: users.rival },
    );

    const foreignAttempt = await kit
      .invoke(
        createCompany,
        { name: "Creator Co", slug: "shared-slug" },
        { userId: users.creator },
      )
      .then(
        () => {
          throw new Error("expected ConflictError");
        },
        (error: unknown) => error,
      );
    expect(foreignAttempt).toBeInstanceOf(ConflictError);
    if (foreignAttempt instanceof ConflictError) {
      expect(foreignAttempt.clientMessage).toBe(
        "This company address is already taken.",
      );
      expect(foreignAttempt.clientMessage).not.toContain("Rival");
    }

    // The owner re-submitting with a different name is a new logical
    // request against an occupied slug, not a replay.
    await expect(
      kit.invoke(
        createCompany,
        { name: "Rival Co Renamed", slug: "shared-slug" },
        { userId: users.rival },
      ),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(await companyRowsBySlug("shared-slug")).toHaveLength(1);
  });

  it("replays the identical own creation instead of duplicating or conflicting", async () => {
    const first = await kit.invoke(
      createCompany,
      { name: "Replay Co", slug: "replay-co" },
      { userId: users.replay },
    );
    const second = await kit.invoke(
      createCompany,
      { name: "Replay Co", slug: "replay-co" },
      { userId: users.replay },
    );
    expect(second).toEqual(first);
    expect(await companyRowsBySlug("replay-co")).toHaveLength(1);
    expect(await membershipRowsByCompany(first.company.id)).toHaveLength(1);
  });

  it("commits exactly one company when concurrent creations race the same slug", async () => {
    const results = await Promise.allSettled([
      kit.invoke(
        createCompany,
        { name: "Race Alpha", slug: "race-slug" },
        { userId: users.raceA },
      ),
      kit.invoke(
        createCompany,
        { name: "Race Beta", slug: "race-slug" },
        { userId: users.raceB },
      ),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const rejection = rejected[0];
    expect(rejection?.status).toBe("rejected");
    if (rejection?.status === "rejected") {
      expect(rejection.reason instanceof ConflictError).toBe(true);
    }

    const rows = await companyRowsBySlug("race-slug");
    expect(rows).toHaveLength(1);
    const winner = rows[0];
    expect(winner).toBeDefined();
    if (winner !== undefined) {
      expect(await membershipRowsByCompany(winner.id)).toHaveLength(1);
    }
  });

  it("generates non-empty unique prefixes for punctuation, non-Latin, and colliding names", async () => {
    const cyrillic = await kit.invoke(
      createCompany,
      { name: "Кав'ярня Затишок", slug: "zatyshok" },
      { userId: users.prefix },
    );
    expect(cyrillic.company.prefix).toBe("CO");

    const punctuation = await kit.invoke(
      createCompany,
      { name: "«—»!!!", slug: "punctuation-only" },
      { userId: users.prefix },
    );
    expect(punctuation.company.prefix).toBe("CO2");

    const collided = await kit.invoke(
      createCompany,
      { name: "Tip Top", slug: "tip-top" },
      { userId: users.prefix },
    );
    expect(collided.company.prefix).toBe("TT2");

    const collidedAgain = await kit.invoke(
      createCompany,
      { name: "Tiny Turtle", slug: "tiny-turtle" },
      { userId: users.prefix },
    );
    expect(collidedAgain.company.prefix).toBe("TT3");

    const singleWord = await kit.invoke(
      createCompany,
      { name: "Zavod", slug: "zavod-solo" },
      { userId: users.prefix },
    );
    expect(singleWord.company.prefix).toBe("ZA");
  });

  it("rolls the company and membership back together on a real transaction failure", async () => {
    const failingDeps = {
      ...kit.pipeline,
      hooks: {
        ...kit.pipeline.hooks,
        audit: {
          recordSuccess: () =>
            Promise.reject(new Error("injected in-transaction failure")),
          recordFailure: () => Promise.resolve(),
        },
      },
    };
    await expect(
      kit.invoke(
        createCompany,
        { name: "Rollback Co", slug: "rollback-co" },
        { userId: users.rollback },
        { deps: failingDeps },
      ),
    ).rejects.toBeInstanceOf(CoreInvariantError);

    expect(await companyRowsBySlug("rollback-co")).toHaveLength(0);
    const memberships = await kit.db.runtime.db
      .select({ id: companyMembers.id })
      .from(companyMembers)
      .where(eq(companyMembers.userId, users.rollback));
    expect(memberships).toEqual([]);
  });

  it("never creates a membership for anyone but the verified caller", async () => {
    const result = await kit.invoke(
      createCompany,
      { name: "Sole Owner Co", slug: "sole-owner-co" },
      { userId: users.creator },
    );
    const memberships = await membershipRowsByCompany(result.company.id);
    expect(memberships.map((row) => row.userId)).toEqual([users.creator]);
  });
});
