import { implementAction } from "@showzy/core";
import type { ActionPreviewLine } from "@showzy/core/errors";
import { getGroup } from "@showzy/customers";
import { optionalNullableUuid } from "@showzy/module-kit/optional-nullable-uuid";
import { PREVIEW_ABSENT } from "@showzy/module-kit/preview-changes";
import { getPriceList } from "@showzy/pricing";

import { createInviteContract } from "./create.contract.js";
import { inviteAuditTarget } from "../services/invite-audit-target.js";
import { createStaffInvite } from "../services/create-invite.js";
import { nullableText } from "../services/invite-view.js";
import {
  inviteExpiryLabel,
  inviteKindLabel,
  inviteUsesLabel,
} from "../services/preview-invite.js";

export const createInvite = implementAction(createInviteContract, {
  handler: (input, ctx) => {
    return createStaffInvite({ ctx, input });
  },
  preview: async (input, env) => {
    const lines: ActionPreviewLine[] = [
      { label: "Тип", value: inviteKindLabel(input.isReusable) },
      { label: "Ім'я", value: nullableText(input.name) ?? PREVIEW_ABSENT },
      {
        label: "Використань",
        value: inviteUsesLabel(input.maxUses ?? (input.isReusable ? null : 1)),
      },
      { label: "Діє до", value: inviteExpiryLabel(input.expiresAt) },
      { label: "Телефон", value: nullableText(input.phone) ?? PREVIEW_ABSENT },
      { label: "Email", value: nullableText(input.email) ?? PREVIEW_ABSENT },
    ];

    const groupId = optionalNullableUuid(input.groupId);
    const group =
      groupId === null ? null : await env.call(getGroup, { id: groupId });
    lines.push({ label: "Група", value: group?.name ?? PREVIEW_ABSENT });

    const priceListId = optionalNullableUuid(input.priceListId);
    const priceList =
      priceListId === null
        ? null
        : await env.call(getPriceList, { id: priceListId });
    lines.push({
      label: "Прайс-лист",
      value: priceList?.name ?? PREVIEW_ABSENT,
    });

    return {
      title: "Створити запрошення для клієнта",
      lines,
      notes: ["Посилання з таємним кодом буде показано один раз."],
    };
  },
  auditTarget: inviteAuditTarget,
});
