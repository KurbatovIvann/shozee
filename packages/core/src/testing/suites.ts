/**
 * Isolation suites every module instantiates (fnd-T21 — core.md §12).
 *
 * Each registrar adds vitest `it` blocks that call `getKit()` lazily so
 * `beforeAll` can seed first. The `run*` functions are the same
 * assertions without registration, so the kit self-tests can prove a
 * leaky fixture action fails them.
 */
import { randomUUID } from "node:crypto";

import { auditLog, companies, domainEvents } from "@showzy/db";
import { readCrmSentinel } from "@showzy/db/testing/fixtures";
import { and, eq } from "drizzle-orm";
import { describe, it } from "vitest";
import type { z } from "zod";

import { SHARE_DURABLE_ACTOR } from "../runtime/context/types.js";
import {
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from "../errors/index.js";
import type { Job } from "../jobs/define-job.js";
import type { ImplementedAction } from "../runtime/implement-action.js";
import { executeJobAction } from "../runtime/jobs/execute-job-action.js";
import type { RateLimitHook } from "../runtime/pipeline/types.js";
import {
  createRateLimitHook,
  rateLimitDefaults,
} from "../runtime/rate-limit/create-rate-limit-hook.js";
import { createInMemoryRateLimitStore } from "../runtime/rate-limit/token-bucket.js";
import {
  collectJsonStrings,
  findInternalFieldLeaks,
  findPrivateUserLeaks,
  findUnpublishedLeaks,
} from "./inspect.js";
import { kitIdentities } from "./identities.js";
import {
  buildJobEnvelope,
  createCapturingLogger,
  invokeAction,
  type IsolationActor,
  type TestKit,
} from "./kit.js";

export interface IsolationInvocation extends IsolationActor {
  readonly input: unknown;
}

/**
 * Heterogeneous implemented action as the suites see it. `isolationCase` /
 * `browseCase` collect mixed-principal actions into one list.
 */
export type SuiteAction = ImplementedAction<z.ZodType, z.ZodType, unknown>;

export interface CrossTenantCase {
  readonly action: SuiteAction;
  readonly own: IsolationInvocation;
  readonly foreign: IsolationInvocation;
}

export interface BrowseCase {
  readonly action: SuiteAction;
  readonly input?: unknown;
  readonly userId?: string;
}

export function isolationCase<
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
  TTarget,
>(
  action: ImplementedAction<TInput, TOutput, TTarget>,
  own: IsolationInvocation,
  foreign: IsolationInvocation,
): CrossTenantCase {
  return { action, own, foreign };
}

export function browseCase<
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
  TTarget,
>(
  action: ImplementedAction<TInput, TOutput, TTarget>,
  extras: { readonly input?: unknown; readonly userId?: string } = {},
): BrowseCase {
  return { action, ...extras };
}

function isolationDenied(error: unknown): boolean {
  return (
    error instanceof NotFoundError || error instanceof PermissionDeniedError
  );
}

function denyMessage(actionName: string): string {
  return `expected foreign access to "${actionName}" to be denied`;
}

function leakMessage(actionName: string, detail: string): string {
  return `"${actionName}" leaked ${detail}`;
}

/**
 * Isolation-suite rate-limit assertions freeze time so wall-clock refill
 * cannot race `policy.limit` sequential invokes (SHO-146). HMAC rotation
 * also reads this clock. Matches the injectable-clock pattern already used
 * by `token-bucket.test.ts`.
 */
const FROZEN_SUITE_RATE_LIMIT_NOW_MS = 1_000_000;

function frozenSuiteRateLimitNow(): number {
  return FROZEN_SUITE_RATE_LIMIT_NOW_MS;
}

function createFrozenSuiteRateLimitHook(
  logger: ReturnType<typeof createCapturingLogger>["logger"],
): RateLimitHook {
  return createRateLimitHook({
    store: createInMemoryRateLimitStore({ now: frozenSuiteRateLimitNow }),
    ipHmacSecret: "test-kit-ip-hmac-secret",
    logger,
    now: frozenSuiteRateLimitNow,
  });
}

async function invoke(
  kit: TestKit,
  action: SuiteAction,
  call: IsolationInvocation,
  options?: Parameters<typeof invokeAction>[4],
): Promise<unknown> {
  return invokeAction(kit, action, call.input, call, options);
}

function assertDiscoveryClean(actionName: string, output: unknown): void {
  const unpublished = findUnpublishedLeaks(output);
  if (unpublished.length > 0) {
    throw new Error(
      leakMessage(actionName, `unpublished resource ${unpublished.join(", ")}`),
    );
  }
  const internal = findInternalFieldLeaks(output);
  if (internal.length > 0) {
    throw new Error(
      leakMessage(actionName, `internal field ${internal.join(", ")}`),
    );
  }
}

function assertAccountDidNotLeak(
  actionName: string,
  foreignOutput: unknown,
): void {
  const ownIds = [kitIdentities.companies.a, kitIdentities.users.anna];
  const seen = new Set(collectJsonStrings(foreignOutput));
  const hits = ownIds.filter((id) => seen.has(id));
  if (hits.length > 0) {
    throw new Error(
      leakMessage(actionName, `user A's data ${hits.join(", ")}`),
    );
  }
}

async function expectForeignDenied(
  actionName: string,
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (isolationDenied(error)) {
      return;
    }
    throw error;
  }
  throw new Error(denyMessage(actionName));
}

