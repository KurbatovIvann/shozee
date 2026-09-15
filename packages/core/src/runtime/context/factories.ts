/**
 * Principal context factories — exactly one per mode, nothing ad-hoc
 * (core.md §3; ADR-0013, ADR-0018, ADR-0020, ADR-0022). The execution
 * pipeline (fnd-T12) and the event-delivery entrypoint (fnd-T17) are the
 * only intended callers; transports never assemble a context by hand.
 *
 * Every factory:
 *  - verifies the caller's authority for its mode (membership row, typed
 *    resolver proof, explicit system scope, session identity) — transport
 *    selectors and input identifiers are lookup keys, never authority;
 *  - derives the resolved company scope and binds the pino child logger
 *    (request/actor/company/action — security-operations §6);
 *  - returns the frozen, fully typed context of that mode.
 */
import {
  companyMembers,
  rolePermissionDefaults,
  createProjectionReadTx,
  createReadTx,
  type ProjectionGrant,
  type ReadTx,
} from "@showzy/db";
import { and, eq } from "drizzle-orm";
import type { Logger } from "pino";

import {
  CoreInvariantError,
  PermissionDeniedError,
} from "../../errors/index.js";
import { UUID_PATTERN } from "../patterns.js";
import type { ResolvedTarget, TargetResolutionEnv } from "../types.js";
import { isCompanyRole, resolveEffectivePermissions } from "./permissions.js";
import type {
  AccountCtx,
  ActionActor,
  ActionChannel,
  ActionCtx,
  BaseCtx,
  ConsumerCtx,
  CtxCall,
  CtxCallAtomic,
  CtxEmit,
  CtxEnqueue,
  CustomerCtx,
  PublicGlobalCtx,
  PublicTargetCtx,
  ShareCtx,
  StaffCtx,
  StaffMembership,
  SystemCtx,
} from "./types.js";

/** The authenticated identity a transport resolved from a better-auth session. */
export interface SessionPrincipal {
  readonly userId: string;
}

/** Request-scoped invocation metadata supplied by the transport/pipeline. */
export interface ActionRequestMeta {
  /** Action name (`<module>.<verb>`) — bound into the child logger. */
  readonly action: string;
  readonly requestId: string;
  readonly correlationId: string;
  readonly channel: ActionChannel;
  /** Trusted-proxy normalized IP; required for public/consumer/account/share. */
  readonly clientIp?: string;
  readonly aiTraceId?: string;
  readonly toolCallId?: string;
}

/**
 * Execution-scoped bindings owned by the pipeline (fnd-T12): the DB
 * capability matching the action's `risk`, the deadline/abort pair, the
 * base process logger, the invocation's buffered `emit` (fnd-T16), the
 * cross-module read invoker `call` (fnd-T19), and the declared atomic
 * write invoker `callAtomic` (fnd-T19A).
 */
export interface ContextRuntime<TDb> {
  readonly db: TDb;
  readonly logger: Logger;
  readonly deadline: number;
  readonly signal: AbortSignal;
  readonly emit: CtxEmit;
  readonly enqueue: CtxEnqueue;
  readonly call: CtxCall;
  readonly callAtomic: CtxCallAtomic;
}

function requireSession(
  session: SessionPrincipal | null,
  mode: string,
): SessionPrincipal {
  // Transports reject unauthenticated calls before core (contract.md §3);
  // this is defense in depth, not the 401 path.
  if (session === null) {
    throw new PermissionDeniedError("Authentication required.", {
      internalMessage: `${mode} context requested without a session`,
    });
  }
  return session;
}

function requireClientIp(request: ActionRequestMeta, mode: string): string {
  // A missing IP here is a transport composition bug (the API factory owns
  // trusted-proxy normalization), not a user error.
  if (request.clientIp === undefined) {
    throw new CoreInvariantError(
      `${mode} context for "${request.action}" constructed without a trusted-proxy normalized clientIp`,
    );
  }
  return request.clientIp;
}

/**
 * A nested resolver crossing tenants is a server bug (core.md §9), never a
 * user error — every resolver-backed factory asserts this the same way.
 */
