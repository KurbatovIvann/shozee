/**
 * Named staff-assistant tool over `customers.listGroups` (SHO-382 /
 * ADR-0033). Deferred copy of T1 `customers_list_customers`. Do not copy
 * kinds. Do not copy repo-wide in this PR. Do not hot-load this tool.
 *
 * Presentation adapter only: `execute("customers.listGroups", canonical)`.
 * Do not add `customers.listGroupsForAssistant`. Do not flatten
 * `list-groups.contract.ts`. Do not rebuild the public list as `kind`.
 * Groups are not archived — do not invent a status filter.
 */
import type { ActionContract } from "@showzy/core/contract";
import {
  LIST_GROUPS_CURSOR_MAX,
  LIST_GROUPS_SEARCH_MAX,
} from "@showzy/customers/contract";
import { tool, type Tool } from "ai";
import { z } from "zod";

import type { ActionToolExecute } from "../action-tool.js";

export const CUSTOMERS_LIST_GROUPS_ACTION_NAME = "customers.listGroups";
export const CUSTOMERS_LIST_GROUPS_TOOL_NAME = "customers_list_groups";

export const CUSTOMERS_LIST_GROUPS_SEARCH_MAX = LIST_GROUPS_SEARCH_MAX;
export const CUSTOMERS_LIST_GROUPS_CURSOR_MAX = LIST_GROUPS_CURSOR_MAX;

/**
 * Compact 20-row pages (full `GroupView`, including description max 2000)
 * clip. A max-length compact page (name 120, 9-digit memberCount, uuid
 * priceListId) plus a 200-char cursor is 3769 bytes at 14 rows and 4022
 * at 15. 14 is the largest named limit under `STAFF_ASSISTANT_CLIP_JSON_MAX`
 * so handler `nextCursor` matches visible rows. Named in SHO-382.
 */
export const CUSTOMERS_LIST_GROUPS_ASSISTANT_LIMIT = 14;

export const customersListGroupsInputSchema = z.strictObject({
  search: z
    .string()
    .trim()
    .min(1)
    .max(CUSTOMERS_LIST_GROUPS_SEARCH_MAX)
    .optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(CUSTOMERS_LIST_GROUPS_ASSISTANT_LIMIT)
    .default(CUSTOMERS_LIST_GROUPS_ASSISTANT_LIMIT),
  cursor: z.string().min(1).max(CUSTOMERS_LIST_GROUPS_CURSOR_MAX).optional(),
});

export type CustomersListGroupsFacadeInput = z.output<
  typeof customersListGroupsInputSchema
>;

const CUSTOMERS_LIST_GROUPS_DESCRIPTION = `List customer groups in the active company. Show all customer groups, or find a customer group by name. Compact page: id, name, memberCount, priceListId, and nextCursor. Optional case-insensitive name search. Optional cursor pages forward. Page size defaults to ${String(CUSTOMERS_LIST_GROUPS_ASSISTANT_LIMIT)} (cap ${String(CUSTOMERS_LIST_GROUPS_ASSISTANT_LIMIT)}) so every visible row matches nextCursor. Groups are not archived. Does not return description, slug, or timestamps. Find a group by name with this tool.`;

export function mapCustomersListGroupsInput(
  input: CustomersListGroupsFacadeInput,
): {
  readonly search?: string;
  readonly limit: number;
  readonly cursor?: string;
} {
  return {
    ...(input.search !== undefined ? { search: input.search } : {}),
    limit: input.limit,
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapCustomersListGroupsCompactRow(row: unknown): unknown {
  if (!isRecord(row)) {
    return row;
  }
  return {
    id: row["id"],
    name: row["name"],
    memberCount: row["memberCount"],
    priceListId: row["priceListId"],
  };
}

/**
 * Assistant view of `customers.listGroups`. Drops `description`, `slug`,
 * `createdAt`, and `updatedAt` so clip cannot strip memberCount / price-list
 * from a fat page. Typed errors pass through unchanged.
 */
export function mapCustomersListGroupsOutput(output: unknown): unknown {
  if (!isRecord(output) || !Array.isArray(output["items"])) {
    return output;
  }
  const nextCursor = output["nextCursor"];
  return {
    items: output["items"].map((row) => mapCustomersListGroupsCompactRow(row)),
    nextCursor: nextCursor === undefined ? null : nextCursor,
  };
}

/**
 * One deferred ToolSet entry that still executes the `customers.listGroups`
 * registry name (audit, permissions, timeout unchanged). `staffAssistantTools`
 * attaches `deferLoading`; this factory does not.
 */
export function customersListGroupsFacadeTools(
  contract: ActionContract,
  execute: ActionToolExecute,
): Record<string, Tool> {
  return {
    [CUSTOMERS_LIST_GROUPS_TOOL_NAME]: tool({
      description: CUSTOMERS_LIST_GROUPS_DESCRIPTION,
      inputSchema: customersListGroupsInputSchema,
      execute: async (input, options) => {
        const parsed = customersListGroupsInputSchema.parse(input);
        const canonical = mapCustomersListGroupsInput(parsed);
        const raw = await execute(
          CUSTOMERS_LIST_GROUPS_ACTION_NAME,
          contract.input.parse(canonical),
          {
            toolCallId: options.toolCallId,
          },
        );
        return mapCustomersListGroupsOutput(raw);
      },
    }),
  };
}