/**
 * Own-scope access succeeds; foreign-scope access is denied — or, for
 * public-global / consumer browse, the response contains no unpublished
 * or internal fixture fields. System-global jobs have no foreign tenant
 * to deny: they succeed in the only scope they have (SHO-115). Module
 * tests prove a row's derived keys do not mutate another company's
 * objects.
 */
export async function runCrossTenantCase(
  kit: TestKit,
  c: CrossTenantCase,
): Promise<void> {
  const { action } = c;
  const principal = action.contract.principal;
  const publicScope = action.contract.publicScope;

  if (
    (principal === "public" && publicScope === "globalProjection") ||
    principal === "consumer"
  ) {
    assertDiscoveryClean(
      action.contract.name,
      await invoke(kit, action, c.own),
    );
    return;
  }

  if (principal === "system" && action.contract.systemScope === "global") {
    await invoke(kit, action, c.own);
    return;
  }

  await invoke(kit, action, c.own);

  if (principal === "account") {
    try {
      const output = await invoke(kit, action, c.foreign);
      assertAccountDidNotLeak(action.contract.name, output);
      return;
    } catch (error) {
      if (isolationDenied(error)) {
        return;
      }
      throw error;
    }
  }

  await expectForeignDenied(action.contract.name, () =>
    invoke(kit, action, c.foreign),
  );
}

export function crossTenantSuite(
  getKit: () => TestKit,
  cases: readonly CrossTenantCase[],
): void {
  describe("crossTenantSuite", () => {
    for (const c of cases) {
      it(`${c.action.contract.name} (${c.action.contract.principal}) isolates across tenants`, async () => {
        await runCrossTenantCase(getKit(), c);
      });
    }
  });
}

export async function runPublicProjectionCase(
  kit: TestKit,
  c: BrowseCase,
): Promise<void> {
  const action = c.action;
  if (
    action.contract.principal !== "public" ||
    action.contract.publicScope !== "globalProjection"
  ) {
    throw new Error(
      `"${action.contract.name}" is not a public-global action — publicProjectionSuite only accepts publicScope: globalProjection`,
    );
  }
  if (action.resolveTarget !== undefined) {
    throw new Error(
      `"${action.contract.name}" bound resolveTarget — public-global actions cannot have a resolver`,
    );
  }

  const crmBefore = await readCrmSentinel(kit.db.runtime.db);
  const capturing = createCapturingLogger();
  const output = await invoke(
    kit,
    action,
    { input: c.input ?? {} },
    { deps: { ...kit.pipeline, logger: capturing.logger } },
  );
  assertDiscoveryClean(action.contract.name, output);

  const crmAfter = await readCrmSentinel(kit.db.runtime.db);
  if (JSON.stringify(crmAfter) !== JSON.stringify(crmBefore)) {
    throw new Error(leakMessage(action.contract.name, "a CRM sentinel change"));
  }

  const finished = capturing
    .entries()
    .find((line) => line["msg"] === "action finished");
  if (finished === undefined) {
    throw new Error(
      `"${action.contract.name}" produced no action-finished log`,
    );
  }
  if (
    finished["actor_type"] !== "anonymous" ||
    finished["company_id"] !== null
  ) {
    throw new Error(
      `"${action.contract.name}" log was not anonymous/null-company (actor_type=${String(finished["actor_type"])}, company_id=${String(finished["company_id"])})`,
    );
  }
  if ("client_ip" in finished) {
    throw new Error(
      `"${action.contract.name}" logged a raw client_ip — IPs stay transport-only`,
    );
  }

  await assertIpHmacLimit(kit, action, c.input ?? {});
}

