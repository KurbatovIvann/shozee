import { implementAction } from "@showzy/core";
import { createInviteContract } from "./create.contract.js";
import { inviteAuditTarget } from "../services/invite-audit-target.js";
import { createStaffInvite } from "../services/create-invite.js";
import {
  inviteExpiryLabel,
  inviteKindLabel,
  inviteUsesLabel,
} from "../services/preview-invite.js";

export const createInvite = implementAction(createInviteContract, {
  handler: (input, ctx) => {
    return createStaffInvite({ ctx, input });
  },
  preview: (input) => ({
    title: "Створити запрошення для клієнта",
    lines: [
      { label: "Тип", value: inviteKindLabel(input.isReusable) },
      { label: "Ім'я", value: input.name ?? "—" },
      {
        label: "Використань",
        value: inviteUsesLabel(input.maxUses ?? (input.isReusable ? null : 1)),
      },
      { label: "Діє до", value: inviteExpiryLabel(input.expiresAt) },
    ],
    notes: ["Посилання з таємним кодом буде показано один раз."],
  }),
  auditTarget: inviteAuditTarget,
});
