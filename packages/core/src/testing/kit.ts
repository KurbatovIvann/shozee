/**
 * The module test kit world (fnd-T21 — core.md §12): one Testcontainers
 * database seeded with the parity fixtures plus the companies/membership
 * rows the staff and system-tenant factories need, plus `buildTestContext`
 * and a pipeline `invoke` so isolation suites run real actions.
 *
 * Construction of an `ActionCtx` still goes through the seven principal
 * factories — the kit never assembles a context by hand.
 */
import { randomUUID } from "node:crypto";

import {
  companies,
  companyMembers,
  createProjectionGrantManifest,
  type ProjectionGrant,
} from "@showzy/db";
import { user } from "@showzy/db/schema/auth";
import { createTestDatabase, type TestDatabase } from "@showzy/db/testing";
import {
  createParityFixtureTables,
  fixtureCompanies,
  fixtureCrmCustomers,
  fixtureDiscoveryGrant,
  fixtureProducts,
  seedParityFixtures,
} from "@showzy/db/testing/fixtures";
import { eq } from "drizzle-orm";
import { pino, type Logger } from "pino";
import type { z } from "zod";

import type { ActionPrincipal, PublicScope } from "../contract/types.js";
import { NotFoundError } from "../errors/index.js";
import { createAuditHook } from "../runtime/audit/create-audit-hook.js";
import {
  createAccountContext,
  createConsumerContext,
  createCustomerContext,
  createPublicContext,
  createShareContext,
  createStaffContext,
  createSystemContext,
  type ActionRequestMeta,
  type ContextRuntime,
  type SessionPrincipal,
  type SystemScopeInput,
} from "../runtime/context/factories.js";
import type { ActionCtx } from "../runtime/context/types.js";
import { createIdempotencyHook } from "../runtime/idempotency/create-idempotency-hook.js";
import type { ImplementedAction } from "../runtime/implement-action.js";
import { executeAction } from "../runtime/pipeline/execute-action.js";
import type {
  ActionPipelineDeps,
  PipelineHooks,
  PipelineRequestMeta,
  PrincipalInvocation,
} from "../runtime/pipeline/types.js";
import { createRateLimitHook } from "../runtime/rate-limit/create-rate-limit-hook.js";
import { createInMemoryRateLimitStore } from "../runtime/rate-limit/token-bucket.js";
import type {
  ResolvedTarget,
  TargetResolutionEnv,
  TargetResolver,
} from "../runtime/types.js";
import { checkInvokeActionError } from "./declared-errors.js";
import { kitIdentities, type KitIdentities } from "./identities.js";
import {
  kitShareDocuments,
  kitShareTokens,
  resolveKitShareTarget,
} from "./share-fixture.js";

export interface IsolationActor {
  readonly userId?: string;
  readonly companyId?: string;
  readonly serviceName?: string;
  readonly clientIp?: string;
}

export interface InvokeOptions {
  readonly deps?: ActionPipelineDeps;
  readonly request?: Partial<PipelineRequestMeta>;
}

export interface BuildTestContextOverrides {
  readonly userId?: string;
  readonly companyId?: string;
  /** Raw `x-company-id`; `null` means "omit the selector". */
  readonly companySelector?: string | null;
  readonly session?: SessionPrincipal | null;
  readonly input?: unknown;
  readonly resolveTarget?: TargetResolver<z.ZodType, unknown>;
  readonly publicScope?: PublicScope;
  readonly grant?: ProjectionGrant;
  readonly serviceName?: string;
  readonly systemScope?: SystemScopeInput;
  readonly request?: Partial<ActionRequestMeta>;
  readonly logger?: Logger;
}

export interface TestKit {
  readonly db: TestDatabase;
  readonly identities: KitIdentities;
  readonly pipeline: ActionPipelineDeps;
  buildTestContext(
    mode: ActionPrincipal,
    overrides?: BuildTestContextOverrides,
  ): Promise<ActionCtx>;
  invoke<
    TInput extends z.ZodType,
    TOutput extends z.ZodType,
    TTarget = unknown,
  >(
    action: ImplementedAction<TInput, TOutput, TTarget>,
    input: unknown,
    actor?: IsolationActor,
    options?: InvokeOptions,
  ): Promise<z.output<TOutput>>;
}

const silentLogger = pino({ enabled: false });
const DEFAULT_CLIENT_IP = "203.0.113.7";
const DEFAULT_SERVICE = "test-kit";
const KIT_IP_HMAC_SECRET = "test-kit-ip-hmac-secret";

function kitProtocolHooks(database: TestDatabase): PipelineHooks {
  return {
    audit: createAuditHook({ db: database.runtime.db, logger: silentLogger }),
    idempotency: createIdempotencyHook({ db: database.runtime.db }),
    rateLimit: createRateLimitHook({
      store: createInMemoryRateLimitStore(),
      ipHmacSecret: KIT_IP_HMAC_SECRET,
      logger: silentLogger,
    }),
  };
}

