import { randomUUID } from "node:crypto";

import type { ActionCtx } from "@showzy/core";
import {
  ConflictError,
  CoreInvariantError,
  NotFoundError,
} from "@showzy/core/errors";
import { counterparties } from "@showzy/db/schema/customers";
import { postgresError } from "@showzy/module-kit/postgres-unique";
import type { z } from "zod";

import type {
  createCounterpartyInputSchema,
  createCounterpartyOutputSchema,
} from "../actions/create-counterparty.contract.js";
import {
  counterpartyReturning,
  requireOwnCustomer,
  storedCounterpartyFields,
  toCounterpartyView,
} from "./counterparty-view.js";
import { requireWritable } from "./writable.js";

type StaffCtx = Extract<ActionCtx, { principal: "staff" }>;
type CreateInput = z.output<typeof createCounterpartyInputSchema>;
type CounterpartyView = z.output<typeof createCounterpartyOutputSchema>;

export const COUNTERPARTIES_COMPANY_EDRPOU_UQ =
  "counterparties_company_edrpou_uq";

export const EDRPOU_CONFLICT_MESSAGE =
  "A counterparty with this EDRPOU already exists.";

export async function createStaffCounterparty(env: {
  readonly ctx: StaffCtx;
  readonly input: CreateInput;
}): Promise<CounterpartyView> {
  const { ctx, input } = env;
  const db = requireWritable(ctx.db);
  const fields = storedCounterpartyFields(input);

  const linkedCustomer =
    fields.customerId === null
      ? null
      : await requireOwnCustomer(db, ctx.companyId, fields.customerId);

  try {
    const inserted = (
      await db
        .insert(counterparties)
        .values({
          id: randomUUID(),
          companyId: ctx.companyId,
          createdVia: ctx.channel,
          ...fields,
        })
        .returning(counterpartyReturning)
    )[0];
    if (inserted === undefined) {
      throw new CoreInvariantError(
        "customers.createCounterparty insert returned no row",
      );
    }

    ctx.log.info(
      { counterparty_id: inserted.id },
      "customers.createCounterparty created counterparty",
    );
    return toCounterpartyView(inserted, linkedCustomer?.name ?? null);
  } catch (error) {
    throw mapCounterpartyWriteError(error);
  }
}

export function mapCounterpartyWriteError(error: unknown): unknown {
  const pg = postgresError(error);
  if (
    pg?.code === "23505" &&
    pg.constraint === COUNTERPARTIES_COMPANY_EDRPOU_UQ
  ) {
    return new ConflictError(EDRPOU_CONFLICT_MESSAGE, {
      internalMessage: `${COUNTERPARTIES_COMPANY_EDRPOU_UQ} unique violation`,
      cause: error,
    });
  }
  if (pg?.code === "23503") {
    return new NotFoundError("The requested resource was not found.", {
      internalMessage: `customers counterparty write hit FK ${pg.constraint ?? "unknown"}`,
      cause: error,
    });
  }
  return error;
}
