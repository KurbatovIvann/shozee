/**
 * The seven-mode principal context union (core.md §3; ADR-0013, ADR-0018,
 * ADR-0020, ADR-0022). One verified context shape per principal mode — a
 * handler matching on `ctx.principal` gets exactly the fields that mode
 * guarantees, and nothing a different caller kind would carry.
 *
 * Construction happens only through the factories in `factories.ts`
 * (core.md §3: "exactly one factory per mode, nothing ad-hoc"). Nothing
 * else in the package assembles these objects.
 */
import type { ProjectionGrant, ProjectionReadTx, ReadTx, Tx } from "@showzy/db";
import type { Logger } from "pino";
import type { z } from "zod";

import type { EventDefinition, EventEmission } from "../events/define-event.js";
// Type-only and erased at compile time — no runtime import cycle exists.
import type { ImplementedAction } from "../implement-action.js";

/** How the action was invoked; audit and logs carry it (blueprint §2.1-4). */
export type ActionChannel = "ui" | "ai" | "system" | "webhook";

/**
 * The accountable identity of an invocation. `anonymous` exists only for
 * access logs/traces on public and share actions — event and audit schemas
 * accept user/system actors only (core.md §2). Share writes remap to
 * `SHARE_DURABLE_ACTOR` at the audit/event flush.
 */
export type ActionActor =
  | { readonly type: "user"; readonly id: string }
  | { readonly type: "system"; readonly id: string }
  | { readonly type: "anonymous"; readonly id: "anonymous" };

/**
 * Durable audit/event actor for share writes (core.md §8, ADR-0022). Access
 * logs stay `anonymous`; `audit_log` / `domain_events` CHECKs are
 * `user|system`, so the stored actor is `system`/`share`.
 */
export const SHARE_DURABLE_ACTOR = {
  type: "system",
  id: "share",
} as const satisfies ActionActor;

/** `company_members.role` values (companies-foundation.md §2). */
export type CompanyRole = "owner" | "admin" | "manager" | "employee";

/**
 * The verified membership carried by a staff context. `permissions` is the
 * resolved effective set for non-owner roles (role defaults plus explicit
 * grants, minus explicit denies); check it through `staffHasPermission`,
 * which also short-circuits the owner-has-all rule — never by reading the
 * array directly.
 */
export interface StaffMembership {
  readonly role: CompanyRole;
  readonly permissions: readonly string[];
}

/**
 * `ctx.emit` (core.md §6, fnd-T16). Synchronous: the call validates the
 * emission (declared name, payload against the definition's schema,
 * aggregate shape) and buffers it; the pipeline inserts the outbox rows and
 * per-aggregate sequence increments inside the execution transaction
 * (§4 step 9), so a rollback removes both. Emitting an undeclared event —
 * or emitting from a read action — throws `CoreInvariantError`.
 */
export type CtxEmit = <TPayload extends z.ZodType>(
  event: EventDefinition<TPayload>,
  emission: EventEmission<TPayload>,
) => void;

/**
 * `ctx.call` (core.md §9, ADR-0015 — fnd-T19): synchronous cross-module
 * composition. Takes another module's implemented `risk: "read"` action —
 * imported from that module's `index.ts`, its public API — plus input, and
 * returns the callee's validated output. The callee runs in the caller's
 * transaction (it sees uncommitted writes) and principal context, but
 * behind the `ReadTx` facade even when the caller's transaction is
 * writable; its own `permissions`/`resolveTarget` re-execute, nested
 * resolvers must resolve to the caller's verified company, and the
 * timeout budget is shared. The §9 target rules, the depth limit of 3,
 * and cycle detection are asserted at runtime and proven in CI.
 */
export type CtxCall = <
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
  TTarget,
>(
  action: ImplementedAction<TInput, TOutput, TTarget>,
  input: z.input<TInput>,
) => Promise<z.output<TOutput>>;

/**
 * `ctx.callAtomic` (core.md §9, ADR-0021 — fnd-T19A): the exceptional
 * all-or-nothing cross-module write. Takes another module's implemented
 * internal `risk: "write"` action — the edge mutually declared via
 * `atomicCalls`/`atomicCallers` — plus input, and returns the callee's
 * validated output. The callee runs in the **root physical transaction**
 * with the writable `Tx` capability, under the same principal re-verified
 * through the normal context factories; its validation, authorization,
 * output validation, audit, and events execute normally and commit only
 * with the root. Available only inside a writable, idempotent root
 * action's handler; one atomic edge per invocation, no nesting — every
 * violation is a `CoreInvariantError` at the call, asserted from the same
 * rule list the contract check proves in CI.
 */
export type CtxCallAtomic = <
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
  TTarget,
>(
  action: ImplementedAction<TInput, TOutput, TTarget>,
  input: z.input<TInput>,
) => Promise<z.output<TOutput>>;

/**
 * Fields common to every principal mode (core.md §3). `TDb` is the
 * capability the handler's declared `risk` allows: `ReadTx` for reads,
 * `Tx` for mutations, `ProjectionReadTx` for public-global.
 */
