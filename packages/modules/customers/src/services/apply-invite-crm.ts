import { randomUUID } from "node:crypto";

import type { ActionCtx, TargetResolutionEnv } from "@showzy/core";
import {
  ConflictError,
  CoreInvariantError,
  NotFoundError,
} from "@showzy/core/errors";
import { companyCustomers, customerGroups } from "@showzy/db/schema/customers";
import { optionalNullableUuid } from "@showzy/module-kit/optional-nullable-uuid";
import { and, eq, isNull, or } from "drizzle-orm";
import type { z } from "zod";

import type {
  applyInviteCrmInputSchema,
  applyInviteCrmOutputSchema,
} from "../actions/apply-invite-crm.contract.js";
import { mapCustomerWriteError } from "./create-customer.js";
import {
  customerColumns,
  nullableText,
  type CustomerRow,
} from "./customer-view.js";
import { requireCustomerWritable } from "./writable.js";

type CustomerCtx = Extract<ActionCtx, { principal: "customer" }>;
type ApplyInput = z.output<typeof applyInviteCrmInputSchema>;
type ApplyOutput = z.output<typeof applyInviteCrmOutputSchema>;

export const INVITE_CRM_PLACEHOLDER_NAME = "Invited customer";

const UNLINKED_CONTACT_CONFLICT_MESSAGE =
  "Multiple unlinked customers match this invite.";

export async function applyInviteCrmRecord(env: {
  readonly ctx: CustomerCtx;
  readonly input: ApplyInput;
}): Promise<ApplyOutput> {
  const { ctx, input } = env;
  const db = requireCustomerWritable(ctx.db);
  const companyId = ctx.target.companyId;
  const userId = ctx.userId;
  const groupId = optionalNullableUuid(input.groupId);
  const priceListId = optionalNullableUuid(input.priceListId);
  const inviteName = nullableText(input.name);
  const invitePhone = nullableText(input.phone);
  const inviteEmail = nullableText(input.email);

  const linked = (
    await db
      .select(customerColumns)
      .from(companyCustomers)
      .where(
        and(
          eq(companyCustomers.companyId, companyId),
          eq(companyCustomers.userId, userId),
        ),
      )
      .limit(1)
      .for("update")
  )[0];

  if (linked !== undefined) {
    await enrichInviteCrmRow(db, {
      companyId,
      row: linked,
      userId,
      groupId,
      priceListId,
    });
    ctx.log.info(
      { customer_id: linked.id },
      "customers.applyInviteCrm enriched linked customer",
    );
    return { customerId: linked.id, created: false };
  }

  if (input.matchUnlinkedContact) {
    const unlinked = await findUnlinkedContactMatches(db, {
      companyId,
      phone: invitePhone,
      email: inviteEmail,
    });
    if (unlinked.length > 1) {
      throw new ConflictError(UNLINKED_CONTACT_CONFLICT_MESSAGE, {
        internalMessage: `${String(unlinked.length)} unlinked company_customers rows match invite phone/email in ${companyId}`,
      });
    }
    const match = unlinked[0];
    if (match !== undefined) {
      await enrichInviteCrmRow(db, {
        companyId,
        row: match,
        userId,
        groupId,
        priceListId,
      });
      ctx.log.info(
        { customer_id: match.id },
        "customers.applyInviteCrm linked unlinked customer",
      );
      return { customerId: match.id, created: false };
    }
  }

  const name = inviteName ?? INVITE_CRM_PLACEHOLDER_NAME;
  const customerId = randomUUID();
  try {
    const inserted = (
      await db
        .insert(companyCustomers)
        .values({
          id: customerId,
          companyId,
          name,
          phone: invitePhone,
          email: inviteEmail,
          userId,
          groupId,
          priceListId,
          createdVia: ctx.channel,
        })
        .returning({ id: companyCustomers.id })
    )[0];
    if (inserted === undefined) {
      throw new CoreInvariantError(
        "customers.applyInviteCrm insert returned no row",
      );
    }
    ctx.log.info(
      { customer_id: inserted.id },
      "customers.applyInviteCrm created customer",
    );
    return { customerId: inserted.id, created: true };
  } catch (error) {
    throw mapCustomerWriteError(error, userId);
  }
}

async function findUnlinkedContactMatches(
  db: ReturnType<typeof requireCustomerWritable>,
  args: {
    readonly companyId: string;
    readonly phone: string | null;
    readonly email: string | null;
  },
): Promise<CustomerRow[]> {
  const contactClause =
    args.phone !== null && args.email !== null
      ? or(
          eq(companyCustomers.phone, args.phone),
          eq(companyCustomers.email, args.email),
        )
      : args.phone !== null
        ? eq(companyCustomers.phone, args.phone)
        : args.email !== null
          ? eq(companyCustomers.email, args.email)
          : undefined;
  if (contactClause === undefined) {
    return [];
  }

  return db
    .select(customerColumns)
    .from(companyCustomers)
    .where(
      and(
        eq(companyCustomers.companyId, args.companyId),
        isNull(companyCustomers.userId),
        contactClause,
      ),
    )
    .limit(2)
    .for("update");
}

async function enrichInviteCrmRow(
  db: ReturnType<typeof requireCustomerWritable>,
  args: {
    readonly companyId: string;
    readonly row: CustomerRow;
    readonly userId: string;
    readonly groupId: string | null;
    readonly priceListId: string | null;
  },
): Promise<void> {
  const nextGroupId = args.row.groupId ?? args.groupId;
  const nextPriceListId = args.row.priceListId ?? args.priceListId;
  const nextUserId = args.row.userId ?? args.userId;
  const nextStatus =
    args.row.status === "archived" ? "active" : args.row.status;

  if (
    nextGroupId === args.row.groupId &&
    nextPriceListId === args.row.priceListId &&
    nextUserId === args.row.userId &&
    nextStatus === args.row.status
  ) {
    return;
  }

  try {
    const updated = (
      await db
        .update(companyCustomers)
        .set({
          groupId: nextGroupId,
          priceListId: nextPriceListId,
          userId: nextUserId,
          status: nextStatus,
        })
        .where(
          and(
            eq(companyCustomers.companyId, args.companyId),
            eq(companyCustomers.id, args.row.id),
          ),
        )
        .returning({ id: companyCustomers.id })
    )[0];
    if (updated === undefined) {
      throw new CoreInvariantError(
        "customers.applyInviteCrm enrich update returned no row",
      );
    }
  } catch (error) {
    throw mapCustomerWriteError(error, args.userId);
  }
}

export async function resolveApplyInviteCrmCompany(
  input: ApplyInput,
  env: Pick<TargetResolutionEnv, "tx" | "inheritedCompanyId">,
): Promise<{ companyId: string; resource: { companyId: string } }> {
  if (env.inheritedCompanyId !== undefined) {
    return {
      companyId: env.inheritedCompanyId,
      resource: { companyId: env.inheritedCompanyId },
    };
  }

  const groupId = optionalNullableUuid(input.groupId);
  if (groupId === null) {
    throw new NotFoundError();
  }

  const group = (
    await env.tx
      .select({
        id: customerGroups.id,
        companyId: customerGroups.companyId,
      })
      .from(customerGroups)
      .where(eq(customerGroups.id, groupId))
      .limit(1)
  )[0];
  if (group === undefined) {
    throw new NotFoundError();
  }
  return {
    companyId: group.companyId,
    resource: { companyId: group.companyId },
  };
}
