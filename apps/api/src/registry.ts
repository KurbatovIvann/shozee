/**
 * The action registry, and nothing else (SHO-569).
 *
 * `boot.ts` mounts it, `buildContractCheckInput` checks it, and the worker runs
 * assistant turns against it through the approved `@showzy/api/registry`
 * subpath — so all three hold exactly one set of actions. Module tasks register
 * their action barrels here.
 *
 * Its imports are `@showzy/core` and module barrels only, with no relative
 * import (`registry.test.ts`): whoever imports this subpath must not also get
 * the API's HTTP, auth, stores, config or provider.
 */
import { assistantActions } from "@showzy/assistant";
import { catalogActions } from "@showzy/catalog";
import { chatActions } from "@showzy/chat";
import { companiesActions } from "@showzy/companies";
import { ActionRegistry, type ImplementedAction } from "@showzy/core";
import { customersActions } from "@showzy/customers";
import { docGenerationActions } from "@showzy/doc-generation";
import { docSigningActions } from "@showzy/doc-signing";
import { documentsActions } from "@showzy/documents";
import { filesActions } from "@showzy/files";
import { invitesActions } from "@showzy/invites";
import { ordersActions } from "@showzy/orders";
import { pricingActions } from "@showzy/pricing";
import { searchActions } from "@showzy/search";
import type { z } from "zod";

function registerActions<TTarget>(
  registry: ActionRegistry,
  actions: readonly ImplementedAction<z.ZodType, z.ZodType, TTarget>[],
): void {
  for (const action of actions) {
    registry.registerContract(action.contract);
    registry.registerImplementation(action);
  }
}

/** The boot registry — the same builder the contract-check stage walks. */
export function createActionRegistry(): ActionRegistry {
  const registry = new ActionRegistry();
  registerActions(registry, assistantActions);
  registerActions(registry, catalogActions);
  registerActions(registry, chatActions);
  registerActions(registry, companiesActions);
  registerActions(registry, customersActions);
  registerActions(registry, filesActions);
  registerActions(registry, invitesActions);
  registerActions(registry, documentsActions);
  registerActions(registry, docGenerationActions);
  registerActions(registry, docSigningActions);
  registerActions(registry, ordersActions);
  registerActions(registry, pricingActions);
  registerActions(registry, searchActions);
  return registry;
}
