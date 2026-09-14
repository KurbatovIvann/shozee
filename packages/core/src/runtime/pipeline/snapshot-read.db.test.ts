import { randomUUID } from "node:crypto";

import { auditLog, companies, companyMembers, type ReadTx } from "@showzy/db";
import { user } from "@showzy/db/schema/auth";
import { createTestDatabase, type TestDatabase } from "@showzy/db/testing";
import {
  createParityFixtureTables,
  fixtureProducts,
} from "@showzy/db/testing/fixtures";
import { and, eq } from "drizzle-orm";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineActionContract } from "../../contract/define-action-contract.js";
import { CoreInvariantError } from "../../errors/index.js";
import { createAuditHook } from "../audit/create-audit-hook.js";
import type { ActionCtxFor } from "../context/types.js";
import {
  implementAction,
  type ImplementedAction,
} from "../implement-action.js";
import { executeAction } from "./execute-action.js";
import type { ActionPipelineDeps } from "./types.js";

let db: TestDatabase;

const annaId = "user_snapshot_anna";
const companyId = randomUUID();

beforeAll(async () => {
  db = await createTestDatabase();
  await db.runtime.db
    .insert(user)
    .values({ id: annaId, name: "Anna", email: "anna@snapshot-read.test" });
  await db.runtime.db.insert(companies).values({
    id: companyId,
    name: "Snapshot Co",
    slug: "snapshot-co",
    prefix: "SN",
  });
  await db.runtime.db.insert(companyMembers).values({
    companyId,
    userId: annaId,
    role: "owner",
    permissions: { granted: [], denied: [] },
  });
  await createParityFixtureTables(db.admin);
});

afterAll(async () => {
  await db.close();
});

const silentLogger = pino({ enabled: false });

function deps(): ActionPipelineDeps {
  return {
    db: db.runtime.db,
    logger: silentLogger,
    hooks: {
      rateLimit: { enforce: () => Promise.resolve() },
      audit: createAuditHook({ db: db.runtime.db, logger: silentLogger }),
    },
  };
}

const contractDefaults = {
  transport: "internal",
  aiExposure: "internal",
  principal: "staff",
  risk: "read",
  requiresConfirmation: false,
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: [],
  timeout: 5_000,
} as const;

const productInput = z.object({ productId: z.uuid() });
const sightings = z.object({
  before: z.string(),
  after: z.string(),
  viaCall: z.string(),
});

async function productName(tx: ReadTx, productId: string): Promise<string> {
  const rows = await tx
    .select({ name: fixtureProducts.name })
    .from(fixtureProducts)
    .where(
      and(
        eq(fixtureProducts.id, productId),
        eq(fixtureProducts.companyId, companyId),
      ),
    );
  return rows[0]?.name ?? "missing";
}

async function renameOnSecondConnection(productId: string): Promise<void> {
  await db.runtime.db
    .update(fixtureProducts)
    .set({ name: "Renamed" })
    .where(eq(fixtureProducts.id, productId));
}

async function seedProduct(): Promise<string> {
  const productId = randomUUID();
  await db.runtime.db
    .insert(fixtureProducts)
    .values({ id: productId, companyId, name: "Original", published: false });
  return productId;
}

const readNameCallee = implementAction(
  defineActionContract({
    ...contractDefaults,
    name: "snapshotCallee.readName",
    description: "Reads a fixture product name for snapshot composition tests.",
    input: productInput,
    output: z.object({ name: z.string() }),
    permissions: ["snapshotCallee:read"],
    audit: false,
  }),
  {
    handler: async (input, ctx) => ({
      name: await productName(ctx.db, input.productId),
    }),
  },
);

const readAcrossRaceHandler = {
  handler: async (
    input: z.output<typeof productInput>,
    ctx: ActionCtxFor<"staff">,
  ) => {
    const before = await productName(ctx.db, input.productId);
    await renameOnSecondConnection(input.productId);
    const after = await productName(ctx.db, input.productId);
    const { name: viaCall } = await ctx.call(readNameCallee, {
      productId: input.productId,
    });
    return { before, after, viaCall };
  },
};

