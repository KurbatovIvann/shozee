import { getCompany } from "@showzy/companies";
import { implementAction } from "@showzy/core";
import { createAuditTarget, pickString } from "@showzy/module-kit/audit-target";
import { z } from "zod";

import { createStaffOrder } from "../services/create-order.js";
import { resolveCreateOrderDraft } from "../services/create-draft.js";
import { createOrderPreview } from "../services/preview-card.js";
import { createOrderContract } from "./create.contract.js";

const createOrderAuditTarget = createAuditTarget({
  type: "order",
  fallback: "uncreated",
  steps: [
    {
      source: "output",
      schema: z.object({ orderId: z.string() }),
      pick: (data) => pickString("orderId", data),
    },
  ],
});

export const createOrder = implementAction(createOrderContract, {
  handler: async (input, ctx) => {
    const draft = await resolveCreateOrderDraft(ctx.call, input);
    const company = await ctx.call(getCompany, {});

    return createStaffOrder({
      ctx,
      customerId: draft.customerId,
      customerNameSnapshot: draft.customerNameSnapshot,
      items: draft.items,
      comment: input.comment,
      numberingPrefix: company.prefix,
      prices: draft.prices,
    });
  },
  preview: createOrderPreview,
  auditTarget: createOrderAuditTarget,
});
