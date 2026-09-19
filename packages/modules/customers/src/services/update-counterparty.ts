import type { ActionCtx } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";
import { counterparties } from "@showzy/db/schema/customers";
import { keepOmitted } from "@showzy/module-kit/keep-omitted";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";

import type {
  updateCounterpartyInputSchema,
  updateCounterpartyOutputSchema,
} from "../actions/update-counterparty.contract.js";
import { mapCounterpartyWriteError } from "./create-counterparty.js";
import {
  counterpartyReturning,
  requireOwnCustomer,
  storedCounterpartyFields,
  toCounterpartyView,
} from "./counterparty-view.js";
import { lockTenantRow } from "./tenant-row.js";
import { requireWritable } from "./writable.js";

type StaffCtx = Extract<ActionCtx, { principal: "staff" }>;
type UpdateInput = z.output<typeof updateCounterpartyInputSchema>;
type CounterpartyView = z.output<typeof updateCounterpartyOutputSchema>;

export async function updateStaffCounterparty(env: {
  readonly ctx: StaffCtx;
  readonly input: UpdateInput;
}): Promise<CounterpartyView> {
  const { ctx, input } = env;
  const db = requireWritable(ctx.db);

  const current = await lockTenantRow(db, counterparties, {
    companyId: ctx.companyId,
    id: input.id,
    columns: {
      edrpou: counterparties.edrpou,
      legalAddress: counterparties.legalAddress,
      iban: counterparties.iban,
      bankName: counterparties.bankName,
      bankMfo: counterparties.bankMfo,
      phone: counterparties.phone,
      email: counterparties.email,
      notes: counterparties.notes,
      customerId: counterparties.customerId,
    },
  });
  const fields = storedCounterpartyFields({
    name: input.name,
    edrpou: keepOmitted(input.edrpou, current.edrpou),
    legalAddress: keepOmitted(input.legalAddress, current.legalAddress),
    iban: keepOmitted(input.iban, current.iban),
    bankName: keepOmitted(input.bankName, current.bankName),
    bankMfo: keepOmitted(input.bankMfo, current.bankMfo),
    phone: keepOmitted(input.phone, current.phone),
    email: keepOmitted(input.email, current.email),
    notes: keepOmitted(input.notes, current.notes),
    customerId: keepOmitted(input.customerId, current.customerId),
  });

  const linkedCustomer =
    fields.customerId === null
      ? null
      : await requireOwnCustomer(db, ctx.companyId, fields.customerId);

  try {
    const updated = (
      await db
        .update(counterparties)
        .set(fields)
        .where(
          and(
            eq(counterparties.companyId, ctx.companyId),
            eq(counterparties.id, input.id),
          ),
        )
        .returning(counterpartyReturning)
    )[0];
    if (updated === undefined) {
      throw new CoreInvariantError(
        "customers.updateCounterparty update returned no row",
      );
    }

    ctx.log.info(
      { counterparty_id: updated.id },
      "customers.updateCounterparty updated counterparty",
    );
    return toCounterpartyView(updated, linkedCustomer?.name ?? null);
  } catch (error) {
    throw mapCounterpartyWriteError(error);
  }
}