const snapshotRead = implementAction(
  defineActionContract({
    ...contractDefaults,
    name: "snapshotRoot.readSnapshot",
    description:
      "Reads a product twice around a racing commit in one snapshot.",
    input: productInput,
    output: sightings,
    permissions: ["snapshotRoot:read"],
    audit: false,
    consistency: "snapshot",
  }),
  readAcrossRaceHandler,
);

const defaultRead = implementAction(
  defineActionContract({
    ...contractDefaults,
    name: "snapshotRoot.readDefault",
    description:
      "Reads a product twice around a racing commit without a snapshot.",
    input: productInput,
    output: sightings,
    permissions: ["snapshotRoot:read"],
    audit: false,
  }),
  readAcrossRaceHandler,
);

const auditedSnapshotRead = implementAction(
  defineActionContract({
    ...contractDefaults,
    name: "snapshotRoot.readAudited",
    description: "Audited snapshot read around a racing commit.",
    input: productInput,
    output: sightings,
    permissions: ["snapshotRoot:read"],
    audit: true,
    consistency: "snapshot",
  }),
  {
    ...readAcrossRaceHandler,
    auditTarget: ({ input }) => ({
      type: "fixture-product",
      id: productInput.parse(input).productId,
    }),
  },
);

function invoke(
  action: ImplementedAction,
  productId: string,
  requestId: string = randomUUID(),
) {
  return executeAction(deps(), {
    action,
    input: { productId },
    request: {
      requestId,
      correlationId: randomUUID(),
      channel: "ui",
      clientIp: "203.0.113.7",
    },
    principal: {
      mode: "staff",
      session: { userId: annaId },
      companySelector: companyId,
    },
  });
}

describe("consistency: snapshot", () => {
  it("keeps a racing committed write invisible to the handler and its ctx.call reads", async () => {
    const productId = await seedProduct();

    const output = await invoke(snapshotRead, productId);

    expect(output).toEqual({
      before: "Original",
      after: "Original",
      viaCall: "Original",
    });
    expect(await productName(db.runtime.db, productId)).toBe("Renamed");
  });

  it("shows the racing committed write to a read without the declaration", async () => {
    const productId = await seedProduct();

    const output = await invoke(defaultRead, productId);

    expect(output).toEqual({
      before: "Original",
      after: "Renamed",
      viaCall: "Renamed",
    });
  });

  it("rejects a snapshot callee reached through ctx.call from a default read", async () => {
    let calleeRan = 0;
    const snapshotCallee = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "snapshotCallee.readLive",
        description: "Snapshot read that a default caller cannot compose.",
        input: productInput,
        output: z.object({ name: z.string() }),
        permissions: ["snapshotCallee:read"],
        audit: false,
        consistency: "snapshot",
      }),
      {
        handler: async (input, ctx) => {
          calleeRan += 1;
          return { name: await productName(ctx.db, input.productId) };
        },
      },
    );
    const defaultCaller = implementAction(
      defineActionContract({
        ...contractDefaults,
        name: "snapshotRoot.callSnapshot",
        description: "Default read that calls a snapshot read.",
        input: productInput,
        output: z.object({ name: z.string() }),
        permissions: ["snapshotRoot:read"],
        audit: false,
      }),
      {
        handler: (input, ctx) =>
          ctx.call(snapshotCallee, { productId: input.productId }),
      },
    );

    const outcome = invoke(defaultCaller, await seedProduct());

    await expect(outcome).rejects.toBeInstanceOf(CoreInvariantError);
    await expect(outcome).rejects.toThrow(
      'its caller must declare consistency: "snapshot" too',
    );
    expect(calleeRan).toBe(0);
  });

  it("still writes the post-commit audit row of an audited snapshot read", async () => {
    const productId = await seedProduct();
    const requestId = randomUUID();

    const output = await invoke(auditedSnapshotRead, productId, requestId);

    expect(sightings.parse(output).after).toBe("Original");
    const rows = await db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("ok");
    expect(rows[0]?.action).toBe("snapshotRoot.readAudited");
    expect(rows[0]?.targetId).toBe(productId);
  });
});
