/**
 * Serializable action-contract metadata (core.md §2, ADR-0016).
 *
 * Everything in this file is client-safe: plain unions and shapes plus Zod
 * schema types. Server callbacks (`handler`, `resolveTarget`,
 * `confirmationSummary`, `auditTarget`, `auditSnapshot`) are deliberately
 * absent — they are bound by `implementAction` (fnd-T9) on the server side.
 */
import type { z } from "zod";

/** ADR-0013, ADR-0018, ADR-0020, ADR-0022 — exactly one mode per action. */
export type ActionPrincipal =
  "staff" | "customer" | "public" | "system" | "consumer" | "account" | "share";

/** Whether HTTP/client routers mount the action. */
export type ActionTransport = "client" | "internal";

/** `exposed` actions become AI tools; requires `transport: client`. */
export type ActionAiExposure = "exposed" | "internal";

/** `read` actions run in a read-only transaction with a `ReadTx` facade. */
export type ActionRisk = "read" | "draft" | "write" | "high";

/**
 * Public-only scope: `target` resolves one published company/resource via a
 * typed resolver; `globalProjection` is an ADR-0020 published discovery
 * projection bound to a declared grant.
 */
export type PublicScope = "target" | "globalProjection";

/** System-only scope; `global` is reserved for genuinely global jobs. */
export type SystemScope = "tenant" | "global";

/**
 * Per-action override of the principal-default rate limit (core.md §10).
 * Key semantics are implemented by the rate limiter (fnd-T14); the scope
 * names mirror the default key kinds: per accountable user, per rotating
 * IP HMAC (public), per effective company, or one global bucket.
 */
export interface ActionRateLimit {
  readonly limit: number;
  readonly windowSec: number;
  readonly scope: "user" | "ipHmac" | "company" | "global";
}

/**
 * The shape accepted by `defineActionContract`.
 *
 * This type is intentionally permissive about cross-field combinations
 * (e.g. it does not statically forbid `publicScope` on a staff action):
 * the authoritative enforcement is the define-time validation in
 * `defineActionContract`, which throws `ActionContractDefinitionError`
 * with every violation. Keeping the input type wide means invalid
 * combinations are rejected with a precise message instead of an opaque
 * compile error, and the rejection paths stay testable without type
 * suppressions. The registry-wide rule matrix (duplicates, event
 * definitions, call graphs, grant existence) lands with the contract
 * check (fnd-T10).
 */
export interface ActionContractDefinition<
  TInput extends z.ZodType = z.ZodType,
  TOutput extends z.ZodType = z.ZodType,
> {
  /** `<module>.<verb>`, imperative camelCase verb; unique in the registry. */
  readonly name: string;
  /** Written as an instruction to an AI model; doubles as OpenAPI summary. */
  readonly description: string;
  readonly principal: ActionPrincipal;
  readonly transport: ActionTransport;
  /** Zod v4 schema — the single source for oRPC, forms, and AI tools. */
  readonly input: TInput;
  readonly output: TOutput;
  /**
   * `<module>:<verb>` permission strings. Non-empty for `staff`; must be
   * `[]` for every other principal (their authorization is ownership,
   * visibility, published-read, own-user identity, or a valid share
   * token — core.md §4).
   */
  readonly permissions: readonly string[];
  /** Required for `public` actions, forbidden otherwise. */
  readonly publicScope?: PublicScope;
  /**
   * Required for `publicScope: "globalProjection"`, forbidden otherwise.
   * Must match a grant declared by the projection owner (checked in
   * fnd-T10 against the projection-grant manifest).
   */
  readonly projectionGrant?: string;
  /** Required for `system` actions, forbidden otherwise. */
  readonly systemScope?: SystemScope;
  readonly aiExposure: ActionAiExposure;
  readonly risk: ActionRisk;
  /** Required `true` for human-invoked `risk: "high"` (core.md §7). */
  readonly requiresConfirmation: boolean;
  /** Write actions with `true` participate in the idempotency protocol. */
  readonly idempotent: boolean;
  /**
   * Declared outbox events, `<module>.<pastVerb>` in this action's module;
   * `ctx.emit` of an undeclared event throws.
   */
  readonly emits: readonly string[];
  /**
   * ADR-0021 allowlist edges. `atomicCalls` lists internal atomic callees
   * this root action may invoke; `atomicCallers` lists root actions allowed
   * to invoke this internal callee. Both are usually `[]`; declaring them
   * is explicit so the exceptional edges stand out in review.
   */
  readonly atomicCalls: readonly string[];
  readonly atomicCallers: readonly string[];
  /** Mandatory `true` for `risk: "write" | "high"` (core.md §8). */
  readonly audit: boolean;
  /** Whole-pipeline deadline in milliseconds, shared with nested calls. */
  readonly timeout: number;
  readonly rateLimit?: ActionRateLimit;
}

declare const actionContractBrand: unique symbol;

/**
 * A definition that passed define-time validation. The phantom brand keeps
 * hand-rolled objects out of APIs that require a validated contract
 * (`implementAction`, the registry — fnd-T9).
 *
 * `TPrincipal` is the contract's `principal` literal so `implementAction`
 * can give the handler that arm of `ActionCtx`. The two-argument form
 * (`ActionContract<TInput, TOutput>`) still means the full principal union —
 * that is the registry/erasure shape, not the handler-authoring shape.
 */
export type ActionContract<
  TInput extends z.ZodType = z.ZodType,
  TOutput extends z.ZodType = z.ZodType,
  TPrincipal extends ActionPrincipal = ActionPrincipal,
> = Readonly<ActionContractDefinition<TInput, TOutput>> & {
  readonly principal: TPrincipal;
  readonly [actionContractBrand]: true;
};
