/**
 * Derives the oRPC contract router from action descriptors (contract.md
 * §2, ADR-0004). Client-safe: consumes only `@showzy/core/contract`
 * descriptors and `@orpc/contract` builders — the typed client, the
 * OpenAPI document (fnd-T25), and the server router (./server) all
 * derive from the same composition, so they cannot drift.
 *
 * Only `transport: "client"` descriptors are routable. Internal and
 * system actions are not filtered out silently — passing one here is a
 * composition bug and fails loudly, so the explicit client-exposure
 * record each module composes stays honest (the server-router builder
 * additionally proves the record covers every registered client action).
 */
import { oc } from "@orpc/contract";
import type { ActionContract } from "@showzy/core/contract";
import type { z } from "zod";

import { procedureErrorDefinitions } from "./wire-errors.js";

/**
 * Thrown when the composition violates contract.md §2 at build time. A
 * developer/CI/boot error listing **all** problems — not part of the
 * runtime error vocabulary and never on the wire.
 */
export class ContractCompositionError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    const details = problems.map((problem) => `  - ${problem}`).join("\n");
    super(`Contract composition failed:\n${details}`);
    this.name = "ContractCompositionError";
    this.problems = problems;
  }
}

/**
 * The composition shape: module name → verb → client-routable descriptor.
 * Keys must mirror each descriptor's `<module>.<verb>` name — the RPC
 * path is derived from the record nesting, so a mismatch would silently
 * route one action under another's name (validated at build time).
 */
export interface ContractModuleMap {
  readonly [moduleName: string]: {
    readonly [verb: string]: ActionContract;
  };
}

/**
 * One descriptor → one oRPC contract procedure: the action's own Zod
 * schemas, pipeline-universal §4 errors union `contract.errors`, and the
 * description as the OpenAPI/AI summary (contract.md §5). OpenAPI and the
 * typed client both derive from this map — do not post-process responses
 * by HTTP status.
 */
export function toContractProcedure<
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
>(contract: ActionContract<TInput, TOutput>) {
  return oc
    .errors(procedureErrorDefinitions(contract.errors))
    .route({ summary: contract.description })
    .input(contract.input)
    .output(contract.output);
}

export type ContractProcedureFor<TContract extends ActionContract> =
  TContract extends ActionContract<infer TInput, infer TOutput>
    ? ReturnType<typeof toContractProcedure<TInput, TOutput>>
    : never;

/** The statically typed router shape `buildContractRouter` produces. */
export type ContractRouterFor<TModules extends ContractModuleMap> = {
  readonly [TModule in keyof TModules]: {
    readonly [TVerb in keyof TModules[TModule]]: ContractProcedureFor<
      TModules[TModule][TVerb]
    >;
  };
};

/**
 * Composition rules checkable from the record alone. Shared with the
 * server-router builder (./server) so both routers reject the same
 * violations.
 */
export function collectCompositionProblems(
  modules: ContractModuleMap,
): string[] {
  const problems: string[] = [];
  for (const [moduleName, actions] of Object.entries(modules)) {
    for (const [verb, contract] of Object.entries(actions)) {
      const expectedName = `${moduleName}.${verb}`;
      if (contract.name !== expectedName) {
        problems.push(
          `entry "${expectedName}" is bound to descriptor "${contract.name}" — record keys must mirror the action name so the RPC path cannot drift`,
        );
      }
      if (contract.transport !== "client") {
        problems.push(
          `"${contract.name}" declares transport "${contract.transport}" — only transport: "client" descriptors are routable; internal and system actions have no endpoint (contract.md §2)`,
        );
      }
    }
  }
  return problems;
}

/**
 * Builds the client contract router. Throws `ContractCompositionError`
 * listing every violation, so a broken composition is fixed in one round.
 */
export function buildContractRouter<TModules extends ContractModuleMap>(
  modules: TModules,
): ContractRouterFor<TModules> {
  const problems = collectCompositionProblems(modules);
  if (problems.length > 0) {
    throw new ContractCompositionError(problems);
  }
  const router: Record<string, Record<string, unknown>> = {};
  for (const [moduleName, actions] of Object.entries(modules)) {
    const procedures: Record<string, unknown> = {};
    for (const [verb, contract] of Object.entries(actions)) {
      procedures[verb] = toContractProcedure(contract);
    }
    router[moduleName] = procedures;
  }
  // Dynamic record construction TypeScript cannot track: every entry was
  // built by `toContractProcedure`, which is exactly what the mapped type
  // states per key.
  return router as ContractRouterFor<TModules>;
}
