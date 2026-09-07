import type { ActionContract } from "@showzy/core/contract";
import { CoreInvariantError } from "@showzy/core/errors";
import { ORDER_ENTITY_PROMPT_LINE } from "@showzy/validation/assistant-surfaces";
import { jsonSchema, tool, type Tool, type ToolSet } from "ai";

import { anthropicStaffProvider } from "./provider/anthropic.js";
import type { StaffProviderAdapter } from "./provider/types.js";
import {
  CATALOG_LIST_PRODUCTS_ACTION_NAME,
  CATALOG_LIST_PRODUCTS_TOOL_NAME,
  catalogListProductsFacadeTools,
} from "./tool-facades/catalog-list-products.js";
import {
  CUSTOMERS_LIST_CUSTOMERS_ACTION_NAME,
  CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME,
  customersListCustomersFacadeTools,
} from "./tool-facades/customers-list-customers.js";
import {
  CUSTOMERS_LIST_GROUPS_ACTION_NAME,
  CUSTOMERS_LIST_GROUPS_TOOL_NAME,
  customersListGroupsFacadeTools,
} from "./tool-facades/customers-list-groups.js";
import {
  ORDERS_CREATE_ACTION_NAME,
  ORDERS_CREATE_TOOL_NAME,
  ordersCreateFacadeTools,
} from "./tool-facades/orders-create.js";
import {
  ORDERS_LIST_ACTION_NAME,
  ORDERS_LIST_COUNTS_TOOL_NAME,
  ORDERS_LIST_PAGE_TOOL_NAME,
  ordersListFacadeTools,
} from "./tool-facades/orders-list.js";
import {
  PRICING_DEFERRED_TOOL_DESCRIPTION_SUFFIXES,
  PRICING_LIST_PRICE_LISTS_ACTION_NAME,
  PRICING_LIST_PRICE_LISTS_TOOL_NAME,
  pricingListPriceListsFacadeTools,
} from "./tool-facades/pricing-list-price-lists.js";

/**
 * Provider custom tool names must match `^[a-zA-Z0-9_-]{1,128}$`.
 * Action contracts keep the dotted `module.verb` identity (`orders.list`);
 * the ToolSet key is the provider-safe mapping (`orders_list`). Mechanical
 * adapter only — not a new principal and not a `packages/core` patch.
 */
export const PROVIDER_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

/** Always-in-context domain actions (no `deferLoading`). */
export const STAFF_ASSISTANT_HOT_ACTION_NAMES = [
  ORDERS_LIST_ACTION_NAME,
  "orders.get",
  ORDERS_CREATE_ACTION_NAME,
  CATALOG_LIST_PRODUCTS_ACTION_NAME,
  PRICING_LIST_PRICE_LISTS_ACTION_NAME,
  CUSTOMERS_LIST_CUSTOMERS_ACTION_NAME,
] as const;

const HOT_ACTION_DESCRIPTION_SUFFIXES: Readonly<Record<string, string>> = {
  "orders.get": ORDER_ENTITY_PROMPT_LINE,
};

const HOT_ACTION_NAME_SET = new Set<string>(STAFF_ASSISTANT_HOT_ACTION_NAMES);

export {
  ensureAnthropicToolInputSchemaType,
  STAFF_ASSISTANT_TOOL_SEARCH_NAME,
} from "./provider/anthropic.js";

export {
  CATALOG_LIST_PRODUCTS_ACTION_NAME,
  CATALOG_LIST_PRODUCTS_TOOL_NAME,
  CUSTOMERS_LIST_CUSTOMERS_ACTION_NAME,
  CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME,
  CUSTOMERS_LIST_GROUPS_ACTION_NAME,
  CUSTOMERS_LIST_GROUPS_TOOL_NAME,
  ORDERS_CREATE_ACTION_NAME,
  ORDERS_CREATE_TOOL_NAME,
  ORDERS_LIST_ACTION_NAME,
  ORDERS_LIST_COUNTS_TOOL_NAME,
  ORDERS_LIST_PAGE_TOOL_NAME,
  PRICING_LIST_PRICE_LISTS_ACTION_NAME,
  PRICING_LIST_PRICE_LISTS_TOOL_NAME,
};

/**
 * Injected tool body. Tests fake `executeAction`. The adapter never calls
 * `/rpc` and never logs prompts or API keys. `toolCallId` comes from the
 * AI SDK loop and is passed through to `executeAction` request meta.
 */
export type ActionToolExecute = (
  actionName: string,
  input: unknown,
  options: { readonly toolCallId: string },
) => Promise<unknown>;

type FacadeToolsFactory = (
  contract: ActionContract,
  execute: ActionToolExecute,
) => Record<string, Tool>;

