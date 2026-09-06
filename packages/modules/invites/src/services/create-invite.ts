import { randomUUID } from "node:crypto";

import type { ActionCtx } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";
import { getGroup } from "@showzy/customers";
import { companyCustomerInvites } from "@showzy/db/schema/invites";
import { optionalNullableUuid } from "@showzy/module-kit/optional-nullable-uuid";
import { getPriceList } from "@showzy/pricing";
import type { z } from "zod";

import {
  createInviteInputSchema,
  createInviteOutputSchema,
  inviteCopyUrl,
} from "../actions/create.contract.js";
import { invitesCreated } from "../events/created.js";
import { nullableText, toInviteView } from "./invite-view.js";
import { mapInviteWriteError } from "./postgres-error.js";
import { generateInviteToken, hashInviteToken } from "./token-hash.js";
import { requireWritable } from "./writable.js";

type StaffCtx = Extract<ActionCtx, { principal: "staff" }>;
type CreateInput = z.output<typeof createInviteInputSchema>;
type CreateOutput = z.output<typeof createInviteOutputSchema>;

export async function createStaffInvite(env: {
  readonly ctx: StaffCtx;
  readonly input: CreateInput;
}): Promise<CreateOutput> {
  const { ctx, input } = env;
  const db = requireWritable(ctx.db);
  const groupId = optionalNullableUuid(input.groupId);
  const priceListId = optionalNullableUuid(input.priceListId);

  if (groupId !== null) {
    await ctx.call(getGroup, { id: groupId });
  }
  if (priceListId !== null) {
    await ctx.call(getPriceList, { id: priceListId });
  }

  const inviteId = randomUUID();
  const plaintextToken = generateInviteToken();
  const maxUses = input.isReusable ? (input.maxUses ?? null) : 1;

  try {
    const inserted = (
      await db
        .insert(companyCustomerInvites)
        .values({
          id: inviteId,
          companyId: ctx.companyId,
          invitedBy: ctx.userId,
          tokenHash: hashInviteToken(plaintextToken),
          isReusable: input.isReusable,
          maxUses,
          expiresAt: new Date(input.expiresAt),
          groupId,
          priceListId,
          name: nullableText(input.name),
          phone: nullableText(input.phone),
          email: nullableText(input.email),
          createdVia: ctx.channel,
        })
        .returning({
          id: companyCustomerInvites.id,
          isReusable: companyCustomerInvites.isReusable,
          maxUses: companyCustomerInvites.maxUses,
          usesCount: companyCustomerInvites.usesCount,
          expiresAt: companyCustomerInvites.expiresAt,
          status: companyCustomerInvites.status,
          groupId: companyCustomerInvites.groupId,
          priceListId: companyCustomerInvites.priceListId,
          name: companyCustomerInvites.name,
          phone: companyCustomerInvites.phone,
          email: companyCustomerInvites.email,
          invitedBy: companyCustomerInvites.invitedBy,
          createdAt: companyCustomerInvites.createdAt,
          updatedAt: companyCustomerInvites.updatedAt,
        })
    )[0];
    if (inserted === undefined) {
      throw new CoreInvariantError("invites.create insert returned no row");
    }

    ctx.emit(invitesCreated, {
      aggregate: { type: "invite", id: inserted.id },
      payload: {
        inviteId: inserted.id,
        isReusable: inserted.isReusable,
        expiresAt: inserted.expiresAt.toISOString(),
      },
    });

    ctx.log.info({ invite_id: inserted.id }, "invites.create created invite");

    return {
      ...toInviteView(inserted),
      token: plaintextToken,
      url: inviteCopyUrl(plaintextToken),
    };
  } catch (error) {
    throw mapInviteWriteError(error);
  }
}
