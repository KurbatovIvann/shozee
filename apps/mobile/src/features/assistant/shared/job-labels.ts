/**
 * Ukrainian (and English) job labels for live-turn tool part names.
 * Never return a wire name (`orders_list_page`).
 */
import type { AssistantCopy } from "../../../i18n/assistant";

export const ASSISTANT_JOB_NAMES = [
  "orders_list_page",
  "orders_list_counts",
  "orders_get",
  "orders_create",
  "catalog_list_products",
  "pricing_list_price_lists",
  "customers_listCustomers",
  "search_query",
] as const;

export type AssistantJobName = (typeof ASSISTANT_JOB_NAMES)[number];

const JOB_NAME_SET: ReadonlySet<string> = new Set(ASSISTANT_JOB_NAMES);

function isAssistantJobName(name: string): name is AssistantJobName {
  return JOB_NAME_SET.has(name);
}

/** `orders.get` and `orders_get` share a label; unknown names use fallback. */
export function assistantJobLabel(
  toolName: string,
  copy: AssistantCopy,
): string {
  const key = toolName.replaceAll(".", "_");
  if (isAssistantJobName(key)) {
    return copy.jobs[key];
  }
  return copy.jobs.fallback;
}
