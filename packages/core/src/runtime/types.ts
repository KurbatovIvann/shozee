/**
 * Server-callback shapes bound by `implementAction` (core.md §2, ADR-0016).
 *
 * Return types are spec commitments and fully typed. `ActionHandler` is
 * keyed on the contract `principal` literal (SHO-416). `ActionExecutionCtx`
 * and `TargetResolutionEnv` were narrowed by the principal context
 * factories (fnd-T11); `AuditTargetEnv` by fnd-T13; `ConfirmationSummaryEnv`
 * by fnd-T20. Narrowing an alias is type-only and cannot break the binding
 * API committed here.
 */
import type { ReadTx } from "@showzy/db";
import type { z } from "zod";

import type { ActionCtx, ActionCtxFor } from "./context/types.js";

export type MaybePromise<T> = T | Promise<T>;

/** JSON-safe value — what redacted audit snapshots must return. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * The full seven-mode union the pipeline and registry use after principal
 * erasure. Handlers bound by `implementAction` see
 * `ActionCtxFor<contract.principal>` instead (core.md §2/§3).
 */
export type ActionExecutionCtx = ActionCtx;

/**
 * Who is asking, from the resolver's point of view (core.md §2): customer
 * resolution receives the authenticated `userId` to prove ownership;
 * public-target and share resolution are anonymous and prove
 * publication/visibility or a valid unexpired unrevoked token.
 */
export type TargetResolutionPrincipal =
  | { readonly mode: "customer"; readonly userId: string }
  | { readonly mode: "public" }
  | { readonly mode: "share" };

/**
 * The environment a typed target resolver runs in (core.md §2): a
 * read-only capability — even when the surrounding transaction is
 * writable — plus the resolving principal. `inheritedCompanyId` is
 * supplied on nested `ctx.call` resolution (core.md §9) and the factory
 * enforces that the resolved company matches it.
 */
export interface TargetResolutionEnv {
  readonly tx: ReadTx;
  readonly principal: TargetResolutionPrincipal;
  readonly inheritedCompanyId?: string;
}

/**
 * What `confirmationSummary` sees (core.md §7): the preflight-verified
 * company scope (null for account) and, when a typed resolver ran, the
 * loaded resource. Must stay redacted — the string it returns is the only
 * confirmation detail that crosses the wire.
 */
export interface ConfirmationSummaryEnv {
  readonly companyId: string | null;
  readonly target?: unknown;
}

/**
 * The environment `auditTarget` receives (core.md §8, narrowed by fnd-T13).
 * `output` is present on success and absent on failure/denial; `ctx` is
 * present when the execution transaction constructed it (absent on pre-handler
 * denials). Callbacks must tolerate missing fields — `input` is always available.
 */
export interface AuditTargetEnv {
  readonly input: unknown;
  readonly output?: unknown;
  readonly ctx?: ActionCtx;
}

/**
 * What a typed target resolver must prove (core.md §2): the loaded
 * resource is the ownership/visibility/valid-token evidence and
 * `companyId` becomes the verified tenant scope of the whole invocation.
 * Share resolvers must also return `tokenHash` — the stored hash of the
 * capability token, never the raw secret (core.md §5).
 */
export interface ResolvedTarget<TTarget> {
  readonly companyId: string;
  readonly resource: TTarget;
  /** Share only: stored capability-token hash. Other modes omit this. */
  readonly tokenHash?: string;
}

/** The audit row's target reference (core.md §8). */
export interface AuditTargetRef {
  readonly type: string;
  readonly id: string;
}

/**
 * Runs inside the pipeline transaction. Receives Zod-validated input and
 * the `ActionCtx` arm matching the contract's `principal` literal (core.md
 * §2/§3). Returns a value that the pipeline validates against the output
 * schema before commit (a mismatch is `CoreInvariantError`, core.md §4).
 */
export type ActionHandler<
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
  TPrincipal extends ActionCtx["principal"] = ActionCtx["principal"],
> = (
  input: z.output<TInput>,
  ctx: ActionCtxFor<TPrincipal>,
) => Promise<z.input<TOutput>>;

/**
 * Loads the referenced resource and proves ownership/visibility; throws
 * `NotFoundError` on any failure — never "forbidden", so existence does
 * not leak (core.md §2).
 */
export type TargetResolver<TInput extends z.ZodType, TTarget> = (
  input: z.output<TInput>,
  env: TargetResolutionEnv,
) => Promise<ResolvedTarget<TTarget>>;

/**
 * Returns the redacted, human-readable summary shown on the confirmation
 * card/dialog (core.md §7). Must not include secrets or non-obvious PII.
 */
export type ConfirmationSummaryFn<TInput extends z.ZodType> = (
  input: z.output<TInput>,
  env: ConfirmationSummaryEnv,
) => MaybePromise<string>;

/** Derives the audit target from validated input/output/context (§8). */
export type AuditTargetFn = (
  env: AuditTargetEnv,
) => MaybePromise<AuditTargetRef>;

/**
 * Opt-in redacted input snapshot for the audit row (core.md §8). Hash-only
 * is the default; returning unredacted input is forbidden (prohibitions:
 * no PII/secrets in logs).
 */
export type AuditSnapshotFn<TInput extends z.ZodType> = (
  input: z.output<TInput>,
) => JsonValue;
