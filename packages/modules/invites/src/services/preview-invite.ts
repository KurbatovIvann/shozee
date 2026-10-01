import type { ActionPreviewEnv } from "@showzy/core";
import type { ActionPreviewLine } from "@showzy/core/errors";
import { NotFoundError } from "@showzy/core/errors";
import { companyCustomerInvites } from "@showzy/db/schema/invites";
import { and, eq } from "drizzle-orm";

type PreviewTx = ActionPreviewEnv["tx"];

import type { InviteView } from "../actions/invite-view.contract.js";
import { inviteRowColumns, toInviteView } from "./invite-view.js";

const STATUS_LABELS = new Map<string, string>([
  ["pending", "Чинне"],
  ["revoked", "Відкликане"],
  ["expired", "Прострочене"],
  ["exhausted", "Вичерпане"],
]);

const kyivDay = new Intl.DateTimeFormat("uk-UA", {
  timeZone: "Europe/Kyiv",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

export function inviteExpiryLabel(expiresAt: string): string {
  return kyivDay.format(new Date(expiresAt));
}

export function inviteKindLabel(isReusable: boolean): string {
  return isReusable ? "Багаторазове" : "Персональне";
}

export function inviteStatusLabel(status: string): string {
  return STATUS_LABELS.get(status) ?? status;
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
