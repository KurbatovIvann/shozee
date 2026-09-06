import { randomUUID } from "node:crypto";

import type { ActionCtx } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";
import { priceLists } from "@showzy/db/schema/pricing";
import type { z } from "zod";

import type { createPriceListInputSchema } from "../actions/create-price-list.contract.js";
import {
  mapDefaultPriceListUniqueViolation,
  unsetCompanyDefaultLists,
} from "./default-swap.js";
import { priceListViewColumns } from "./locked-price-list.js";
import { toPriceListView, type PriceListView } from "./price-list-view.js";
import { requireWritable } from "./writable.js";

type StaffCtx = Extract<ActionCtx, { principal: "staff" }>;
type CreateInput = z.output<typeof createPriceListInputSchema>;

export async function createStaffPriceList(env: {
  readonly ctx: StaffCtx;
  readonly input: CreateInput;
}): Promise<PriceListView> {
  const { ctx, input } = env;
  const db = requireWritable(ctx.db);
  const isDefault = input.isDefault;
  const isActive = isDefault ? true : input.isActive;

  try {
    if (isDefault) {
      await unsetCompanyDefaultLists(db, ctx.companyId);
    }

    const inserted = (
      await db
        .insert(priceLists)
        .values({
          id: randomUUID(),
          companyId: ctx.companyId,
          name: input.name,
          isDefault,
          isActive,
          createdVia: ctx.channel,
        })
        .returning(priceListViewColumns)
    )[0];
    if (inserted === undefined) {
      throw new CoreInvariantError(
        "pricing.createPriceList insert returned no row",
      );
    }

    ctx.log.info(
      { price_list_id: inserted.id },
      "pricing.createPriceList created price list",
    );

    return toPriceListView(inserted, 0);
  } catch (error) {
    throw mapDefaultPriceListUniqueViolation(error);
  }
}
