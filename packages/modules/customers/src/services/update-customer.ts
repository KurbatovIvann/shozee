import type { ActionCtx } from "@showzy/core";
import { CoreInvariantError, ValidationError } from "@showzy/core/errors";
import { companyCustomers } from "@showzy/db/schema/customers";
import { keepOmitted } from "@showzy/module-kit/keep-omitted";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";

import {
  CONTACT_REQUIRED_MESSAGE,
  hasCustomerContact,
} from "../actions/customer-view.contract.js";
import type {
  updateCustomerInputSchema,
  updateCustomerOutputSchema,
} from "../actions/update-customer.contract.js";
import { assertCustomerAssignments } from "./assignments.js";
import { countLinkedCounterparties } from "./count-linked-counterparties.js";
import { mapCustomerWriteError } from "./create-customer.js";
import {
  customerColumns,
  nullableText,
  toCustomerView,
} from "./customer-view.js";
import { lockTenantRow } from "./tenant-row.js";
import { requireWritable } from "./writable.js";

type StaffCtx = Extract<ActionCtx, { principal: "staff" }>;
type UpdateInput = z.output<typeof updateCustomerInputSchema>;
type CustomerView = z.output<typeof updateCustomerOutputSchema>;

function requireContact(merged: {
  readonly phone: string | null;
  readonly email: string | null;
  readonly userId: string | null;
}): void {
  if (hasCustomerContact(merged)) {
    return;
  }
  const issue: z.core.$ZodIssue = {
    code: "custom",
    path: [],
    message: CONTACT_REQUIRED_MESSAGE,
    input: merged,
  };
  throw new ValidationError([issue], CONTACT_REQUIRED_MESSAGE);
}

export async function updateStaffCustomer(env: {
  readonly ctx: StaffCtx;
  readonly input: UpdateInput;
}): Promise<CustomerView> {
  const { ctx, input } = env;
  const db = requireWritable(ctx.db);

  const current = await lockTenantRow(db, companyCustomers, {
    companyId: ctx.companyId,
    id: input.id,
    columns: {
      phone: companyCustomers.phone,
      email: companyCustomers.email,
      userId: companyCustomers.userId,
      notes: companyCustomers.notes,
      groupId: companyCustomers.groupId,
      priceListId: companyCustomers.priceListId,
    },
  });
  const merged = {
    phone: nullableText(keepOmitted(input.phone, current.phone)),
    email: nullableText(keepOmitted(input.email, current.email)),
    userId: nullableText(keepOmitted(input.userId, current.userId)),
    notes: nullableText(keepOmitted(input.notes, current.notes)),
    groupId: keepOmitted(input.groupId, current.groupId),
    priceListId: keepOmitted(input.priceListId, current.priceListId),
  };
  requireContact(merged);

  await assertCustomerAssignments({
    ctx,
    groupId: input.groupId ?? null,
    priceListId: input.priceListId ?? null,
  });

  try {
    const updated = (
      await db
        .update(companyCustomers)
        .set({ name: input.name, ...merged })
        .where(
          and(
            eq(companyCustomers.companyId, ctx.companyId),
            eq(companyCustomers.id, input.id),
          ),
        )
        .returning(customerColumns)
    )[0];
    if (updated === undefined) {
      throw new CoreInvariantError(
        "customers.updateCustomer update returned no row",
      );
    }

    const linked = await countLinkedCounterparties(
      db,
      ctx.companyId,
      updated.id,
    );

    ctx.log.info(
      { customer_id: updated.id },
      "customers.updateCustomer updated customer",
    );
    return toCustomerView(updated, linked);
  } catch (error) {
    throw mapCustomerWriteError(error, input.userId);
  }
}