const HOT_FACADE_FACTORIES: Readonly<Record<string, FacadeToolsFactory>> = {
  [ORDERS_LIST_ACTION_NAME]: ordersListFacadeTools,
  [ORDERS_CREATE_ACTION_NAME]: ordersCreateFacadeTools,
  [CATALOG_LIST_PRODUCTS_ACTION_NAME]: catalogListProductsFacadeTools,
  [PRICING_LIST_PRICE_LISTS_ACTION_NAME]: pricingListPriceListsFacadeTools,
  [CUSTOMERS_LIST_CUSTOMERS_ACTION_NAME]: customersListCustomersFacadeTools,
};

/**
 * Façades that stay out of the always-in-context set. Skipping these in
 * the deferred loop would hide the named tool from BM25 (SHO-382).
 */
const DEFERRED_FACADE_FACTORIES: Readonly<Record<string, FacadeToolsFactory>> =
  {
    [CUSTOMERS_LIST_GROUPS_ACTION_NAME]: customersListGroupsFacadeTools,
  };

const HOT_FACADE_TOOL_NAMES: Readonly<Record<string, readonly string[]>> = {
  [ORDERS_LIST_ACTION_NAME]: [
    ORDERS_LIST_PAGE_TOOL_NAME,
    ORDERS_LIST_COUNTS_TOOL_NAME,
  ],
  [ORDERS_CREATE_ACTION_NAME]: [ORDERS_CREATE_TOOL_NAME],
  [CATALOG_LIST_PRODUCTS_ACTION_NAME]: [CATALOG_LIST_PRODUCTS_TOOL_NAME],
  [PRICING_LIST_PRICE_LISTS_ACTION_NAME]: [PRICING_LIST_PRICE_LISTS_TOOL_NAME],
  [CUSTOMERS_LIST_CUSTOMERS_ACTION_NAME]: [CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME],
};

const FACADE_ACTION_NAME_SET = new Set<string>([
  ...Object.keys(HOT_FACADE_FACTORIES),
  ...Object.keys(DEFERRED_FACADE_FACTORIES),
]);

/**
 * Named façade ToolSet keys (hot + deferred). Contract-check (SHO-471)
 * treats these as valid surface `toolNames` alongside provider names of
 * AI-exposed actions. Derived from the factory maps — not a second set.
 */
export const STAFF_ASSISTANT_FACADE_TOOL_NAMES: readonly string[] =
  Object.freeze([
    ...Object.values(HOT_FACADE_TOOL_NAMES).flat(),
    CUSTOMERS_LIST_GROUPS_TOOL_NAME,
  ]);

/**
 * Map `orders.list` → `orders_list`. `defineActionContract` requires
 * exactly one dot and alphanumeric camelCase segments, so replacing `.`
 * with `_` is lossless. Façade ToolSet keys (`orders_list_page`) are
 * not produced by this helper — they are not advertised as `orders_list`.
 * `orders.create` is the exception: the façade keeps `orders_create`.
 */
export function toProviderToolName(actionName: string): string {
  const providerName = actionName.replaceAll(".", "_");
  if (!PROVIDER_TOOL_NAME_PATTERN.test(providerName)) {
    throw new CoreInvariantError(
      `action "${actionName}" does not map to an Anthropic-safe tool name`,
    );
  }
  return providerName;
}

/** Inverse of `toProviderToolName` (`orders_list` → `orders.list`). */
export function fromProviderToolName(providerName: string): string {
  return providerName.replace("_", ".");
}

/**
 * Advertised always-in-context ToolSet keys. Façade actions expand to
 * named tools; other hot actions stay 1:1 provider names.
 */
export function staffAssistantHotToolNames(): readonly string[] {
  return STAFF_ASSISTANT_HOT_ACTION_NAMES.flatMap(
    (actionName) =>
      HOT_FACADE_TOOL_NAMES[actionName] ?? [toProviderToolName(actionName)],
  );
}

function actionContractJsonSchema(
  contract: ActionContract,
  provider: StaffProviderAdapter,
) {
  return jsonSchema(provider.toolInputSchema(contract.input), {
    validate: (value: unknown) => {
      const result = contract.input.safeParse(value);
      if (result.success) {
        return { success: true as const, value: result.data };
      }
      return { success: false as const, error: result.error };
    },
  });
}

/**
 * Wrap one `ActionContract` as an AI SDK 7 `tool()`. The registry `name`
 * and `description` are the executeAction identity; Zod `input` is the
 * schema. `execute` is injected so this package does not own the action
 * pipeline. Provider-safe ToolSet keys are applied by
 * `staffAssistantTools`. Union inputs get `provider.toolInputSchema`.
 * Optional `description` keeps the 1:1 schema while teaching BM25/search
 * (pricing create/fill path) without flattening the contract.
 */
