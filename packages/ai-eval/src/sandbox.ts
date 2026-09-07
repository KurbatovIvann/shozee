import { randomUUID } from "node:crypto";

import type { ActionToolExecute } from "@showzy/ai";
import { catalogActions, createProduct } from "@showzy/catalog";
import { companiesActions, getCompany } from "@showzy/companies";
import {
  ActionRegistry,
  createConfirmationHook,
  createInMemoryConfirmationStore,
  executeAction,
  type ImplementedAction,
} from "@showzy/core";
import type { ActionContract } from "@showzy/core/contract";
import { createTestKit, type TestKit } from "@showzy/core/testing";
import {
  archiveCustomer,
  createCustomer,
  customersActions,
} from "@showzy/customers";
import { createOrder, ordersActions } from "@showzy/orders";
import { pricingActions } from "@showzy/pricing";
import type { z } from "zod";

import {
  T7_CAKE_PRODUCT_NAME,
  T7_MACARONS_LEMON_VARIANT,
  T7_MACARONS_PRODUCT_NAME,
  T7_MACARONS_VANILLA_VARIANT,
} from "./scenarios/gate-classifies.js";
import {
  HITL_ARCHIVED_CUSTOMER_NAME,
  HITL_ARCHIVED_CUSTOMER_PHONE,
} from "./scenarios/hitl.js";
import {
  PROOF_CUSTOMER_NAME,
  PROOF_CUSTOMER_PHONE,
  PROOF_PRODUCT_NAME,
  PROOF_PRODUCT_PRICE_MINOR,
} from "./scenarios/proof.js";

const EVAL_CLIENT_IP = "203.0.113.7";

export class EvalActionMissingError extends Error {
  readonly actionName: string;

  constructor(actionName: string) {
    super(`Eval sandbox has no implementation for "${actionName}".`);
    this.name = "EvalActionMissingError";
    this.actionName = actionName;
  }
}

function registerActions<TTarget>(
  registry: ActionRegistry,
  actions: readonly ImplementedAction<z.ZodType, z.ZodType, TTarget>[],
): void {
  for (const action of actions) {
    registry.registerContract(action.contract);
    registry.registerImplementation(action);
  }
}

/**
 * Registry lookup restored to the pipeline invocation shape — the same
 * single assertion as `apps/api` `requireImplementation` (fnd-T9 erasure;
 * `executeAction` re-validates input).
 */
function requireEvalImplementation(
  registry: ActionRegistry,
  actionName: string,
): ImplementedAction<z.ZodType, z.ZodType, unknown> {
  const implementation = registry.getImplementation(actionName);
  if (implementation === undefined) {
    throw new EvalActionMissingError(actionName);
  }
  return implementation as ImplementedAction<z.ZodType, z.ZodType, unknown>;
}

async function seedProofFixture(kit: TestKit): Promise<string> {
  await kit.invoke(createCustomer, {
    name: PROOF_CUSTOMER_NAME,
    phone: PROOF_CUSTOMER_PHONE,
  });
  const archived = await kit.invoke(createCustomer, {
    name: HITL_ARCHIVED_CUSTOMER_NAME,
    phone: HITL_ARCHIVED_CUSTOMER_PHONE,
  });
  await kit.invoke(archiveCustomer, { id: archived.id });
  await kit.invoke(createProduct, {
    name: PROOF_PRODUCT_NAME,
    basePriceMinor: PROOF_PRODUCT_PRICE_MINOR,
  });
  await kit.invoke(createProduct, {
    name: T7_CAKE_PRODUCT_NAME,
    basePriceMinor: "40000",
  });
  await kit.invoke(createProduct, {
    name: T7_MACARONS_PRODUCT_NAME,
    basePriceMinor: "15000",
    variants: [
      { name: T7_MACARONS_LEMON_VARIANT },
      { name: T7_MACARONS_VANILLA_VARIANT },
    ],
  });
  await kit.invoke(createOrder, {
    customer: { by: "query", value: PROOF_CUSTOMER_NAME },
    items: [
      {
        product: { by: "query", value: PROOF_PRODUCT_NAME },
        quantity: { decimal: "1" },
      },
    ],
  });
  const company = await kit.invoke(getCompany, {});
  return company.name.trim();
}

export interface EvalSandbox {
  readonly kit: TestKit;
  readonly contracts: readonly ActionContract[];
  readonly companyName: string;
  readonly execute: ActionToolExecute;
  close(): Promise<void>;
}

/**
 * Live-only. Unit tests must not import this module — it loads domain
 * barrels and the Postgres test kit.
 */
export async function createEvalSandbox(): Promise<EvalSandbox> {
  const kit = await createTestKit();
  const confirmationStore = createInMemoryConfirmationStore();
  const pipeline = {
    ...kit.pipeline,
    hooks: {
      ...kit.pipeline.hooks,
      confirmation: createConfirmationHook({ store: confirmationStore }),
    },
  };
  const registry = new ActionRegistry();
  registerActions(registry, catalogActions);
  registerActions(registry, companiesActions);
  registerActions(registry, customersActions);
  registerActions(registry, ordersActions);
  registerActions(registry, pricingActions);
  const contracts = registry.contracts();
  const companyName = await seedProofFixture(kit);

  const execute: ActionToolExecute = (actionName, input, toolOptions) => {
    const action = requireEvalImplementation(registry, actionName);
    const requestId = randomUUID();
    return executeAction(pipeline, {
      action,
      input,
      request: {
        requestId,
        correlationId: requestId,
        channel: "ai",
        clientIp: EVAL_CLIENT_IP,
        aiTraceId: requestId,
        toolCallId: toolOptions.toolCallId,
        ...(action.contract.idempotent && action.contract.risk !== "read"
          ? { idempotencyKey: randomUUID() }
          : {}),
      },
      principal: {
        mode: "staff",
        session: { userId: kit.identities.users.anna },
        companySelector: kit.identities.companies.a,
      },
    });
  };

  return {
    kit,
    contracts,
    companyName,
    execute,
    close: () => kit.db.close(),
  };
}
