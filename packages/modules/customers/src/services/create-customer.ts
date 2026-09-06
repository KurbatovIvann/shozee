import { randomUUID } from "node:crypto";

import type { ActionCtx } from "@showzy/core";
import {
  ConflictError,
  CoreInvariantError,
  NotFoundError,
} from "@showzy/core/errors";
import { companyCustomers } from "@showzy/db/schema/customers";
import { optionalNullableUuid } from "@showzy/module-kit/optional-nullable-uuid";
import { postgresError } from "@showzy/module-kit/postgres-unique";
import type { z } from "zod";

import type {
  createCustomerInputSchema,
  createCustomerOutputSchema,
} from "../actions/create-customer.contract.js";
import { assertCustomerAssignments } from "./assignments.js";
import {
  customerColumns,
  nullableText,
  toCustomerView,
} from "./customer-view.js";
import { requireWritable } from "./writable.js";

type StaffCtx = Extract<ActionCtx, { principal: "staff" }>;
type CreateInput = z.output<typeof createCustomerInputSchema>;
type CustomerView = z.output<typeof createCustomerOutputSchema>;

const LINKED_ACCOUNT_CONFLICT_MESSAGE =
  "This account is already linked to a customer.";

export async function createStaffCustomer(env: {
  readonly ctx: StaffCtx;
  readonly input: CreateInput;
}): Promise<CustomerView> {
  const { ctx, input } = env;
  const db = requireWritable(ctx.db);
  const groupId = optionalNullableUuid(input.groupId);
  const priceListId = optionalNullableUuid(input.priceListId);

  await assertCustomerAssignments({ ctx, groupId, priceListId });

  const customerId = randomUUID();
  try {
    const inserted = (
      await db
        .insert(companyCustomers)
        .values({
          id: customerId,
          companyId: ctx.companyId,
          name: input.name,
          phone: nullableText(input.phone),
          email: nullableText(input.email),
          userId: nullableText(input.userId),
          notes: nullableText(input.notes),
          groupId,
          priceListId,
          createdVia: ctx.channel,
        })
        .returning(customerColumns)
    )[0];
    if (inserted === undefined) {
      throw new CoreInvariantError(
        "customers.createCustomer insert returned no row",
      );
    }

    ctx.log.info(
      { customer_id: inserted.id },
      "customers.createCustomer created customer",
    );
    return toCustomerView(inserted, 0);
  } catch (error) {
    throw mapCustomerWriteError(error, input.userId);
  }
}

export function mapCustomerWriteError(
  error: unknown,
  userId: string | null | undefined,
): unknown {
  const pg = postgresError(error);
  if (
    pg?.code === "23505" &&
    pg.constraint === "company_customers_company_user_uq"
  ) {
    return new ConflictError(LINKED_ACCOUNT_CONFLICT_MESSAGE, {
      internalMessage:
        userId === undefined || userId === null
          ? "company_customers_company_user_uq fired without a userId"
          : `user_id "${userId}" is already linked in this company`,
      cause: error,
    });
  }
  if (pg?.code === "23503") {
    return new NotFoundError("The requested resource was not found.", {
      internalMessage: `customers write hit FK ${pg.constraint ?? "unknown"}`,
      cause: error,
    });
  }
  return error;
}
