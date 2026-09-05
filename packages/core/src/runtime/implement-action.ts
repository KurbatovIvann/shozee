/**
 * `implementAction` — binds the server half of one logical action to its
 * client-safe descriptor (core.md §2, ADR-0016). Validates that exactly
 * the callbacks the contract metadata implies are present, then freezes
 * the pair. Registry-wide concerns (duplicates, pairing at boot) live in
 * `ActionRegistry`.
 */
import type { z } from "zod";

import type { ActionContract, ActionPrincipal } from "../contract/types.js";
import type { ActionCtxFor } from "./context/types.js";
import type {
  AuditSnapshotFn,
  AuditTargetFn,
  ConfirmationSummaryFn,
  TargetResolver,
} from "./types.js";

/**
 * Thrown when a binding violates core.md §2 at implement time. Like
 * `ActionContractDefinitionError`, this is a developer/CI error surfaced
 * at module load — not part of the runtime error vocabulary (§11) and
 * never reaches a client.
 */
export class ActionImplementationError extends Error {
  readonly actionName: string;
  readonly problems: readonly string[];

  constructor(actionName: string, problems: readonly string[]) {
    const details = problems.map((problem) => `  - ${problem}`).join("\n");
    super(`Invalid implementation of action "${actionName}":\n${details}`);
    this.name = "ActionImplementationError";
    this.actionName = actionName;
    this.problems = problems;
  }
}

/**
 * The server callbacks of one action. `handler` is always required; its
 * `ctx` is the `ActionCtx` arm matching `TPrincipal` (the contract's
 * `principal` literal). The rest are conditional on contract metadata and
 * validated at implement time (which callback pairs with which metadata is
 * listed in core.md §2).
 */
export interface ActionServerCallbacks<
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
  TTarget = never,
  TPrincipal extends ActionPrincipal = ActionPrincipal,
> {
  /**
   * Declared as a method so parameter checking is bivariant: a staff
   * handler is assignable to the pipeline/registry's erased `ActionCtx`
   * slot. Sound because `executeAction` constructs the matching factory
   * result before invoking.
   *
   * `NoInfer` is load-bearing — do not drop it. Without it an explicitly
   * annotated `ctx` is a second inference candidate for `TPrincipal`, and
   * TS widens to the union of both candidates rather than rejecting the
   * mismatch: a `staff` contract with a `ctx: CustomerCtx` handler
   * resolves to `TPrincipal = "staff" | "customer"`, silently un-pinning
   * the principal the contract declared. The bivariance this method form
   * buys still admits an annotation narrower than what the pipeline
   * supplies (a `risk: "read"` handler annotating `StaffCtx<Tx>`);
   * SHO-453 closes that by moving back to a property plus an explicit
   * erased shape.
   */
  handler(
    input: z.output<TInput>,
    ctx: ActionCtxFor<NoInfer<TPrincipal>>,
  ): Promise<z.input<TOutput>>;
  /** Required for customer, public-target, and share actions, forbidden otherwise. */
  readonly resolveTarget?: TargetResolver<TInput, TTarget>;
  /** Required when `requiresConfirmation: true`, forbidden otherwise. */
  readonly confirmationSummary?: ConfirmationSummaryFn<TInput>;
  /** Required when `audit: true`, forbidden otherwise. */
  readonly auditTarget?: AuditTargetFn;
  /** Optional, allowed only when `audit: true` (hash-only is the default). */
  readonly auditSnapshot?: AuditSnapshotFn<TInput>;
}

declare const implementedActionBrand: unique symbol;

/**
 * A validated contract/callback pair. The phantom brand keeps hand-rolled
 * objects out of the registry, mirroring `ActionContract`. `TPrincipal`
 * is the contract's `principal` literal; the three-argument form still
 * means the full union (pipeline/registry erasure).
 */
export type ImplementedAction<
  TInput extends z.ZodType = z.ZodType,
  TOutput extends z.ZodType = z.ZodType,
  TTarget = never,
  TPrincipal extends ActionPrincipal = ActionPrincipal,
> = Readonly<ActionServerCallbacks<TInput, TOutput, TTarget, TPrincipal>> & {
  readonly contract: ActionContract<TInput, TOutput, TPrincipal>;
  readonly [implementedActionBrand]: true;
};

/**
 * Binds server callbacks to a validated contract. Throws
 * `ActionImplementationError` listing **all** violations, so a broken
 * binding is fixed in one round.
 */
export function implementAction<
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
  TPrincipal extends ActionPrincipal,
  TTarget = never,
>(
  contract: ActionContract<TInput, TOutput, TPrincipal>,
  callbacks: ActionServerCallbacks<TInput, TOutput, TTarget, TPrincipal>,
): ImplementedAction<TInput, TOutput, TTarget, TPrincipal> {
  const problems = collectBindingProblems(contract, callbacks);
  if (problems.length > 0) {
    throw new ActionImplementationError(contract.name, problems);
  }
  // The brand is a compile-time marker for pairs that passed this
  // validation, so the single assertion is backed by the checks above.
  return Object.freeze({ contract, ...callbacks }) as ImplementedAction<
    TInput,
    TOutput,
    TTarget,
    TPrincipal
  >;
}

function collectBindingProblems(
  contract: ActionContract,
  callbacks: Pick<
    ActionServerCallbacks<z.ZodType, z.ZodType, unknown>,
    "resolveTarget" | "confirmationSummary" | "auditTarget" | "auditSnapshot"
  >,
): string[] {
  const problems: string[] = [];

  const requiresResolver =
    contract.principal === "customer" ||
    contract.principal === "share" ||
    (contract.principal === "public" && contract.publicScope === "target");
  if (requiresResolver && callbacks.resolveTarget === undefined) {
    problems.push(
      contract.principal === "customer"
        ? "customer actions must bind resolveTarget — the typed resolver is the ownership proof (core.md §3)"
        : contract.principal === "share"
          ? "share actions must bind resolveTarget — the typed resolver is the valid-token proof (core.md §3)"
          : 'public actions with publicScope "target" must bind resolveTarget — the typed resolver is the visibility proof (core.md §3)',
    );
  }
  if (!requiresResolver && callbacks.resolveTarget !== undefined) {
    problems.push(
      "resolveTarget is allowed only on customer, public-target, and share actions (core.md §2)",
    );
  }

  if (
    contract.requiresConfirmation &&
    callbacks.confirmationSummary === undefined
  ) {
    problems.push(
      "requiresConfirmation: true actions must bind confirmationSummary (core.md §7)",
    );
  }
  if (
    !contract.requiresConfirmation &&
    callbacks.confirmationSummary !== undefined
  ) {
    problems.push(
      "confirmationSummary is allowed only when requiresConfirmation: true",
    );
  }

  if (contract.audit && callbacks.auditTarget === undefined) {
    problems.push("audit: true actions must bind auditTarget (core.md §8)");
  }
  if (!contract.audit && callbacks.auditTarget !== undefined) {
    problems.push("auditTarget is allowed only when audit: true");
  }
  if (!contract.audit && callbacks.auditSnapshot !== undefined) {
    problems.push("auditSnapshot is allowed only when audit: true");
  }
  if (
    contract.principal === "share" &&
    contract.risk === "write" &&
    callbacks.auditSnapshot === undefined
  ) {
    problems.push(
      "share writes must bind auditSnapshot — redacted certificate identity, never the raw token (core.md §8)",
    );
  }

  return problems;
}
