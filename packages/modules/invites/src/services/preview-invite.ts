import type { ActionPreviewEnv } from "@showzy/core";
import type { ActionPreviewLine } from "@showzy/core/errors";
import { NotFoundError } from "@showzy/core/errors";
import { companyCustomerInvites } from "@showzy/db/schema/invites";
import { and, eq } from "drizzle-orm";

type PreviewTx = ActionPreviewEnv["tx"];

import type {
  InviteDerivedStatus,
  InviteView,
} from "../actions/invite-view.contract.js";
import { inviteRowColumns, toInviteView } from "./invite-view.js";

const STATUS_LABELS = {
  pending: "Чинне",
  revoked: "Відкликане",
  expired: "Прострочене",
  exhausted: "Вичерпане",
} as const satisfies Record<InviteDerivedStatus, string>;

const kyivMoment = new Intl.DateTimeFormat("uk-UA", {
  timeZone: "Europe/Kyiv",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function inviteExpiryLabel(expiresAt: string): string {
  return kyivMoment.format(new Date(expiresAt));
}

export function inviteKindLabel(isReusable: boolean): string {
  return isReusable ? "Багаторазове" : "Персональне";
}

export function inviteStatusLabel(status: InviteDerivedStatus): string {
  return STATUS_LABELS[status];
}

export function inviteUsesLabel(maxUses: number | null): string {
  return maxUses === null ? "Без обмеження" : String(maxUses);
}

export async function loadInvitePreview(env: {
  readonly tx: PreviewTx;
  readonly companyId: string;
  readonly inviteId: string;
}): Promise<InviteView> {
  const rows = await env.tx
    .select(inviteRowColumns)
    .from(companyCustomerInvites)
    .where(
      and(
        eq(companyCustomerInvites.companyId, env.companyId),
        eq(companyCustomerInvites.id, env.inviteId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new NotFoundError();
  }
  return toInviteView(row);
}

export function invitePreviewLines(view: InviteView): ActionPreviewLine[] {
  return [
    { label: "Тип", value: inviteKindLabel(view.isReusable) },
    { label: "Статус", value: inviteStatusLabel(view.status) },
    {
      label: "Використань",
      value: `${String(view.usesCount)} / ${inviteUsesLabel(view.maxUses)}`,
    },
    { label: "Діє до", value: inviteExpiryLabel(view.expiresAt) },
  ];
}
