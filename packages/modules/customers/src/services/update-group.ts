import type { ActionCtx } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";
import { customerGroups } from "@showzy/db/schema/customers";
import { keepOmitted } from "@showzy/module-kit/keep-omitted";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";

import type {
  updateGroupInputSchema,
  updateGroupOutputSchema,
} from "../actions/update-group.contract.js";
import { countActiveGroupMembers } from "./count-active-members.js";
import { storedDescription, toGroupView } from "./group-view.js";
import { resolveGroupPriceListId } from "./resolve-price-list.js";
import { lockTenantRow } from "./tenant-row.js";
import { requireWritable } from "./writable.js";

type StaffCtx = Extract<ActionCtx, { principal: "staff" }>;
type UpdateInput = z.output<typeof updateGroupInputSchema>;
type GroupView = z.output<typeof updateGroupOutputSchema>;

export async function updateStaffGroup(env: {
  readonly ctx: StaffCtx;
  readonly input: UpdateInput;
}): Promise<GroupView> {
  const { ctx, input } = env;
  const db = requireWritable(ctx.db);

  const current = await lockTenantRow(db, customerGroups, {
    companyId: ctx.companyId,
    id: input.id,
    columns: {
      description: customerGroups.description,
      priceListId: customerGroups.priceListId,
    },
  });

  await resolveGroupPriceListId(ctx, input.priceListId);

  const updated = (
    await db
      .update(customerGroups)
      .set({
        name: input.name,
        description: storedDescription(
          keepOmitted(input.description, current.description),
        ),
        priceListId: keepOmitted(input.priceListId, current.priceListId),
      })
      .where(
        and(
          eq(customerGroups.companyId, ctx.companyId),
          eq(customerGroups.id, input.id),
        ),
      )
      .returning({
        id: customerGroups.id,
        name: customerGroups.name,
        slug: customerGroups.slug,
        description: customerGroups.description,
        priceListId: customerGroups.priceListId,
        createdAt: customerGroups.createdAt,
        updatedAt: customerGroups.updatedAt,
      })
  )[0];
  if (updated === undefined) {
    throw new CoreInvariantError(
      "customers.updateGroup update returned no row",
    );
  }

  const memberCount = await countActiveGroupMembers(
    db,
    ctx.companyId,
    updated.id,
  );

  ctx.log.info({ group_id: updated.id }, "customers.updateGroup updated group");

  return toGroupView(updated, memberCount);
}
