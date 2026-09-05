/**
 * The action registry (ADR-0008, ADR-0016): the single place every
 * business capability is registered. Boot code registers each module's
 * contract barrel (`index.contract.ts`) and implementation barrel
 * (`index.ts`), then calls `assertPaired()` — an orphan descriptor or
 * implementation fails boot before anything serves traffic. The
 * registry-walking metadata rule matrix is the contract check (fnd-T10).
 */
import type { z } from "zod";

import type { ActionContract } from "../contract/types.js";
import type { ImplementedAction } from "./implement-action.js";
import type {
  AuditTargetEnv,
  AuditTargetRef,
  ConfirmationSummaryEnv,
  JsonValue,
  MaybePromise,
  ResolvedTarget,
  TargetResolutionEnv,
} from "./types.js";

/**
 * Thrown on duplicate registration or failed pairing validation. A
 * developer/CI/boot error — not part of the runtime vocabulary (core.md
 * §11) and never reaches a client.
 */
export class ActionRegistryError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    const details = problems.map((problem) => `  - ${problem}`).join("\n");
    super(`Action registry validation failed:\n${details}`);
    this.name = "ActionRegistryError";
    this.problems = problems;
  }
}

/** A registered contract with its schema generics erased for storage. */
export type AnyActionContract = ActionContract;

/**
 * The registry-facing erasure of an implemented action: contract metadata
 * stays fully readable while callback inputs and `ctx` erase to `never`,
 * so a stored implementation cannot be invoked without the pipeline
 * (fnd-T12) first validating input against `contract.input` and
 * constructing the matching principal context.
 */
export interface RegisteredImplementation {
  readonly contract: AnyActionContract;
  readonly handler: (input: never, ctx: never) => Promise<unknown>;
  readonly resolveTarget?: (
    input: never,
    env: TargetResolutionEnv,
  ) => Promise<ResolvedTarget<unknown>>;
  readonly confirmationSummary?: (
    input: never,
    env: ConfirmationSummaryEnv,
  ) => MaybePromise<string>;
  readonly auditTarget?: (env: AuditTargetEnv) => MaybePromise<AuditTargetRef>;
  readonly auditSnapshot?: (input: never) => JsonValue;
}

export class ActionRegistry {
  private readonly contractsByName = new Map<string, AnyActionContract>();
  private readonly implementationsByName = new Map<
    string,
    RegisteredImplementation
  >();

  /** Registers a client-safe descriptor. Duplicate names fail immediately. */
  registerContract<TInput extends z.ZodType, TOutput extends z.ZodType>(
    contract: ActionContract<TInput, TOutput>,
  ): void {
    if (this.contractsByName.has(contract.name)) {
      throw new ActionRegistryError([
        `duplicate contract "${contract.name}" — action names are unique in the registry (core.md §2)`,
      ]);
    }
    this.contractsByName.set(contract.name, contract);
  }

  /** Registers a server implementation. Duplicate names fail immediately. */
  registerImplementation<
    TInput extends z.ZodType,
    TOutput extends z.ZodType,
    TTarget,
  >(implementation: ImplementedAction<TInput, TOutput, TTarget>): void {
    const name = implementation.contract.name;
    if (this.implementationsByName.has(name)) {
      throw new ActionRegistryError([
        `duplicate implementation "${name}" — one logical action has exactly one server implementation (ADR-0016)`,
      ]);
    }
    this.implementationsByName.set(name, implementation);
  }

  getContract(name: string): AnyActionContract | undefined {
    return this.contractsByName.get(name);
  }

  getImplementation(name: string): RegisteredImplementation | undefined {
    return this.implementationsByName.get(name);
  }

  /** All registered descriptors — the contract check (fnd-T10) walks this. */
  contracts(): readonly AnyActionContract[] {
    return [...this.contractsByName.values()];
  }

  implementations(): readonly RegisteredImplementation[] {
    return [...this.implementationsByName.values()];
  }

  /**
   * Boot-time pairing validation (ADR-0016): every contract has exactly
   * one implementation bound to the **same descriptor object** — a second
   * `defineActionContract` call with the same name is drift, not a pair —
   * and no implementation exists without a registered contract. Throws
   * with all problems listed.
   */
  assertPaired(): void {
    const problems: string[] = [];
    for (const [name, contract] of this.contractsByName) {
      const implementation = this.implementationsByName.get(name);
      if (implementation === undefined) {
        problems.push(
          `contract "${name}" has no registered implementation (orphan descriptor)`,
        );
      } else if (implementation.contract !== contract) {
        problems.push(
          `implementation of "${name}" is bound to a different contract object — the server file must import the descriptor, not redefine it`,
        );
      }
    }
    for (const name of this.implementationsByName.keys()) {
      if (!this.contractsByName.has(name)) {
        problems.push(
          `implementation "${name}" has no registered contract (orphan implementation)`,
        );
      }
    }
    if (problems.length > 0) {
      throw new ActionRegistryError(problems);
    }
  }
}
