import type { ActionCtx } from "@showzy/core";
import { CoreInvariantError, ValidationError } from "@showzy/core/errors";
import { priceLists } from "@showzy/db/schema/pricing";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { countPriceListEntries } from "./count-price-list-entries.js";
import {
  priceListViewColumns,
  requireLockedPriceList,
} from "./locked-price-list.js";
import { toPriceListView, type PriceListView } from "./price-list-view.js";
import { requireWritable } from "./writable.js";

type StaffCtx = Extract<ActionCtx, { principal: "staff" }>;

export const DEFAULT_PRICE_LIST_DEACTIVATE_MESSAGE =
  "The default price list cannot be deactivated.";

const defaultListDeactivateGate = z.object({
  isDefault: z.literal(false, {
    error: DEFAULT_PRICE_LIST_DEACTIVATE_MESSAGE,
  }),
});

export function rejectDefaultDeactivate(isDefault: boolean): void {
  const parsed = defaultListDeactivateGate.safeParse({ isDefault });
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues,
      DEFAULT_PRICE_LIST_DEACTIVATE_MESSAGE,
    );
  }
}

export async function setStaffPriceListActive(env: {
  readonly ctx: StaffCtx;
  readonly id: string;
  readonly isActive: boolean;
}): Promise<PriceListView> {
  const { ctx, id, isActive } = env;
  const db = requireWritable(ctx.db);
  const existing = await requireLockedPriceList(db, ctx.companyId, id);

  if (!isActive) {
    rejectDefaultDeactivate(existing.isDefault);
  }

  if (existing.isActive === isActive) {
    return toPriceListView(
      existing,
      await countPriceListEntries(ctx.db, ctx.companyId, existing.id),
    );
  }

  const updated = (
    await db
      .update(priceLists)
      .set({ isActive })
      .where(
        and(eq(priceLists.companyId, ctx.companyId), eq(priceLists.id, id)),
      )
      .returning(priceListViewColumns)
  )[0];
  if (updated === undefined) {
    throw new CoreInvariantError(
      "pricing price-list status update returned no row",
    );
  }

  ctx.log.info(
    { price_list_id: updated.id, is_active: updated.isActive },
    isActive
      ? "pricing.activatePriceList activated price list"
      : "pricing.deactivatePriceList deactivated price list",
  );

  return toPriceListView(
    updated,
    await countPriceListEntries(ctx.db, ctx.companyId, updated.id),
  );
}