async function assertIpHmacLimit(
  kit: TestKit,
  action: SuiteAction,
  input: unknown,
): Promise<void> {
  const principal = action.contract.principal;
  if (principal !== "public" && principal !== "share") {
    throw new Error(
      `"${action.contract.name}" is not IP-HMAC rate limited (principal=${principal})`,
    );
  }
  const policy = action.contract.rateLimit ?? rateLimitDefaults[principal];
  if (policy.scope !== "ipHmac") {
    throw new Error(
      `"${action.contract.name}" is not IP-HMAC rate limited (scope=${policy.scope})`,
    );
  }
  const logger = createCapturingLogger().logger;
  const deps = {
    ...kit.pipeline,
    logger,
    hooks: {
      ...kit.pipeline.hooks,
      rateLimit: createFrozenSuiteRateLimitHook(logger),
    },
  };
  const clientIp = "198.51.100.20";
  for (let i = 0; i < policy.limit; i += 1) {
    await invokeAction(kit, action, input, { clientIp }, { deps });
  }
  try {
    await invokeAction(kit, action, input, { clientIp }, { deps });
  } catch (error) {
    if (error instanceof RateLimitError) {
      return;
    }
    throw error;
  }
  throw new Error(
    `"${action.contract.name}" did not rate-limit the ${String(policy.limit + 1)}th ${principal} call`,
  );
}

export async function assertUserRateLimit(
  kit: TestKit,
  action: SuiteAction,
  call: IsolationInvocation,
  rateLimitHook?: RateLimitHook,
): Promise<void> {
  const principal = action.contract.principal;
  if (principal !== "consumer" && principal !== "account") {
    throw new Error(
      `"${action.contract.name}" is not a consumer/account action — user rate-limit assertion only applies to those modes`,
    );
  }
  const policy = action.contract.rateLimit ?? rateLimitDefaults[principal];
  if (policy.scope !== "user") {
    throw new Error(
      `"${action.contract.name}" is not user rate limited (scope=${policy.scope})`,
    );
  }
  const logger = createCapturingLogger().logger;
  const deps = {
    ...kit.pipeline,
    logger,
    hooks: {
      ...kit.pipeline.hooks,
      rateLimit: rateLimitHook ?? createFrozenSuiteRateLimitHook(logger),
    },
  };
  for (let i = 0; i < policy.limit; i += 1) {
    await invoke(kit, action, call, { deps });
  }
  try {
    await invoke(kit, action, call, { deps });
  } catch (error) {
    if (error instanceof RateLimitError) {
      return;
    }
    throw error;
  }
  throw new Error(
    `"${action.contract.name}" did not rate-limit the ${String(policy.limit + 1)}th ${principal} call`,
  );
}

async function assertNullCompanyProtocolRows(
  kit: TestKit,
  actionName: string,
  requestId: string,
): Promise<void> {
  const eventRows = await kit.db.runtime.db
    .select({ companyId: domainEvents.companyId })
    .from(domainEvents)
    .where(eq(domainEvents.requestId, requestId));
  for (const row of eventRows) {
    if (row.companyId !== null) {
      throw new Error(
        `"${actionName}" emitted a domain_events row with company_id=${row.companyId} — account actions are null-company`,
      );
    }
  }
  const auditRows = await kit.db.runtime.db
    .select({ companyId: auditLog.companyId })
    .from(auditLog)
    .where(eq(auditLog.requestId, requestId));
  for (const row of auditRows) {
    if (row.companyId !== null) {
      throw new Error(
        `"${actionName}" wrote an audit_log row with company_id=${row.companyId} — account actions are null-company`,
      );
    }
  }
}

export function publicProjectionSuite(
  getKit: () => TestKit,
  cases: readonly BrowseCase[],
): void {
  describe("publicProjectionSuite", () => {
    for (const c of cases) {
      it(`${c.action.contract.name} hides unpublished/internal fields, does not touch CRM, logs anonymously, and IP-HMAC rate-limits`, async () => {
        await runPublicProjectionCase(getKit(), c);
      });
    }
  });
}

