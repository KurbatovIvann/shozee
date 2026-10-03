import type { ActionCtx } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";
import { priceLists } from "@showzy/db/schema/pricing";
import { keepOmitted } from "@showzy/module-kit/keep-omitted";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";

import type { updatePriceListInputSchema } from "../actions/update-price-list.contract.js";
import { countPriceListEntries } from "./count-price-list-entries.js";
import {
  priceListViewColumns,
  requireLockedPriceList,
} from "./locked-price-list.js";
import { toPriceListView, type PriceListView } from "./price-list-view.js";
import { requireWritable } from "./writable.js";

type StaffCtx = Extract<ActionCtx, { principal: "staff" }>;
type UpdateInput = z.output<typeof updatePriceListInputSchema>;

export async function updateStaffPriceList(env: {
  readonly ctx: StaffCtx;
  readonly input: UpdateInput;
}): Promise<PriceListView> {
  const { ctx, input } = env;
  const db = requireWritable(ctx.db);

  const locked = await requireLockedPriceList(db, ctx.companyId, input.id);

  const updated = (
    await db
      .update(priceLists)
      .set({ name: keepOmitted(input.name, locked.name) })
      .where(
        and(
          eq(priceLists.companyId, ctx.companyId),
          eq(priceLists.id, input.id),
        ),
      )
      .returning(priceListViewColumns)
  )[0];
  if (updated === undefined) {
    throw new CoreInvariantError(
      "pricing.updatePriceList update returned no row",
    );
  }

  ctx.log.info(
    { price_list_id: updated.id },
    "pricing.updatePriceList updated price list",
  );

  return toPriceListView(
    updated,
    await countPriceListEntries(ctx.db, ctx.companyId, updated.id),
  );
}
