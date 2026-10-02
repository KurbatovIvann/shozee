/**
 * Pairs the client contract router with registered implementations
 * through the core execution pipeline (contract.md §2 layer 2, ADR-0004,
 * ADR-0016). Built once at API boot; every procedure runs `executeAction`
 * — there is no second data path.
 */
import { implement } from "@orpc/server";
import {
  executeAction,
  type ActionPipelineDeps,
  type ActionRegistry,
  type AnyActionContract,
  type ImplementedAction,
} from "@showzy/core";
import type { z } from "zod";

import {
  collectCompositionProblems,
  ContractCompositionError,
  toContractProcedure,
  type ContractModuleMap,
} from "../client/contract-router.js";
import {
  toPipelineRequestMeta,
  toPrincipalInvocation,
  type TransportInvocationContext,
} from "./transport-context.js";
import { toWireError } from "./wire-error.js";

export interface ServerRouterDeps {
  /** The boot registry — both barrels of every module registered. */
  readonly registry: ActionRegistry;
  /** The composed pipeline (hooks, telemetry, db) actions run under. */
  readonly pipeline: ActionPipelineDeps;
}

/**
 * One contract procedure implemented against the pipeline. Schema generics
 * are erased here — end-to-end typing belongs to the *client* contract
 * router; the transport handler only needs matching paths and runtime
 * schemas, both of which derive from the same descriptor.
 *
 * Two constructions at boot are accepted (SHO-277 owner decision): the
 * client exposure record (`buildContractRouter` / `toContractProcedure`
 * on `contractModules`) is the published typed client. This function
 * then `implement(toContractProcedure(contract))` to pair each descriptor
 * with `executeAction`. They are different layers — do not delete
 * `contractRouter` to "dedupe" them.
 */
function toServerProcedure(
  contract: AnyActionContract,
  action: ImplementedAction<z.ZodType, z.ZodType, unknown>,
  pipeline: ActionPipelineDeps,
) {
  return implement(toContractProcedure(contract))
    .$context<TransportInvocationContext>()
    .handler(async ({ input, context }) => {
      try {
        return await executeAction(pipeline, {
          action,
          input,
          request: toPipelineRequestMeta(context),
          principal: toPrincipalInvocation(contract, context),
        });
      } catch (error) {
        throw toWireError(error, contract.risk);
      }
    });
}

export type ServerProcedure = ReturnType<typeof toServerProcedure>;

/** The routable server procedures, nested `module → verb` like the contract. */
export type ServerRouter = {
  readonly [moduleName: string]: {
    readonly [verb: string]: ServerProcedure;
  };
};

/**
 * Builds the mountable server router. Boot fails loudly on any pairing
 * problem (contract.md §7):
 *
 * - orphan descriptors/implementations and descriptor drift
 *   (`registry.assertPaired`);
 * - a routed descriptor that is not the registered object (drift between
 *   the exposure record and the boot registry);
 * - a registered `transport: "client"` action missing from the exposure
 *   record — silently unroutable actions are as much a bug as orphans.
 */
export function buildServerRouter(
  modules: ContractModuleMap,
  deps: ServerRouterDeps,
): ServerRouter {
  deps.registry.assertPaired();

  const problems = collectCompositionProblems(modules);
  const routedNames = new Set<string>();
  for (const actions of Object.values(modules)) {
    for (const contract of Object.values(actions)) {
      routedNames.add(contract.name);
      const registered = deps.registry.getContract(contract.name);
      if (registered === undefined) {
        problems.push(
          `routed action "${contract.name}" is not registered — the exposure record must reference the module's registered descriptors`,
        );
      } else if (registered !== contract) {
        problems.push(
          `routed action "${contract.name}" is a different descriptor object than the registered one — import the descriptor, do not redefine it`,
        );
      }
    }
  }
  for (const contract of deps.registry.contracts()) {
    if (contract.transport === "client" && !routedNames.has(contract.name)) {
      problems.push(
        `registered client action "${contract.name}" is missing from the contract exposure record — it would be silently unroutable`,
      );
    }
  }
  if (problems.length > 0) {
    throw new ContractCompositionError(problems);
  }

  const router: Record<string, Record<string, ServerProcedure>> = {};
  for (const [moduleName, actions] of Object.entries(modules)) {
    const procedures: Record<string, ServerProcedure> = {};
    for (const [verb, contract] of Object.entries(actions)) {
      const implementation = deps.registry.getImplementation(contract.name);
      if (implementation === undefined) {
        // Unreachable after assertPaired — kept for type narrowing.
        throw new ContractCompositionError([
          `action "${contract.name}" has no registered implementation`,
        ]);
      }
      // The registry erases callback generics so a stored implementation
      // cannot be invoked without pipeline validation (fnd-T9). The
      // pipeline is exactly what runs here, and every registry entry is an
      // `implementAction` output, so restoring the erased shape is sound.
      const action = implementation as ImplementedAction<
        z.ZodType,
        z.ZodType,
        unknown
      >;
      procedures[verb] = toServerProcedure(contract, action, deps.pipeline);
    }
    router[moduleName] = procedures;
  }
  return router;
}