function assertInheritedCompany(
  action: string,
  resolvedCompanyId: string,
  inheritedCompanyId: string | undefined,
): void {
  if (
    inheritedCompanyId !== undefined &&
    resolvedCompanyId !== inheritedCompanyId
  ) {
    throw new CoreInvariantError(
      `nested resolver of "${action}" resolved company ${resolvedCompanyId}, expected inherited company ${inheritedCompanyId}`,
    );
  }
}

/**
 * Assembles the mode-independent fields, including the pino child logger
 * bound to request/actor/company/action (security-operations §6). The
 * resolved `companyId` is `null` for public-global, consumer, account, and
 * global system work — the bound field says so explicitly instead of being
 * absent, matching the structured-log contract.
 */
function buildBase<TDb>(options: {
  readonly request: ActionRequestMeta;
  readonly runtime: ContextRuntime<unknown>;
  readonly db: TDb;
  readonly actor: ActionActor;
  readonly companyId: string | null;
}): BaseCtx<TDb> {
  const { request, runtime, db, actor, companyId } = options;
  const log = runtime.logger.child({
    request_id: request.requestId,
    correlation_id: request.correlationId,
    action: request.action,
    channel: request.channel,
    actor_type: actor.type,
    actor_id: actor.id,
    company_id: companyId,
    ...(request.aiTraceId !== undefined
      ? { ai_trace_id: request.aiTraceId }
      : {}),
    ...(request.toolCallId !== undefined
      ? { tool_call_id: request.toolCallId }
      : {}),
  });
  return {
    db,
    requestId: request.requestId,
    correlationId: request.correlationId,
    actor,
    channel: request.channel,
    ...(request.clientIp !== undefined ? { clientIp: request.clientIp } : {}),
    ...(request.aiTraceId !== undefined
      ? { aiTraceId: request.aiTraceId }
      : {}),
    ...(request.toolCallId !== undefined
      ? { toolCallId: request.toolCallId }
      : {}),
    deadline: runtime.deadline,
    signal: runtime.signal,
    log,
    emit: runtime.emit,
    enqueue: runtime.enqueue,
    call: runtime.call,
    callAtomic: runtime.callAtomic,
  };
}

/**
 * Staff: better-auth session + the transport's active-company selector
 * (`x-company-id`). The selector is never authority — authority is the
 * verified `company_members` row matching both the authenticated user and
 * the selected company. Missing selector or membership denies without
 * revealing whether the company exists.
 */
export async function createStaffContext<TDb extends ReadTx>(options: {
  readonly request: ActionRequestMeta;
  readonly runtime: ContextRuntime<TDb>;
  readonly session: SessionPrincipal | null;
  /** Raw `x-company-id` header value; `null` when absent. */
  readonly companySelector: string | null;
}): Promise<StaffCtx<TDb>> {
  const { request, runtime } = options;
  const session = requireSession(options.session, "staff");

  const selector = options.companySelector;
  if (selector === null || !UUID_PATTERN.test(selector)) {
    // Malformed and missing selectors are the same denial: neither may
    // reach the database, and the message must not distinguish them.
    throw new PermissionDeniedError("No active company is selected.", {
      internalMessage:
        selector === null
          ? `staff action "${request.action}" invoked without an x-company-id selector`
          : `staff action "${request.action}" invoked with a malformed x-company-id selector`,
    });
  }

  // One round trip for membership + role defaults: the LEFT JOIN keeps
  // the membership row even when the role has no default permissions, so
  // the denial and unknown-role branches behave exactly as before.
  const membershipRows = await runtime.db
    .select({
      role: companyMembers.role,
      permissions: companyMembers.permissions,
      defaultPermission: rolePermissionDefaults.permission,
    })
    .from(companyMembers)
    .leftJoin(
      rolePermissionDefaults,
      eq(rolePermissionDefaults.role, companyMembers.role),
    )
    .where(
      and(
        eq(companyMembers.companyId, selector),
        eq(companyMembers.userId, session.userId),
      ),
    );
  const membershipRow = membershipRows[0];
  if (membershipRow === undefined) {
    // Same message whether the company is foreign or nonexistent — a
    // denied staff caller learns nothing about other tenants.
    throw new PermissionDeniedError(
      "You are not a member of the selected company.",
      {
        internalMessage: `no company_members row for user ${session.userId} in company ${selector} ("${request.action}")`,
      },
    );
  }
  if (!isCompanyRole(membershipRow.role)) {
    throw new CoreInvariantError(
      `company_members row for user ${session.userId} in company ${selector} carries unknown role "${membershipRow.role}" — the DB CHECK should make this impossible`,
    );
  }

  const membership: StaffMembership = {
    role: membershipRow.role,
    permissions: resolveEffectivePermissions(
      membershipRow.permissions,
      membershipRows.flatMap((row) =>
        row.defaultPermission === null ? [] : [row.defaultPermission],
      ),
    ),
  };

  const actor: ActionActor = { type: "user", id: session.userId };
  return Object.freeze({
    ...buildBase({
      request,
      runtime,
      db: runtime.db,
      actor,
      companyId: selector,
    }),
    principal: "staff" as const,
    userId: session.userId,
    companyId: selector,
    membership,
  });
}