export async function runConsumerIsolationCase(
  kit: TestKit,
  c: BrowseCase,
): Promise<void> {
  const action = c.action;
  if (action.contract.principal !== "consumer") {
    throw new Error(
      `"${action.contract.name}" is not a consumer action — consumerIsolationSuite only accepts principal: consumer`,
    );
  }

  const crmBefore = await readCrmSentinel(kit.db.runtime.db);
  const output = await invoke(kit, action, {
    input: c.input ?? {},
    userId: c.userId ?? kitIdentities.users.anna,
  });
  assertDiscoveryClean(action.contract.name, output);

  const privateUsers = findPrivateUserLeaks(output);
  if (privateUsers.length > 0) {
    throw new Error(
      leakMessage(
        action.contract.name,
        `private-collection user ${privateUsers.join(", ")}`,
      ),
    );
  }

  const crmAfter = await readCrmSentinel(kit.db.runtime.db);
  if (JSON.stringify(crmAfter) !== JSON.stringify(crmBefore)) {
    throw new Error(leakMessage(action.contract.name, "a CRM sentinel change"));
  }

  await assertUserRateLimit(kit, action, {
    input: c.input ?? {},
    userId: c.userId ?? kitIdentities.users.anna,
  });
}

export function consumerIsolationSuite(
  getKit: () => TestKit,
  cases: readonly BrowseCase[],
): void {
  describe("consumerIsolationSuite", () => {
    for (const c of cases) {
      it(`${c.action.contract.name} hides unpublished entities, private collections, does not touch CRM, and user rate-limits`, async () => {
        await runConsumerIsolationCase(getKit(), c);
      });
    }
  });
}

export async function runAccountIsolationCase(
  kit: TestKit,
  c: CrossTenantCase,
): Promise<void> {
  const action = c.action;
  if (action.contract.principal !== "account") {
    throw new Error(
      `"${action.contract.name}" is not an account action — accountIsolationSuite only accepts principal: account`,
    );
  }
  if (action.contract.permissions.length > 0) {
    throw new Error(
      `"${action.contract.name}" declared permissions ${JSON.stringify(action.contract.permissions)} — account actions must use permissions: []`,
    );
  }

  const capturing = createCapturingLogger();
  const requestId = randomUUID();
  const deps = { ...kit.pipeline, logger: capturing.logger };
  const own = await invoke(kit, action, c.own, {
    deps,
    request: { requestId },
  });
  const ownSeen = new Set(collectJsonStrings(own));
  if (!ownSeen.has(kitIdentities.companies.a)) {
    throw new Error(
      `"${action.contract.name}" own-user call did not return user A's company`,
    );
  }
  if (ownSeen.has(kitIdentities.companies.b)) {
    throw new Error(
      leakMessage(action.contract.name, "user B's company on user A's call"),
    );
  }

  const finished = capturing
    .entries()
    .find((line) => line["msg"] === "action finished");
  if (finished === undefined || finished["company_id"] !== null) {
    throw new Error(
      `"${action.contract.name}" log company_id was ${String(finished?.["company_id"])} — account actions are null-company`,
    );
  }

  await assertNullCompanyProtocolRows(kit, action.contract.name, requestId);
  await assertUserRateLimit(kit, action, c.own);

  try {
    const foreign = await invoke(kit, action, c.foreign);
    assertAccountDidNotLeak(action.contract.name, foreign);
  } catch (error) {
    if (isolationDenied(error)) {
      return;
    }
    throw error;
  }
}

export function accountIsolationSuite(
  getKit: () => TestKit,
  cases: readonly CrossTenantCase[],
): void {
  describe("accountIsolationSuite", () => {
    for (const c of cases) {
      it(`${c.action.contract.name} keeps user B out of user A's companies/personal data, logs a null company, and user rate-limits`, async () => {
        await runAccountIsolationCase(getKit(), c);
      });
    }
  });
}

export interface ShareIsolationCase {
  readonly action: SuiteAction;
  readonly own: IsolationInvocation;
  readonly foreign: IsolationInvocation;
  readonly expired: IsolationInvocation;
  readonly revoked: IsolationInvocation;
  readonly mismatched: IsolationInvocation;
  /** Raw capability token that must never appear in logs, audit, or events. */
  readonly rawToken: string;
}

export function shareIsolationCase(
  action: SuiteAction,
  parts: Omit<ShareIsolationCase, "action">,
): ShareIsolationCase {
  return { action, ...parts };
}

