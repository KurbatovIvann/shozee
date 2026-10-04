import { getSellerFacts } from "@showzy/companies";
import { implementAction, type AuditTargetEnv } from "@showzy/core";
import type { ActionPreviewLine } from "@showzy/core/errors";
import { getCounterparty, getCustomer } from "@showzy/customers";
import { resolveLayout } from "@showzy/doc-generation/resolve-layout";
import { PREVIEW_ABSENT } from "@showzy/module-kit/preview-changes";
import { getOrder } from "@showzy/orders";
import { z } from "zod";

import {
  createFromOrderContract,
  type createFromOrderInputSchema,
} from "./create-from-order.contract.js";
import type { documentTypeSchema } from "./document-view.contract.js";
import { createStaffDocument } from "../services/create-from-order.js";
import { documentTypeLabel } from "../services/preview-document.js";
import {
  requireCounterpartyCustomerMatch,
  requireOrderCustomerId,
  snapshotCounterpartyBuyer,
  snapshotCustomerBuyer,
} from "../services/snapshots.js";

const documentIdHolder = z.object({ documentId: z.string() });
const orderIdHolder = z.object({ orderId: z.string() });

type DocumentType = z.output<typeof documentTypeSchema>;
type CreateFromOrderInput = z.output<typeof createFromOrderInputSchema>;

/**
 * Catalog defaults named on SHO-362. Nested `resolveLayout` still
 * validates the key; one nested read whether the caller omitted layoutKey
 * or passed one.
 */
const DEFAULT_LAYOUT_KEY_BY_TYPE = {
  payment_invoice: "payment_invoice.branded",
  delivery_note: "delivery_note.parties",
} as const satisfies Record<DocumentType, string>;

function requestedLayout(input: CreateFromOrderInput): {
  layoutKey: string;
  type: DocumentType;
} {
  return {
    layoutKey: input.layoutKey ?? DEFAULT_LAYOUT_KEY_BY_TYPE[input.type],
    type: input.type,
  };
}

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
    const layout = await ctx.call(resolveLayout, requestedLayout(input));
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
        order.customer.linkedCustomerId,
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

    const customerId = requireOrderCustomerId(order.customer.linkedCustomerId);
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
  preview: async (input, env) => {
    const order = await env.call(getOrder, { orderId: input.orderId });
    const lines: ActionPreviewLine[] = [
      { label: "Тип", value: documentTypeLabel(input.type) },
      { label: "Замовлення", value: order.orderNumber },
      { label: "Позицій", value: String(order.items.length) },
    ];
    if (input.counterpartyId === undefined) {
      const customer = await env.call(getCustomer, {
        id: requireOrderCustomerId(order.customer.linkedCustomerId),
      });
      lines.push({ label: "Покупець", value: customer.name });
    } else {
      const counterparty = await env.call(getCounterparty, {
        id: input.counterpartyId,
      });
      requireCounterpartyCustomerMatch(
        counterparty.customerId,
        order.customer.linkedCustomerId,
      );
      lines.push({ label: "Покупець", value: counterparty.name });
    }
    const layout = await env.call(resolveLayout, requestedLayout(input));
    lines.push({ label: "Шаблон", value: layout.key });
    lines.push({
      label: "Підстава",
      value: persistableBasis(input.basis) ?? PREVIEW_ABSENT,
    });
    return {
      title: `Створити документ за замовленням ${order.orderNumber}`,
      lines,
      notes: [
        "Документ отримає наступний номер за своїм типом — номер не повертають у нумерацію.",
      ],
    };
  },
  auditTarget: createAuditTarget,
});
