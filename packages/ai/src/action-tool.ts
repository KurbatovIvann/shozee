import { anthropic } from "@ai-sdk/anthropic";
import type { ActionContract } from "@showzy/core/contract";
import { CoreInvariantError } from "@showzy/core/errors";
import { ORDER_ENTITY_PROMPT_LINE } from "@showzy/validation/assistant-surfaces";
import { jsonSchema, tool, type Tool, type ToolSet } from "ai";
import { z } from "zod";

import {
  STAFF_ASSISTANT_CACHE_PROVIDER_OPTIONS,
  STAFF_ASSISTANT_DEFER_PROVIDER_OPTIONS,
} from "./anthropic-options.js";
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
 * Anthropic custom tool names (`@ai-sdk/anthropic` sends `tool.name`
 * unchanged) must match `^[a-zA-Z0-9_-]{1,128}$`. Action contracts keep
 * the dotted `module.verb` identity (`orders.list`); the ToolSet key is
 * the provider-safe mapping (`orders_list`). Mechanical adapter only —
 * not a new principal and not a `packages/core` patch.
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

/** ToolSet key for Anthropic BM25 tool search (provider-executed). */
export const STAFF_ASSISTANT_TOOL_SEARCH_NAME = "tool_search_tool_bm25";

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

/**
 * Anthropic requires `input_schema.type`. Zod 4 discriminated unions
 * emit `oneOf` without a top-level `type`. Named object façades already
 * have `type: "object"` — do not flatten `*.contract.ts` to appease this.
 */
export function ensureAnthropicToolInputSchemaType(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof schema["type"] === "string") {
    return schema;
  }
  return { ...schema, type: "object" };
}

