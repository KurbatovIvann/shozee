/**
 * Named staff-assistant tool over `customers.listCustomers` (SHO-381 /
 * ADR-0033). Copy of catalog T7 (SHO-357) plus named assistant `limit`
 * from SHO-360. Do not copy kinds. Do not copy repo-wide in this PR.
 *
 * Presentation adapter only: `execute("customers.listCustomers", canonical)`.
 * Do not add `customers.listCustomersForAssistant`. Do not flatten
 * `list-customers.contract.ts`. Do not rebuild the public list as `kind`.
 */
import type { ActionContract } from "@showzy/core/contract";
import {
  LIST_CUSTOMERS_CURSOR_MAX,
  LIST_CUSTOMERS_SEARCH_MAX,
} from "@showzy/customers/contract";
import { tool, type Tool } from "ai";
import { z } from "zod";

import type { ActionToolExecute } from "../action-tool.js";

export const CUSTOMERS_LIST_CUSTOMERS_ACTION_NAME = "customers.listCustomers";
export const CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME = "customers_list_customers";

export const CUSTOMERS_LIST_CUSTOMERS_SEARCH_MAX = LIST_CUSTOMERS_SEARCH_MAX;
export const CUSTOMERS_LIST_CUSTOMERS_CURSOR_MAX = LIST_CUSTOMERS_CURSOR_MAX;

/**
 * Compact 20-row pages (full `CustomerView`, including notes) clip
 * contacts. A max-length compact page (name 120, email 200, phone 30)
 * plus an 80-char cursor is 3957 bytes at 7 rows and 4507 at 8. 7 is
 * the largest named limit under `STAFF_ASSISTANT_CLIP_JSON_MAX` so
 * handler `nextCursor` matches visible rows. Named in SHO-381.
 */
export const CUSTOMERS_LIST_CUSTOMERS_ASSISTANT_LIMIT = 7;

const customersListCustomersStatusSchema = z.enum([
  "active",
  "archived",
  "all",
]);

export const customersListCustomersInputSchema = z.strictObject({
  status: customersListCustomersStatusSchema.default("active"),
  search: z
    .string()
    .trim()
    .min(1)
    .max(CUSTOMERS_LIST_CUSTOMERS_SEARCH_MAX)
    .optional(),
  groupId: z.uuid().optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(CUSTOMERS_LIST_CUSTOMERS_ASSISTANT_LIMIT)
    .default(CUSTOMERS_LIST_CUSTOMERS_ASSISTANT_LIMIT),
  cursor: z.string().min(1).max(CUSTOMERS_LIST_CUSTOMERS_CURSOR_MAX).optional(),
});

export type CustomersListCustomersFacadeInput = z.output<
  typeof customersListCustomersInputSchema
>;

export const CUSTOMERS_ASSIGN_PRICE_LIST_DESCRIPTION_SUFFIX =
  "Assign a price list to a group or customer with priceListId on this write. Resolve the list by name with pricing_list_price_lists first.";

export const CUSTOMERS_DEFERRED_TOOL_DESCRIPTION_SUFFIXES: Readonly<
  Record<string, string>
> = {
  "customers.createCustomer": CUSTOMERS_ASSIGN_PRICE_LIST_DESCRIPTION_SUFFIX,
  "customers.updateCustomer": CUSTOMERS_ASSIGN_PRICE_LIST_DESCRIPTION_SUFFIX,
  "customers.createGroup": CUSTOMERS_ASSIGN_PRICE_LIST_DESCRIPTION_SUFFIX,
  "customers.updateGroup": CUSTOMERS_ASSIGN_PRICE_LIST_DESCRIPTION_SUFFIX,
};

const CUSTOMERS_LIST_CUSTOMERS_DESCRIPTION = `Compact CRM customer page in the active company: id, name, phone, email, status, groupId, priceListId, and nextCursor. Default status is active; pass archived or all to include archived rows. Optional case-insensitive search on name, phone, or email. Put people and product names in nominative (Катя Самбука, Наполеон) — not the inflected form from the staff sentence (Каті Самбуки, наполеона). Pass only the name or query, not the whole utterance («замовлення для …»). One empty page is not "does not exist": retry with nominative and/or the last-name or product-name stem before telling the staff member nobody or nothing matches. Optional groupId UUID — a missing or foreign group yields an empty page. Optional cursor pages forward. Page size defaults to ${String(CUSTOMERS_LIST_CUSTOMERS_ASSISTANT_LIMIT)} (cap ${String(CUSTOMERS_LIST_CUSTOMERS_ASSISTANT_LIMIT)}) so every visible row matches nextCursor. Does not return notes, linked-account ids, counterparty counts, or timestamps. Find a customer by name, phone, or email with this tool. Do not call customers.getCustomer in a loop to recover notes. Create uses customers.createCustomer.`;

export function mapCustomersListCustomersInput(
  input: CustomersListCustomersFacadeInput,
): {
  readonly status: CustomersListCustomersFacadeInput["status"];
  readonly search?: string;
  readonly groupId?: string;
  readonly limit: number;
  readonly cursor?: string;
} {
  return {
    status: input.status,
    ...(input.search !== undefined ? { search: input.search } : {}),
    ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
    limit: input.limit,
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapCustomersListCustomersCompactRow(row: unknown): unknown {
  if (!isRecord(row)) {
    return row;
  }
  return {
    id: row["id"],
    name: row["name"],
    phone: row["phone"],
    email: row["email"],
    status: row["status"],
    groupId: row["groupId"],
    priceListId: row["priceListId"],
  };
}

/**
 * Assistant view of `customers.listCustomers`. Drops `notes`, `userId`,
 * `linkedCounterpartyCount`, `createdAt`, and `updatedAt` so clip cannot
 * strip contacts from a fat page. Typed errors pass through unchanged.
 */
export function mapCustomersListCustomersOutput(output: unknown): unknown {
  if (!isRecord(output) || !Array.isArray(output["items"])) {
    return output;
  }
  const nextCursor = output["nextCursor"];
  return {
    items: output["items"].map((row) =>
      mapCustomersListCustomersCompactRow(row),
    ),
    nextCursor: nextCursor === undefined ? null : nextCursor,
  };
}

/**
 * One hot ToolSet entry that still executes the `customers.listCustomers`
 * registry name (audit, permissions, timeout unchanged).
 */
export function customersListCustomersFacadeTools(
  contract: ActionContract,
  execute: ActionToolExecute,
): Record<string, Tool> {
  return {
    [CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME]: tool({
      description: CUSTOMERS_LIST_CUSTOMERS_DESCRIPTION,
      inputSchema: customersListCustomersInputSchema,
      execute: async (input, options) => {
        const parsed = customersListCustomersInputSchema.parse(input);
        const canonical = mapCustomersListCustomersInput(parsed);
        const raw = await execute(
          CUSTOMERS_LIST_CUSTOMERS_ACTION_NAME,
          contract.input.parse(canonical),
          {
            toolCallId: options.toolCallId,
          },
        );
        return mapCustomersListCustomersOutput(raw);
      },
    }),
  };
}
