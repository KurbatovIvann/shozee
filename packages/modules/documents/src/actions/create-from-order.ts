import { getSellerFacts } from "@showzy/companies";
import { implementAction, type AuditTargetEnv } from "@showzy/core";
import { getCounterparty, getCustomer } from "@showzy/customers";
import { resolveLayout } from "@showzy/doc-generation/resolve-layout";
import { getOrder } from "@showzy/orders";
import { z } from "zod";

import { createFromOrderContract } from "./create-from-order.contract.js";
import type { documentTypeSchema } from "./document-view.contract.js";
import { createStaffDocument } from "../services/create-from-order.js";
import {
  requireCounterpartyCustomerMatch,
  requireOrderCustomerId,
  snapshotCounterpartyBuyer,
  snapshotCustomerBuyer,
} from "../services/snapshots.js";

const documentIdHolder = z.object({ documentId: z.string() });
const orderIdHolder = z.object({ orderId: z.string() });

type DocumentType = z.output<typeof documentTypeSchema>;

/**
 * Catalog defaults named on SHO-362. Nested `resolveLayout` still
 * validates the key; one nested read whether the caller omitted layoutKey
 * or passed one.
 */
const DEFAULT_LAYOUT_KEY_BY_TYPE = {
  payment_invoice: "payment_invoice.branded",
  delivery_note: "delivery_note.parties",
} as const satisfies Record<DocumentType, string>;

function persistableBasis(value: string | undefined): string | null {
  if (value === undefined || value.length === 0) {
    return null;
  }
  return value;
}

function createAuditTarget(env: AuditTargetEnv): { type: string; id: string } {
  const fromOutput = documentIdHolder.safeParse(env.output);
  if (fromOutput.success) {
    return { type: "document", id: fromOutput.data.documentId };
  }
  const fromInput = orderIdHolder.safeParse(env.input);
  return {
    type: "document",
    id: fromInput.success ? fromInput.data.orderId : "uncreated",
  };
}

export const createFromOrder = implementAction(createFromOrderContract, {
  handler: async (input, ctx) => {
    const layout = await ctx.call(resolveLayout, {
      layoutKey: input.layoutKey ?? DEFAULT_LAYOUT_KEY_BY_TYPE[input.type],
      type: input.type,
    });
    const templateName = layout.key;
    const basis = persistableBasis(input.basis);

    const order = await ctx.call(getOrder, { orderId: input.orderId });
    const seller = await ctx.call(getSellerFacts, {});

    if (input.counterpartyId !== undefined) {
      const counterparty = await ctx.call(getCounterparty, {
        id: input.counterpartyId,
      });
      requireCounterpartyCustomerMatch(
        counterparty.customerId,
        order.customerId,
      );
      return createStaffDocument({
        ctx,
        input,
        templateName,
        basis,
        order,
        seller,
        buyer: snapshotCounterpartyBuyer(counterparty),
        counterpartyId: counterparty.id,
      });
    }

    const customerId = requireOrderCustomerId(order.customerId);
    const customer = await ctx.call(getCustomer, { id: customerId });
    return createStaffDocument({
      ctx,
      input,
      templateName,
      basis,
      order,
      seller,
      buyer: snapshotCustomerBuyer(customer.name),
      counterpartyId: null,
    });
  },
  auditTarget: createAuditTarget,
});