type CrmRow = typeof fixtureCrmCustomers.$inferSelect;
type ProductRow = typeof fixtureProducts.$inferSelect;

async function resolveOwnCrmRecord(
  input: unknown,
  env: TargetResolutionEnv,
): Promise<ResolvedTarget<CrmRow>> {
  if (env.principal.mode !== "customer") {
    throw new NotFoundError();
  }
  const customerId = readId(input, "customerId");
  const rows = await env.tx
    .select()
    .from(fixtureCrmCustomers)
    .where(eq(fixtureCrmCustomers.id, customerId))
    .limit(1);
  const row = rows[0];
  if (row === undefined || row.userId !== env.principal.userId) {
    throw new NotFoundError();
  }
  return { companyId: row.companyId, resource: row };
}

async function resolvePublishedProduct(
  input: unknown,
  env: TargetResolutionEnv,
): Promise<ResolvedTarget<ProductRow>> {
  const productId = readId(input, "productId");
  const productRows = await env.tx
    .select()
    .from(fixtureProducts)
    .where(eq(fixtureProducts.id, productId))
    .limit(1);
  const product = productRows[0];
  if (product === undefined || !product.published) {
    throw new NotFoundError();
  }
  const companyRows = await env.tx
    .select()
    .from(fixtureCompanies)
    .where(eq(fixtureCompanies.id, product.companyId))
    .limit(1);
  const company = companyRows[0];
  if (company === undefined || !company.published) {
    throw new NotFoundError();
  }
  return { companyId: product.companyId, resource: product };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readId(input: unknown, key: string): string {
  if (!isRecord(input)) {
    throw new NotFoundError();
  }
  const value = input[key];
  if (typeof value !== "string") {
    throw new NotFoundError();
  }
  return value;
}

function requestMeta(
  overrides: Partial<ActionRequestMeta> = {},
): ActionRequestMeta {
  return {
    action: "testKit.buildContext",
    requestId: randomUUID(),
    correlationId: randomUUID(),
    channel: "ui",
    clientIp: DEFAULT_CLIENT_IP,
    ...overrides,
  };
}

function runtimeFor<TDb>(
  dbCapability: TDb,
  logger: Logger,
): ContextRuntime<TDb> {
  return {
    db: dbCapability,
    logger,
    deadline: Date.now() + 5_000,
    signal: new AbortController().signal,
    emit: () => {
      throw new Error("test-kit contexts cannot emit — use kit.invoke");
    },
    call: () => {
      throw new Error("test-kit contexts cannot call — use kit.invoke");
    },
    callAtomic: () => {
      throw new Error(
        "test-kit contexts cannot call atomically — use kit.invoke",
      );
    },
  };
}

/**
 * Seeds the kit world into an already-created test database: parity
 * fixtures, matching `user` / `companies` / `company_members` rows so
 * staff and system-tenant factories resolve the same ids the discovery
 * tables use.
 */
export async function seedTestKit(db: TestDatabase): Promise<void> {
  await createParityFixtureTables(db.admin);
  await seedParityFixtures(db.runtime.db);
  await db.runtime.db.insert(user).values([
    {
      id: kitIdentities.users.anna,
      name: "Anna",
      email: "anna@kit.test",
    },
    {
      id: kitIdentities.users.boris,
      name: "Boris",
      email: "boris@kit.test",
    },
  ]);
  await db.runtime.db.insert(companies).values([
    {
      id: kitIdentities.companies.a,
      name: "Konditerska Anna",
      slug: "konditerska-anna",
      prefix: "KA",
    },
    {
      id: kitIdentities.companies.b,
      name: "Maisternya Boris",
      slug: "maisternya-boris",
      prefix: "MB",
    },
  ]);
  await db.runtime.db.insert(companyMembers).values([
    {
      companyId: kitIdentities.companies.a,
      userId: kitIdentities.users.anna,
      role: "owner",
      permissions: { granted: [], denied: [] },
    },
    {
      companyId: kitIdentities.companies.b,
      userId: kitIdentities.users.boris,
      role: "owner",
      permissions: { granted: [], denied: [] },
    },
  ]);
}

export async function createTestKit(db?: TestDatabase): Promise<TestKit> {
  const database = db ?? (await createTestDatabase());
  await seedTestKit(database);

  const pipeline: ActionPipelineDeps = {
    db: database.runtime.db,
    logger: silentLogger,
    projectionGrants: createProjectionGrantManifest([fixtureDiscoveryGrant]),
    hooks: kitProtocolHooks(database),
  };

  const kit: TestKit = {
    db: database,
    identities: kitIdentities,
    pipeline,
    buildTestContext(mode, overrides = {}) {
      return buildTestContext(kit, mode, overrides);
    },
    invoke(action, input, actor = {}, options = {}) {
      return invokeAction(kit, action, input, actor, options);
    },
  };
  return kit;
}

/**
 * Context factory wrapper for all seven principal modes against the kit
 * world (core.md §12 `buildTestContext(mode, overrides)`). Defaults aim
 * the caller at Anna/company A (or Boris for customer ownership); module
 * tests pass `resolveTarget` / `input` for their own resources.
 */
export async function buildTestContext(
  kit: TestKit,
  mode: ActionPrincipal,
  overrides: BuildTestContextOverrides = {},
): Promise<ActionCtx> {
  const request = requestMeta({
    action: `testKit.${mode}`,
    ...overrides.request,
  });
  const logger = overrides.logger ?? silentLogger;
  const runtime = runtimeFor(kit.db.runtime.db, logger);
  const session =
    overrides.session !== undefined
      ? overrides.session
      : { userId: overrides.userId ?? defaultUserId(mode) };

  switch (mode) {
    case "staff": {
      const selector =
        overrides.companySelector !== undefined
          ? overrides.companySelector
          : (overrides.companyId ?? kitIdentities.companies.a);
      return createStaffContext({
        request,
        runtime,
        session,
        companySelector: selector,
      });
    }
    case "customer":
      return createCustomerContext({
        request,
        runtime,
        session,
        input: overrides.input ?? { customerId: kitIdentities.crmSentinel },
        resolveTarget: overrides.resolveTarget ?? resolveOwnCrmRecord,
      });
    case "public": {
      const publicScope: PublicScope =
        overrides.publicScope ??
        (overrides.resolveTarget !== undefined ? "target" : "globalProjection");
      if (publicScope === "globalProjection") {
        return createPublicContext({
          request,
          runtime,
          publicScope: "globalProjection",
          grant: overrides.grant ?? fixtureDiscoveryGrant,
        });
      }
      return createPublicContext({
        request,
        runtime,
        publicScope: "target",
        input: overrides.input ?? {
          productId: kitIdentities.products.published,
        },
        resolveTarget: overrides.resolveTarget ?? resolvePublishedProduct,
      });
    }
    case "system": {
      const scope: SystemScopeInput = overrides.systemScope ?? {
        scope: "tenant",
        companyId: overrides.companyId ?? kitIdentities.companies.a,
      };
      return createSystemContext(
        overrides.serviceName ?? DEFAULT_SERVICE,
        scope,
        { request, runtime },
      );
    }
    case "consumer":
      return createConsumerContext({ request, runtime, session });
    case "account":
      return createAccountContext({ request, runtime, session });
    case "share":
      return createShareContext({
        request,
        runtime,
        input: overrides.input ?? {
          token: kitShareTokens.a,
          documentId: kitShareDocuments.a.id,
        },
        resolveTarget: overrides.resolveTarget ?? resolveKitShareTarget,
      });
  }
}

export async function invokeAction<
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
  TTarget = unknown,
>(
  kit: TestKit,
  action: ImplementedAction<TInput, TOutput, TTarget>,
  input: unknown,
  actor: IsolationActor = {},
  options: InvokeOptions = {},
): Promise<z.output<TOutput>> {
  const contract = action.contract;
  const request: PipelineRequestMeta = {
    requestId: randomUUID(),
    correlationId: randomUUID(),
    channel: "ui",
    clientIp: actor.clientIp ?? DEFAULT_CLIENT_IP,
    ...(contract.idempotent && contract.risk !== "read"
      ? { idempotencyKey: randomUUID() }
      : {}),
    ...options.request,
  };
  try {
    return await executeAction(options.deps ?? kit.pipeline, {
      action,
      input,
      request,
      principal: principalInvocation(contract.principal, actor, contract),
    });
  } catch (error) {
    checkInvokeActionError(contract, error);
    throw error;
  }
}

function principalInvocation(
  mode: ActionPrincipal,
  actor: IsolationActor,
  contract: ImplementedAction["contract"],
): PrincipalInvocation {
  switch (mode) {
    case "staff":
      return {
        mode: "staff",
        session: { userId: actor.userId ?? kitIdentities.users.anna },
        companySelector: actor.companyId ?? kitIdentities.companies.a,
      };
    case "customer":
      return {
        mode: "customer",
        session: { userId: actor.userId ?? kitIdentities.users.boris },
      };
    case "public":
      return { mode: "public" };
    case "system":
      return {
        mode: "system",
        serviceName: actor.serviceName ?? DEFAULT_SERVICE,
        scope:
          contract.systemScope === "global"
            ? { scope: "global" }
            : {
                scope: "tenant",
                companyId: actor.companyId ?? kitIdentities.companies.a,
              },
      };
    case "consumer":
      return {
        mode: "consumer",
        session: { userId: actor.userId ?? kitIdentities.users.anna },
      };
    case "account":
      return {
        mode: "account",
        session: { userId: actor.userId ?? kitIdentities.users.anna },
      };
    case "share":
      return { mode: "share" };
  }
}

function defaultUserId(mode: ActionPrincipal): string {
  return mode === "customer"
    ? kitIdentities.users.boris
    : kitIdentities.users.anna;
}

/**
 * pino logger that records parsed JSON lines — used by suites that assert
 * anonymous / null-company log fields and the absence of raw IPs.
 */
export function createCapturingLogger(): {
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
