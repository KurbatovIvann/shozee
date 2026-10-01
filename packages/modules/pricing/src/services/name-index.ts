import type { ActionCtx } from "@showzy/core";
import { priceLists } from "@showzy/db/schema/pricing";
import { and, asc, eq } from "drizzle-orm";

type StaffDb = Extract<ActionCtx, { principal: "staff" }>["db"];

export async function readPricingNameIndex(args: {
  readonly db: StaffDb;
  readonly companyId: string;
  readonly cap: number;
}) {
  const rows = await args.db
    .select({ id: priceLists.id, name: priceLists.name })
    .from(priceLists)
    .where(
      and(
        eq(priceLists.companyId, args.companyId),
        eq(priceLists.isActive, true),
      ),
    )
    .orderBy(asc(priceLists.id))
    .limit(args.cap + 1);

  return {
    priceLists: {
      items: rows.slice(0, args.cap),
      truncated: rows.length > args.cap,
    },
  };
}