/**
 * Customer: better-auth session + the action's typed `resolveTarget`. The
 * returned resource is the ownership/visibility proof and its `companyId`
 * becomes the verified tenant scope. Resolvers throw `NotFoundError` on
 * any failure — never "forbidden" — so existence does not leak.
 */
export async function createCustomerContext<
  TInput,
  TTarget,
  TDb extends ReadTx,
>(options: {
  readonly request: ActionRequestMeta;
  readonly runtime: ContextRuntime<TDb>;
  readonly session: SessionPrincipal | null;
  readonly input: TInput;
  readonly resolveTarget: (
    input: TInput,
    env: TargetResolutionEnv,
  ) => Promise<ResolvedTarget<TTarget>>;
  /** Verified company scope of a nested `ctx.call` caller (core.md §9). */
  readonly inheritedCompanyId?: string;
}): Promise<CustomerCtx<TTarget, TDb>> {
  const { request, runtime } = options;
  const session = requireSession(options.session, "customer");

  const target = await options.resolveTarget(options.input, {
    tx: createReadTx(runtime.db),
    principal: { mode: "customer", userId: session.userId },
    ...(options.inheritedCompanyId !== undefined
      ? { inheritedCompanyId: options.inheritedCompanyId }
      : {}),
  });
  assertInheritedCompany(
    request.action,
    target.companyId,
    options.inheritedCompanyId,
  );

  const actor: ActionActor = { type: "user", id: session.userId };
  return Object.freeze({
    ...buildBase({
      request,
      runtime,
      db: runtime.db,
      actor,
      companyId: target.companyId,
    }),
    principal: "customer" as const,
    userId: session.userId,
    target,
  });
}

const ANONYMOUS_ACTOR: ActionActor = { type: "anonymous", id: "anonymous" };

/**
 * Public: no session — one factory covering both declared scopes
 * (core.md §3). `target` proves one published company/resource via the
 * typed resolver; `globalProjection` skips resolution and binds the
 * context's DB capability to its declared projection grant, so the handler
 * cannot read outside the granted tables/columns. Both require the
 * transport's trusted-proxy `clientIp` for IP-HMAC rate limiting.
 */
export async function createPublicContext<TInput, TTarget>(options: {
  readonly request: ActionRequestMeta;
  readonly runtime: ContextRuntime<ReadTx>;
  readonly publicScope: "target";
  readonly input: TInput;
  readonly resolveTarget: (
    input: TInput,
    env: TargetResolutionEnv,
  ) => Promise<ResolvedTarget<TTarget>>;
  readonly inheritedCompanyId?: string;
}): Promise<PublicTargetCtx<TTarget>>;
export async function createPublicContext<
  TGrant extends ProjectionGrant,
