import { implementAction } from "@showzy/core";
import { createAuditTarget, pickString } from "@showzy/module-kit/audit-target";
import { z } from "zod";

import { upsertTenantOrderCard } from "../services/upsert-order-card.js";
import { upsertOrderCardContract } from "./upsert-order-card.contract.js";

const envelopeOrderIdHolder = z.object({
  payload: z.object({ orderId: z.string() }),
});

const upsertAuditTarget = createAuditTarget({
  type: "order-card",
  fallback: "unknown",
  steps: [
    {
      source: "output",
      schema: z.object({ orderCardId: z.string() }),
      pick: (data) => pickString("orderCardId", data),
    },
    {
      source: "input",
      schema: envelopeOrderIdHolder,
      pick: (data) => {
        const parsed = envelopeOrderIdHolder.safeParse(data);
        return parsed.success ? parsed.data.payload.orderId : undefined;
      },
    },
  ],
});

export const upsertOrderCard = implementAction(upsertOrderCardContract, {
  handler: async (input, ctx) => {
    return upsertTenantOrderCard({
      ctx,
      orderId: input.payload.orderId,
    });
  },
  auditTarget: upsertAuditTarget,
});
