import { randomUUID } from "node:crypto";

import type { ActionCtx } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";
import { companies, companyLegalInfo } from "@showzy/db/schema/companies";
import { eq } from "drizzle-orm";
import type { z } from "zod";

import type {
  updateLegalInputSchema,
  updateLegalOutputSchema,
} from "../actions/update-legal.contract.js";
import {
  companyIdentityReturning,
  legalFactsReturning,
  legalReturning,
  mergeLegalFields,
  toCompanyView,
  type StoredLegalFacts,
} from "./company-view.js";
import { requireStaffWritable, type WritableStaffDb } from "./writable.js";

type StaffCtx = Extract<ActionCtx, { principal: "staff" }>;
type UpdateInput = z.output<typeof updateLegalInputSchema>;
type CompanyView = z.output<typeof updateLegalOutputSchema>;

async function lockLegalFacts(
  db: Pick<WritableStaffDb, "select">,
  companyId: string,
): Promise<StoredLegalFacts | undefined> {
  const locked = db
    .select(legalFactsReturning)
    .from(companyLegalInfo)
    .where(eq(companyLegalInfo.companyId, companyId))
    .limit(1) as { for: (strength: "update") => Promise<StoredLegalFacts[]> };
  return (await locked.for("update"))[0];
}

export async function updateStaffLegal(env: {
  readonly ctx: StaffCtx;
  readonly input: UpdateInput;
}): Promise<CompanyView> {
  const { ctx, input } = env;
  const db = requireStaffWritable(ctx.db);
  const fields = mergeLegalFields(
    input,
    await lockLegalFacts(db, ctx.companyId),
  );

  const upserted = (
    await db
      .insert(companyLegalInfo)
      .values({
        id: randomUUID(),
        companyId: ctx.companyId,
        ...fields,
      })
      .onConflictDoUpdate({
        target: companyLegalInfo.companyId,
        set: fields,
      })
      .returning(legalReturning)
  )[0];
  if (upserted === undefined) {
    throw new CoreInvariantError(
      "companies.updateLegal upsert returned no row",
    );
  }

  ctx.log.info(
    { company_id: ctx.companyId },
    "companies.updateLegal upserted legal info",
  );

  const company = (
    await db
      .select(companyIdentityReturning)
      .from(companies)
      .where(eq(companies.id, ctx.companyId))
      .limit(1)
  )[0];
  if (company === undefined) {
    throw new CoreInvariantError("companies expected the staff company row");
  }
  return toCompanyView(company, upserted);
}