>(options: {
  readonly request: ActionRequestMeta;
  readonly runtime: ContextRuntime<ReadTx>;
  readonly publicScope: "globalProjection";
  /** The grant object resolved from the manifest by the pipeline. */
  readonly grant: TGrant;
}): Promise<PublicGlobalCtx<TGrant>>;
export async function createPublicContext<
  TInput,
  TTarget,
  TGrant extends ProjectionGrant,
>(
  options: {
    readonly request: ActionRequestMeta;
    readonly runtime: ContextRuntime<ReadTx>;
  } & (
    | {
        readonly publicScope: "target";
        readonly input: TInput;
        readonly resolveTarget: (
          input: TInput,
          env: TargetResolutionEnv,
        ) => Promise<ResolvedTarget<TTarget>>;
        readonly inheritedCompanyId?: string;
      }
    | { readonly publicScope: "globalProjection"; readonly grant: TGrant }
  ),
): Promise<PublicTargetCtx<TTarget> | PublicGlobalCtx<TGrant>> {
  const { request, runtime } = options;
  const clientIp = requireClientIp(request, "public");

  if (options.publicScope === "globalProjection") {
    return Object.freeze({
      ...buildBase({
        request,
        runtime,
        db: createProjectionReadTx(runtime.db, options.grant),
        actor: ANONYMOUS_ACTOR,
        companyId: null,
      }),
      principal: "public" as const,
      scope: "globalProjection" as const,
      clientIp,
      projectionGrant: options.grant.id,
    });
  }

  const target = await options.resolveTarget(options.input, {
    tx: createReadTx(runtime.db),
    principal: { mode: "public" },
    ...(options.inheritedCompanyId !== undefined
      ? { inheritedCompanyId: options.inheritedCompanyId }
      : {}),
  });
  assertInheritedCompany(
    request.action,
    target.companyId,
    options.inheritedCompanyId,
  );

  return Object.freeze({
    ...buildBase({
      request,
      runtime,
      db: createReadTx(runtime.db),
      actor: ANONYMOUS_ACTOR,
      companyId: target.companyId,
    }),
    principal: "public" as const,
    scope: "target" as const,
    clientIp,
    target,
  });
}

/** Explicit scope set by the enqueuing code — never ambient authority. */
export type SystemScopeInput =
  | { readonly scope: "tenant"; readonly companyId: string }
  | { readonly scope: "global" };

/**
 * System: workers, webhook handlers, and outbox consumers construct their
 * context only through this factory (ADR-0013). The accountable actor is
 * `system:<serviceName>`; scope is explicit — a system context is never
 * "all companies" unless the job genuinely is.
 */
export function createSystemContext<TDb extends ReadTx>(
  serviceName: string,
  scope: SystemScopeInput,
  options: {
    readonly request: ActionRequestMeta;
    readonly runtime: ContextRuntime<TDb>;
  },
): SystemCtx<TDb> {
  const { request, runtime } = options;
  if (serviceName === "") {
    throw new CoreInvariantError(
      `system context for "${request.action}" constructed without a serviceName`,
    );
  }
  if (scope.scope === "tenant" && !UUID_PATTERN.test(scope.companyId)) {
    throw new CoreInvariantError(
      `tenant-scoped system context for "${request.action}" constructed with a malformed companyId`,
    );
  }

  const actor: ActionActor = { type: "system", id: serviceName };
  const base = buildBase({
    request,
    runtime,
    db: runtime.db,
    actor,
    companyId: scope.scope === "tenant" ? scope.companyId : null,
  });
  if (scope.scope === "tenant") {
    return Object.freeze({
      ...base,
      principal: "system" as const,
      serviceName,
      scope: "tenant" as const,
      companyId: scope.companyId,
    });
  }
  return Object.freeze({
    ...base,
    principal: "system" as const,
    serviceName,
    scope: "global" as const,
  });
}

/**
 * Consumer: authenticated global discovery (ADR-0018). No company selector
 * is read, no membership or resolver runs, and the context carries no
 * company scope at all — the type forbids it.
 */