function actionContractJsonSchema(contract: ActionContract) {
  const json = z.toJSONSchema(contract.input);
  return jsonSchema(ensureAnthropicToolInputSchemaType({ ...json }), {
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
 * `staffAssistantTools`. Union inputs get `ensureAnthropicToolInputSchemaType`.
 * Optional `description` keeps the 1:1 schema while teaching BM25/search
 * (pricing create/fill path) without flattening the contract.
 */
export function actionContractToTool(
  contract: ActionContract,
  execute: ActionToolExecute,
  options?: { readonly description?: string },
): Tool {
  return tool({
    description: options?.description ?? contract.description,
    inputSchema: actionContractJsonSchema(contract),
    execute: async (input: unknown, executeOptions) => {
      const parsed: unknown = contract.input.parse(input);
      return execute(contract.name, parsed, {
        toolCallId: executeOptions.toolCallId,
      });
    },
  });
}

/**
 * Build the AI SDK tool map keyed by the Anthropic-safe provider name.
 * Operational catalogs include BM25 tool search; hot actions stay in
 * context; every other exposed action is `deferLoading`. `execute` still
 * receives `contract.name` (`orders.list`). Empty catalogs attach nothing
 * (chitchat). The HTTP mount injects `executeAction`; this helper never
 * fetches `/rpc`. Façade actions (`orders.list`, `orders.create`,
 * `catalog.listProducts`, `pricing.listPriceLists`,
 * `customers.listCustomers`, `customers.listGroups`) are not raw 1:1
 * ToolSet keys — named tools map onto the same handlers. Hot façades stay
 * in context. Deferred façades (`customers.listGroups`) are advertised
 * with `deferLoading` so BM25 can find `customers_list_groups`;
 * `toProviderToolName("customers.listGroups")` is not advertised.
 * `orders_create` is both the façade key and
 * `toProviderToolName("orders.create")`; the advertised schema is the
 * named object, not the EntityRef union.
 */
/**
 * High-confidence job intents attach this one ToolSet key (no BM25, no
 * sibling façades). `toolChoice: "required"` among several tools is not
 * enough — the catalog must already be this singleton.
 */
export function pickStaffAssistantForcedTool(
  tools: ToolSet,
  toolName: string,
): ToolSet {
  const forced = tools[toolName];
  if (forced === undefined) {
    return {};
  }
  return { [toolName]: forced };
}

export function staffAssistantTools(
  contracts: readonly ActionContract[],
  execute: ActionToolExecute,
): ToolSet {
  const tools: ToolSet = {};
  if (contracts.length === 0) {
    return tools;
  }

  tools[STAFF_ASSISTANT_TOOL_SEARCH_NAME] =
    anthropic.tools.toolSearchBm25_20251119();

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
      insertFacadeTools(tools, contract, execute, facadeFactory);
      continue;
    }
    insertActionTool(tools, contract, execute);
  }

  for (const contract of contracts) {
    if (HOT_ACTION_NAME_SET.has(contract.name)) {
      continue;
    }
    const deferredFactory = DEFERRED_FACADE_FACTORIES[contract.name];
    if (deferredFactory !== undefined) {
      insertFacadeTools(
        tools,
        contract,
        execute,
        deferredFactory,
        STAFF_ASSISTANT_DEFER_PROVIDER_OPTIONS,
      );
      continue;
    }
    if (FACADE_ACTION_NAME_SET.has(contract.name)) {
      continue;
    }
    insertActionTool(
      tools,
      contract,
      execute,
      STAFF_ASSISTANT_DEFER_PROVIDER_OPTIONS,
    );
  }

  markLastNonDeferredToolCacheBreakpoint(tools);
  return tools;
}

function insertFacadeTools(
  tools: ToolSet,
  contract: ActionContract,
  execute: ActionToolExecute,
  factory: FacadeToolsFactory,
  providerOptions?: typeof STAFF_ASSISTANT_DEFER_PROVIDER_OPTIONS,
): void {
  const facades = factory(contract, execute);
  for (const [name, aiTool] of Object.entries(facades)) {
    if (tools[name] !== undefined) {
      throw new CoreInvariantError(
        `duplicate provider tool name "${name}" for "${contract.name}"`,
      );
    }
    tools[name] =
      providerOptions === undefined ? aiTool : { ...aiTool, providerOptions };
  }
}

function insertActionTool(
  tools: ToolSet,
  contract: ActionContract,
  execute: ActionToolExecute,
  providerOptions?: typeof STAFF_ASSISTANT_DEFER_PROVIDER_OPTIONS,
): void {
  const providerName = toProviderToolName(contract.name);
  if (tools[providerName] !== undefined) {
    throw new CoreInvariantError(
      `duplicate provider tool name "${providerName}" for "${contract.name}"`,
    );
  }
  const descriptionSuffix =
    PRICING_DEFERRED_TOOL_DESCRIPTION_SUFFIXES[contract.name] ??
    HOT_ACTION_DESCRIPTION_SUFFIXES[contract.name];
  const aiTool = actionContractToTool(
    contract,
    execute,
    descriptionSuffix === undefined
      ? undefined
      : { description: `${contract.description} ${descriptionSuffix}` },
  );
  tools[providerName] =
    providerOptions === undefined ? aiTool : { ...aiTool, providerOptions };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDeferredTool(tool: { readonly providerOptions?: unknown }): boolean {
  if (!isRecord(tool.providerOptions)) {
    return false;
  }
  const anthropicOptions = tool.providerOptions["anthropic"];
  return (
    isRecord(anthropicOptions) && anthropicOptions["deferLoading"] === true
  );
}

function markLastNonDeferredToolCacheBreakpoint(tools: ToolSet): void {
  const names = Object.keys(tools);
  for (let index = names.length - 1; index >= 0; index -= 1) {
    const lastName = names[index];
    if (lastName === undefined) {
      continue;
    }
    const lastTool = tools[lastName];
    if (lastTool === undefined || isDeferredTool(lastTool)) {
      continue;
    }
    tools[lastName] = {
      ...lastTool,
      providerOptions: {
        ...lastTool.providerOptions,
        ...STAFF_ASSISTANT_CACHE_PROVIDER_OPTIONS,
      },
    };
    return;
  }
}
