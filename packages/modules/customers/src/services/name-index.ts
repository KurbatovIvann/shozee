import type { ActionCtx } from "@showzy/core";
import { companyCustomers, customerGroups } from "@showzy/db/schema/customers";
import { and, asc, eq } from "drizzle-orm";

type StaffDb = Extract<ActionCtx, { principal: "staff" }>["db"];

export type CustomersNameIndexCaps = {
  readonly customers: number;
  readonly groups: number;
};

export async function readCustomersNameIndex(args: {
  readonly db: StaffDb;
  readonly companyId: string;
  readonly caps: CustomersNameIndexCaps;
}) {
  const customerRows = await args.db
    .select({ id: companyCustomers.id, name: companyCustomers.name })
    .from(companyCustomers)
    .where(
      and(
        eq(companyCustomers.companyId, args.companyId),
        eq(companyCustomers.status, "active"),
      ),
    )
    .orderBy(asc(companyCustomers.id))
    .limit(args.caps.customers + 1);

  const groupRows = await args.db
    .select({ id: customerGroups.id, name: customerGroups.name })
    .from(customerGroups)
    .where(eq(customerGroups.companyId, args.companyId))
    .orderBy(asc(customerGroups.id))
    .limit(args.caps.groups + 1);

  return {
    customers: {
      items: customerRows.slice(0, args.caps.customers),
      truncated: customerRows.length > args.caps.customers,
    },
    groups: {
      items: groupRows.slice(0, args.caps.groups),
      truncated: groupRows.length > args.caps.groups,
    },
  };
}