async function expectShareNotFound(
  actionName: string,
  label: string,
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (error instanceof NotFoundError) {
      return;
    }
    throw error;
  }
  throw new Error(
    `expected ${label} access to "${actionName}" to be NotFoundError`,
  );
}

function serializedContainsToken(value: unknown, rawToken: string): boolean {
  return JSON.stringify(value).includes(rawToken);
}

export async function runShareIsolationCase(
  kit: TestKit,
  c: ShareIsolationCase,
): Promise<void> {
  const action = c.action;
  if (action.contract.principal !== "share") {
    throw new Error(
      `"${action.contract.name}" is not a share action — shareIsolationSuite only accepts principal: share`,
    );
  }
  if (action.contract.permissions.length > 0) {
    throw new Error(
      `"${action.contract.name}" declared permissions ${JSON.stringify(action.contract.permissions)} — share actions must use permissions: []`,
    );
  }

  const crmBefore = await readCrmSentinel(kit.db.runtime.db);
  const capturing = createCapturingLogger();
  const requestId = randomUUID();
  const deps = { ...kit.pipeline, logger: capturing.logger };

  await invoke(kit, action, c.own, { deps, request: { requestId } });

  await expectShareNotFound(action.contract.name, "foreign-token", () =>
    invoke(kit, action, c.foreign),
  );
  await expectShareNotFound(action.contract.name, "expired-token", () =>
    invoke(kit, action, c.expired),
  );
  await expectShareNotFound(action.contract.name, "revoked-token", () =>
    invoke(kit, action, c.revoked),
  );
  await expectShareNotFound(action.contract.name, "mismatched-token", () =>
    invoke(kit, action, c.mismatched),
  );

  const crmAfter = await readCrmSentinel(kit.db.runtime.db);
  if (JSON.stringify(crmAfter) !== JSON.stringify(crmBefore)) {
    throw new Error(leakMessage(action.contract.name, "a CRM sentinel change"));
  }

  const logBlob = capturing.entries();
  if (serializedContainsToken(logBlob, c.rawToken)) {
    throw new Error(
      `"${action.contract.name}" logged the raw capability token`,
    );
  }
  const finished = logBlob.find((line) => line["msg"] === "action finished");
  if (finished === undefined) {
    throw new Error(
      `"${action.contract.name}" produced no action-finished log`,
    );
  }
  if (finished["actor_type"] !== "anonymous") {
    throw new Error(
      `"${action.contract.name}" log actor_type was ${String(finished["actor_type"])} — share access logs are anonymous`,
    );
  }
  if ("client_ip" in finished) {
    throw new Error(
      `"${action.contract.name}" logged a raw client_ip — IPs stay transport-only`,
    );
  }

  if (action.contract.risk !== "read") {
    const auditRows = await kit.db.runtime.db
      .select({
        actorType: auditLog.actorType,
        actorId: auditLog.actorId,
        inputSnapshot: auditLog.inputSnapshot,
      })
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    for (const row of auditRows) {
      if (
        row.actorType !== SHARE_DURABLE_ACTOR.type ||
        row.actorId !== SHARE_DURABLE_ACTOR.id
      ) {
        throw new Error(
          `"${action.contract.name}" audit actor was ${row.actorType}/${row.actorId} — share writes use system/share`,
        );
      }
      if (serializedContainsToken(row.inputSnapshot, c.rawToken)) {
        throw new Error(
          `"${action.contract.name}" stored the raw capability token in auditSnapshot`,
        );
      }
    }
    const eventRows = await kit.db.runtime.db
      .select({
        actorType: domainEvents.actorType,
        actorId: domainEvents.actorId,
        payload: domainEvents.payload,
      })
      .from(domainEvents)
      .where(eq(domainEvents.requestId, requestId));
    for (const row of eventRows) {
      if (
        row.actorType !== SHARE_DURABLE_ACTOR.type ||
        row.actorId !== SHARE_DURABLE_ACTOR.id
      ) {
        throw new Error(
          `"${action.contract.name}" event actor was ${row.actorType}/${row.actorId} — share writes use system/share`,
        );
      }
      if (serializedContainsToken(row.payload, c.rawToken)) {
        throw new Error(
          `"${action.contract.name}" stored the raw capability token in an event payload`,
        );
      }
    }
  }

  await assertIpHmacLimit(kit, action, c.own.input);

  const failClosedLogger = createCapturingLogger().logger;
  const failClosedDeps = {
    ...kit.pipeline,
    logger: failClosedLogger,
    hooks: {
      ...kit.pipeline.hooks,
      rateLimit: createRateLimitHook({
        store: {
          consume: () => Promise.reject(new Error("redis connection refused")),
        },
        ipHmacSecret: "test-kit-ip-hmac-secret",
        logger: failClosedLogger,
      }),
    },
  };
  try {
    await invoke(kit, action, c.own, { deps: failClosedDeps });
  } catch (error) {
    if (error instanceof RateLimitError) {
      return;
    }
    throw error;
  }
  throw new Error(
    `"${action.contract.name}" did not fail closed when the rate-limit store was down`,
  );
}