export function createConsumerContext(options: {
  readonly request: ActionRequestMeta;
  readonly runtime: ContextRuntime<ReadTx>;
  readonly session: SessionPrincipal | null;
}): ConsumerCtx {
  const { request, runtime } = options;
  const session = requireSession(options.session, "consumer");
  const clientIp = requireClientIp(request, "consumer");

  const actor: ActionActor = { type: "user", id: session.userId };
  return Object.freeze({
    ...buildBase({
      request,
      runtime,
      db: createReadTx(runtime.db),
      actor,
      companyId: null,
    }),
    principal: "consumer" as const,
    userId: session.userId,
    clientIp,
  });
}

/**
 * Account: authenticated own-account operations without tenant context
 * (ADR-0013 amended). Like consumer it carries no company scope; unlike
 * consumer it may receive a writable capability — the own-user
 * authorization boundary is enforced by handlers and inherited tests.
 */
export function createAccountContext<TDb extends ReadTx>(options: {
  readonly request: ActionRequestMeta;
  readonly runtime: ContextRuntime<TDb>;
  readonly session: SessionPrincipal | null;
}): AccountCtx<TDb> {
  const { request, runtime } = options;
  const session = requireSession(options.session, "account");
  const clientIp = requireClientIp(request, "account");

  const actor: ActionActor = { type: "user", id: session.userId };
  return Object.freeze({
    ...buildBase({
      request,
      runtime,
      db: runtime.db,
      actor,
      companyId: null,
    }),
    principal: "account" as const,
    userId: session.userId,
    clientIp,
  });
}

/**
 * Share: no session — the typed `resolveTarget` proves a valid unexpired
 * unrevoked capability token and returns the stored hash used as the
 * idempotency principal key (core.md §3/§5, ADR-0022). Log actor is
 * anonymous; raw tokens never enter log bindings.
 */
export async function createShareContext<
  TInput,
  TTarget,
  TDb extends ReadTx,
>(options: {
  readonly request: ActionRequestMeta;
  readonly runtime: ContextRuntime<TDb>;
  readonly input: TInput;
  readonly resolveTarget: (
    input: TInput,
    env: TargetResolutionEnv,
  ) => Promise<ResolvedTarget<TTarget>>;
  /** Verified company scope of a nested `ctx.call` caller (core.md §9). */
  readonly inheritedCompanyId?: string;
}): Promise<ShareCtx<TTarget, TDb>> {
  const { request, runtime } = options;
  const clientIp = requireClientIp(request, "share");

  const resolved = await options.resolveTarget(options.input, {
    tx: createReadTx(runtime.db),
    principal: { mode: "share" },
    ...(options.inheritedCompanyId !== undefined
      ? { inheritedCompanyId: options.inheritedCompanyId }
      : {}),
  });
  assertInheritedCompany(
    request.action,
    resolved.companyId,
    options.inheritedCompanyId,
  );
  const tokenHash = resolved.tokenHash;
  if (tokenHash === undefined || tokenHash === "") {
    throw new CoreInvariantError(
      `share resolver of "${request.action}" returned no tokenHash — the stored hash is the idempotency principal key (core.md §5)`,
    );
  }

  return Object.freeze({
    ...buildBase({
      request,
      runtime,
      db: runtime.db,
      actor: ANONYMOUS_ACTOR,
      companyId: resolved.companyId,
    }),
    principal: "share" as const,
    clientIp,
    target: { companyId: resolved.companyId, resource: resolved.resource },
    tokenHash,
  });
}

/**
 * The one resolved-tenant-scope helper used by logging, events, audit, and
 * operational metadata (core.md §3): staff and tenant-scoped system work
 * use `ctx.companyId`; customer, public-target, and share use the resolved
 * target; public-global, consumer, account, and global system work have none.
 */
export function effectiveCompanyId(ctx: ActionCtx): string | null {
  switch (ctx.principal) {
    case "staff":
      return ctx.companyId;
    case "customer":
      return ctx.target.companyId;
    case "public":
      return ctx.scope === "target" ? ctx.target.companyId : null;
    case "system":
      return ctx.scope === "tenant" ? ctx.companyId : null;
    case "share":
      return ctx.target.companyId;
    case "consumer":
    case "account":
      return null;
  }
}