export interface BaseCtx<TDb> {
  readonly db: TDb;
  readonly requestId: string;
  /** Propagated across `ctx.call` and events. */
  readonly correlationId: string;
  readonly actor: ActionActor;
  readonly channel: ActionChannel;
  /** Trusted-proxy normalized; rate-limit use only, never a log/audit field. */
  readonly clientIp?: string;
  readonly aiTraceId?: string;
  readonly toolCallId?: string;
  /** Whole-pipeline deadline (epoch ms), shared with nested calls. */
  readonly deadline: number;
  /** Shared with nested calls and external clients (core.md §4). */
  readonly signal: AbortSignal;
  /** pino child bound to request/actor/company/action (security-ops §6). */
  readonly log: Logger;
  readonly emit: CtxEmit;
  readonly call: CtxCall;
  readonly callAtomic: CtxCallAtomic;
}

/** Authenticated member of the selected company (the panel surface). */
export interface StaffCtx<TDb = Tx> extends BaseCtx<TDb> {
  readonly principal: "staff";
  readonly userId: string;
  /** Derived from the verified membership row — never from the selector. */
  readonly companyId: string;
  readonly membership: StaffMembership;
}

/**
 * Authenticated user acting on a company they do not manage (the cabinet
 * surface). The typed resolver's result is the ownership proof.
 */
export interface CustomerCtx<TTarget = unknown, TDb = Tx> extends BaseCtx<TDb> {
  readonly principal: "customer";
  readonly userId: string;
  readonly target: { readonly companyId: string; readonly resource: TTarget };
}

/** Unauthenticated read of one published company/resource. */
export interface PublicTargetCtx<TTarget = unknown> extends BaseCtx<ReadTx> {
  readonly principal: "public";
  readonly scope: "target";
  readonly clientIp: string;
  readonly target: { readonly companyId: string; readonly resource: TTarget };
}

/**
 * Unauthenticated global discovery read (ADR-0020), bound to one declared
 * projection grant — the context's DB capability cannot reach any other
 * table or column.
 */
export interface PublicGlobalCtx<
  TGrant extends ProjectionGrant = ProjectionGrant,
> extends BaseCtx<ProjectionReadTx<TGrant>> {
  readonly principal: "public";
  readonly scope: "globalProjection";
  readonly clientIp: string;
  readonly projectionGrant: TGrant["id"];
  readonly companyId?: never;
  readonly target?: never;
}

export type PublicCtx<
  TTarget = unknown,
  TGrant extends ProjectionGrant = ProjectionGrant,
> = PublicTargetCtx<TTarget> | PublicGlobalCtx<TGrant>;

/**
 * Workers, cron, webhook handlers, outbox consumers. Scope is set
 * explicitly by the enqueuing code — never "all companies" by default.
 */
export type SystemCtx<TDb = Tx> = BaseCtx<TDb> & {
  readonly principal: "system";
  readonly serviceName: string;
} & (
    | { readonly scope: "tenant"; readonly companyId: string }
    | { readonly scope: "global"; readonly companyId?: never }
  );

/**
 * Authenticated global discovery without company scope (ADR-0018).
 * Read-only; may access only declared discovery projections and published
 * facts (enforced by owning specs and inherited tests, not by this type).
 */
export interface ConsumerCtx extends BaseCtx<ReadTx> {
  readonly principal: "consumer";
  readonly userId: string;
  readonly clientIp: string;
  readonly companyId?: never;
  readonly target?: never;
  readonly membership?: never;
}

/**
 * Authenticated own-account operations before/outside any tenant context
 * (ADR-0013 amended). May write (`TDb = Tx`); the handler may touch only
 * resources belonging to `userId` — no company RBAC applies.
 */
export interface AccountCtx<TDb = Tx> extends BaseCtx<TDb> {
  readonly principal: "account";
  readonly userId: string;
  readonly clientIp: string;
  readonly companyId?: never;
  readonly target?: never;
  readonly membership?: never;
}

/**
 * Unauthenticated capability-token holder (ADR-0022). Log `actor` is
 * anonymous; `tokenHash` is the stored hash from the resolved token row
 * (never the raw secret) and is the idempotency principal key.
 */
export interface ShareCtx<TTarget = unknown, TDb = Tx> extends BaseCtx<TDb> {
  readonly principal: "share";
  readonly clientIp: string;
  readonly target: { readonly companyId: string; readonly resource: TTarget };
  /** Stored capability-token hash; never the raw secret (core.md §5). */
  readonly tokenHash: string;
  readonly userId?: never;
  readonly membership?: never;
}

/**
 * The seven-mode principal vocabulary (core.md §3). Factories construct one
 * arm; a handler bound by `implementAction` receives {@link ActionCtxFor}
 * of the contract's declared `principal`, not this whole union.
 */
export type ActionCtx =
  | StaffCtx<ReadTx | Tx>
  | CustomerCtx<unknown, ReadTx | Tx>
  | PublicCtx
  | SystemCtx<ReadTx | Tx>
  | ConsumerCtx
  | AccountCtx<ReadTx | Tx>
  | ShareCtx<unknown, ReadTx | Tx>;

/**
 * Handler-facing slice of {@link ActionCtx} for one contract principal
 * (core.md §2/§3). Inner discriminants the contract does not pin stay as
 * unions: `public` is target | globalProjection, `system` is tenant | global.
 */
export type ActionCtxFor<TPrincipal extends ActionCtx["principal"]> = Extract<
  ActionCtx,
  { readonly principal: TPrincipal }
>;