export interface JobIsolationInvocation {
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface JobIsolationOwnRun {
  readonly requestId: string;
  readonly companyId: string | null;
}

export type JobIsolationEffect = (
  kit: TestKit,
  run: JobIsolationOwnRun,
) => Promise<void>;

export interface JobIsolationCase {
  readonly job: Job;
  readonly action: SuiteAction;
  readonly own: JobIsolationInvocation;
  readonly foreign?: JobIsolationInvocation;
  readonly effect?: JobIsolationEffect;
}

export function jobIsolationCase<
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
  TTarget,
>(
  job: Job,
  action: ImplementedAction<TInput, TOutput, TTarget>,
  own: JobIsolationInvocation,
  foreign?: JobIsolationInvocation,
  effect?: JobIsolationEffect,
): JobIsolationCase {
  return {
    job,
    action,
    own,
    ...(foreign === undefined ? {} : { foreign }),
    ...(effect === undefined ? {} : { effect }),
  };
}

function jobRunInCompany(
  kit: TestKit,
  c: JobIsolationCase,
  call: JobIsolationInvocation,
  companyId: string,
): { readonly requestId: string; readonly run: () => Promise<unknown> } {
  const tenantJob = c.job.scope === "tenant";
  const envelope = buildJobEnvelope(c.job, {
    companyId: tenantJob ? companyId : null,
    payload: call.payload,
  });
  return {
    requestId: envelope.requestId,
    run: () =>
      executeJobAction(kit.pipeline, {
        job: c.job,
        envelope,
        action: c.action,
        input: envelope.payload,
        ...(tenantJob ? {} : { fanOutCompanyId: companyId }),
      }),
  };
}

async function expectOkAuditInCompany(
  kit: TestKit,
  subject: string,
  run: JobIsolationOwnRun & { readonly companyId: string },
): Promise<void> {
  const committed = await kit.db.runtime.db
    .select({ companyId: auditLog.companyId })
    .from(auditLog)
    .where(
      and(eq(auditLog.requestId, run.requestId), eq(auditLog.outcome, "ok")),
    );
  if (!committed.some((row) => row.companyId === run.companyId)) {
    throw new Error(
      `${subject} committed no ok audit row in company ${run.companyId}; supply an effect assertion for an unaudited action`,
    );
  }
}

async function insertCompanyWithoutOwnedRows(kit: TestKit): Promise<string> {
  const id = randomUUID();
  await kit.db.runtime.db.insert(companies).values({
    id,
    name: "Job isolation empty company",
    slug: `job-${id}`,
    prefix: `JI${id.replaceAll("-", "").toUpperCase()}`,
  });
  return id;
}

async function expectJobFailsClosedWithoutChange(
  kit: TestKit,
  label: string,
  c: JobIsolationCase,
  call: JobIsolationInvocation,
  companyId: string,
): Promise<void> {
  const { requestId, run } = jobRunInCompany(kit, c, call, companyId);
  await expectForeignDenied(label, run);
  const committedAudits = await kit.db.runtime.db
    .select({ outcome: auditLog.outcome })
    .from(auditLog)
    .where(eq(auditLog.requestId, requestId));
  const committedEvents = await kit.db.runtime.db
    .select({ id: domainEvents.id })
    .from(domainEvents)
    .where(eq(domainEvents.requestId, requestId));
  if (
    committedAudits.some((row) => row.outcome === "ok") ||
    committedEvents.length > 0
  ) {
    throw new Error(`${label} failed but committed its changes`);
  }
}

async function expectGlobalAudit(
  kit: TestKit,
  subject: string,
  c: JobIsolationCase,
  requestId: string,
): Promise<void> {
  const committed = await kit.db.runtime.db
    .select({
      action: auditLog.action,
      actorType: auditLog.actorType,
      actorId: auditLog.actorId,
      companyId: auditLog.companyId,
      outcome: auditLog.outcome,
    })
    .from(auditLog)
    .where(eq(auditLog.requestId, requestId));
  const expected = {
    action: c.action.contract.name,
    actorType: "system",
    actorId: c.job.name,
    companyId: null,
    outcome: "ok",
  };
  if (
    committed.length !== 1 ||
    JSON.stringify(committed[0]) !== JSON.stringify(expected)
  ) {
    throw new Error(
      `${subject} committed audit rows ${JSON.stringify(committed)}, expected one ${JSON.stringify(expected)}`,
    );
  }
}

async function runGlobalJobCase(
  kit: TestKit,
  c: JobIsolationCase,
  subject: string,
): Promise<void> {
  const actionName = c.action.contract.name;
  if (c.job.scope !== "global") {
    throw new Error(
      `jobIsolationCase "${c.job.name}" is a tenant job and cannot run global action "${actionName}"`,
    );
  }
  if (c.foreign !== undefined) {
    throw new Error(
      `jobIsolationCase "${c.job.name}" runs global action "${actionName}", which has no foreign company to refuse`,
    );
  }
  if (!c.action.contract.audit && c.effect === undefined) {
    throw new Error(
      `jobIsolationCase "${c.job.name}" runs unaudited global action "${actionName}"; supply an effect assertion`,
    );
  }
  const envelope = buildJobEnvelope(c.job, {
    companyId: null,
    payload: c.own.payload,
  });
  await executeJobAction(kit.pipeline, {
    job: c.job,
    envelope,
    action: c.action,
    input: envelope.payload,
  });
  if (c.action.contract.audit) {
    await expectGlobalAudit(kit, subject, c, envelope.requestId);
  }
  if (c.effect !== undefined) {
    await c.effect(kit, { requestId: envelope.requestId, companyId: null });
  }
}

export async function runJobIsolationCase(
  kit: TestKit,
  c: JobIsolationCase,
): Promise<void> {
  const actionName = c.action.contract.name;
  const subject = `${actionName} from job ${c.job.name}`;
  if (c.action.contract.systemScope === "global") {
    await runGlobalJobCase(kit, c, subject);
    return;
  }
  if (c.action.contract.systemScope !== "tenant") {
    throw new Error(
      `jobIsolationCase "${c.job.name}" runs "${actionName}", which is not a system action`,
    );
  }
  if (c.job.scope === "tenant" && c.foreign === undefined) {
    throw new Error(
      `jobIsolationCase "${c.job.name}" is a tenant job and needs a foreign payload`,
    );
  }
  const ownRun = jobRunInCompany(kit, c, c.own, kitIdentities.companies.a);
  await ownRun.run();
  const ownResult = {
    requestId: ownRun.requestId,
    companyId: kitIdentities.companies.a,
  };
  await (c.effect === undefined
    ? expectOkAuditInCompany(kit, subject, ownResult)
    : c.effect(kit, ownResult));
  if (c.foreign !== undefined) {
    await expectJobFailsClosedWithoutChange(
      kit,
      `${subject} with a payload naming another company's row`,
      c,
      c.foreign,
      kitIdentities.companies.a,
    );
  }
  await expectJobFailsClosedWithoutChange(
    kit,
    `${subject} for an existing company without owned rows`,
    c,
    c.own,
    await insertCompanyWithoutOwnedRows(kit),
  );
}

export function jobIsolationSuite(
  getKit: () => TestKit,
  cases: readonly JobIsolationCase[],
): void {
  describe("jobIsolationSuite: job execution scope", () => {
    for (const c of cases) {
      const proof =
        c.action.contract.systemScope === "global"
          ? "in the global scope with no company, its effect and audit holding"
          : "in its recorded or fan-out company and fails closed on a foreign row or a company without owned rows";
      it(`${c.job.name} runs ${c.action.contract.name} ${proof}`, async () => {
        await runJobIsolationCase(getKit(), c);
      });
    }
  });
}

export function shareIsolationSuite(
  getKit: () => TestKit,
  cases: readonly ShareIsolationCase[],
): void {
  describe("shareIsolationSuite", () => {
    for (const c of cases) {
      it(`${c.action.contract.name} isolates tokens, hides expired/revoked/mismatch as NotFound, does not touch CRM, and IP-HMAC fail-closes`, async () => {
        await runShareIsolationCase(getKit(), c);
      });
    }
  });
}