export function actionContractToTool(
  contract: ActionContract,
  execute: ActionToolExecute,
  options?: {
    readonly description?: string;
    readonly provider?: StaffProviderAdapter;
  },
): Tool {
  const provider = options?.provider ?? anthropicStaffProvider;
  return tool({
    description: options?.description ?? contract.description,
    inputSchema: actionContractJsonSchema(contract, provider),
    execute: async (input: unknown, executeOptions) => {
      const parsed: unknown = contract.input.parse(input);
      return execute(contract.name, parsed, {
        toolCallId: executeOptions.toolCallId,
      });
    },
  });
}

/**
 * Build the AI SDK tool map keyed by the provider-safe name. The adapter
 * adds search / defer / cache breakpoints. `execute` still receives
 * `contract.name` (`orders.list`). Empty catalogs attach nothing
 * (chitchat). The HTTP mount injects `executeAction`; this helper never
 * fetches `/rpc`. Façade actions (`orders.list`, `orders.create`,
 * `catalog.listProducts`, `pricing.listPriceLists`,
 * `customers.listCustomers`, `customers.listGroups`) are not raw 1:1
 * ToolSet keys — named tools map onto the same handlers. Hot façades stay
 * in context. Deferred façades (`customers.listGroups`) are advertised so
 * BM25 can find `customers_list_groups`;
 * `toProviderToolName("customers.listGroups")` is not advertised.
 * `orders_create` is both the façade key and
 * `toProviderToolName("orders.create")`; the advertised schema is the
 * named object, not the EntityRef union.
 */
export function staffAssistantTools(
  contracts: readonly ActionContract[],
  execute: ActionToolExecute,
  provider: StaffProviderAdapter = anthropicStaffProvider,
): ToolSet {
  const tools: ToolSet = {};
  if (contracts.length === 0) {
    return tools;
  }

  const hot: string[] = [];
  const deferred: string[] = [];
  const byName = new Map<string, ActionContract>();
  for (const contract of contracts) {
    byName.set(contract.name, contract);
  }

  for (const hotName of STAFF_ASSISTANT_HOT_ACTION_NAMES) {
    const contract = byName.get(hotName);
    if (contract === undefined) {
      continue;
    }
    const facadeFactory = HOT_FACADE_FACTORIES[hotName];
    if (facadeFactory !== undefined) {
      hot.push(...insertFacadeTools(tools, contract, execute, facadeFactory));
      continue;
    }
    hot.push(insertActionTool(tools, contract, execute, provider));
  }

  for (const contract of contracts) {
    if (HOT_ACTION_NAME_SET.has(contract.name)) {
      continue;
    }
    const deferredFactory = DEFERRED_FACADE_FACTORIES[contract.name];
    if (deferredFactory !== undefined) {
      deferred.push(
        ...insertFacadeTools(tools, contract, execute, deferredFactory),
      );
      continue;
    }
    if (FACADE_ACTION_NAME_SET.has(contract.name)) {
      continue;
    }
    deferred.push(insertActionTool(tools, contract, execute, provider));
  }

  return provider.decorateToolSet(tools, { hot, deferred });
}

function insertFacadeTools(
  tools: ToolSet,
  contract: ActionContract,
  execute: ActionToolExecute,
  factory: FacadeToolsFactory,
): string[] {
  const names: string[] = [];
  const facades = factory(contract, execute);
  for (const [name, aiTool] of Object.entries(facades)) {
    if (tools[name] !== undefined) {
      throw new CoreInvariantError(
        `duplicate provider tool name "${name}" for "${contract.name}"`,
      );
    }
    tools[name] = aiTool;
    names.push(name);
  }
  return names;
}

function insertActionTool(
  tools: ToolSet,
  contract: ActionContract,
  execute: ActionToolExecute,
  provider: StaffProviderAdapter,
): string {
  const providerName = toProviderToolName(contract.name);
  if (tools[providerName] !== undefined) {
    throw new CoreInvariantError(
      `duplicate provider tool name "${providerName}" for "${contract.name}"`,
    );
  }
  const descriptionSuffix =
    PRICING_DEFERRED_TOOL_DESCRIPTION_SUFFIXES[contract.name] ??
    HOT_ACTION_DESCRIPTION_SUFFIXES[contract.name];
  tools[providerName] = actionContractToTool(
    contract,
    execute,
    descriptionSuffix === undefined
      ? { provider }
      : {
          description: `${contract.description} ${descriptionSuffix}`,
          provider,
        },
  );
  return providerName;
}
