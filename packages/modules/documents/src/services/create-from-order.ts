import { randomUUID } from "node:crypto";

import type { ActionCtx } from "@showzy/core";
import { ConflictError, CoreInvariantError } from "@showzy/core/errors";
import { documentItems, documents } from "@showzy/db/schema/documents";
import { moneyToCanonical } from "@showzy/module-kit/canonical";
import { parseDbEnum } from "@showzy/module-kit/parse-db-enum";
import { and, eq, ne } from "drizzle-orm";
import type { z } from "zod";

import type { createFromOrderInputSchema } from "../actions/create-from-order.contract.js";
import {
  documentTaxTreatmentSchema,
  documentViewSchema,
  type documentTypeSchema,
} from "../actions/document-view.contract.js";
import { documentsCreated } from "../events/created.js";
import {
  allocateNextDocumentNumber,
  formatDocumentNumber,
} from "./document-number.js";
import { kyivCalendarDay } from "./kyiv-calendar-day.js";
import type { BuyerDetails, SellerFacts } from "./snapshots.js";
import { snapshotSupplier } from "./snapshots.js";
import {
  DUPLICATE_LIVE_DOCUMENT_MESSAGE,
  mapLiveDocumentUniqueViolation,
} from "./unique-violations.js";
import { requireWritable } from "./writable.js";

type StaffCtx = Extract<ActionCtx, { principal: "staff" }>;
type CreateInput = z.output<typeof createFromOrderInputSchema>;
type DocumentView = z.output<typeof documentViewSchema>;
type DocumentType = z.output<typeof documentTypeSchema>;
type OrderLine = {
  readonly productId: string;
  readonly variantId: string | null;
  readonly titleSnapshot: string;
  readonly quantityMilli: string;
  readonly unitPriceMinor: string;
  readonly discountKind: "none";
  readonly discountValue: string;
  readonly discountAmountMinor: string;
  readonly taxTreatment: string;
  readonly taxRateBp: number;
  readonly taxAmountMinor: string;
  readonly netAmountMinor: string;
  readonly grossAmountMinor: string;
  readonly currency: string;
};

export const CANCELED_ORDER_MESSAGE =
  "A document cannot be created from a canceled order.";

export interface OrderSnapshot {
  readonly orderId: string;
  readonly customerId: string | null;
  readonly status: string;
  readonly items: readonly OrderLine[];
}

function parseTaxTreatment(
  value: string,
): z.output<typeof documentTaxTreatmentSchema> {
  return parseDbEnum(
    documentTaxTreatmentSchema,
    value,
    `order line tax_treatment "${value}" is not a document snapshot value`,
  );
}

export function assertOrderNotCanceled(status: string): void {
  if (status === "canceled") {
    throw new ConflictError(CANCELED_ORDER_MESSAGE);
  }
}

async function assertNoLiveDocument(env: {
  readonly db: ReturnType<typeof requireWritable>;
  readonly companyId: string;
  readonly orderId: string;
  readonly type: DocumentType;
}): Promise<void> {
  const existing = (
    await env.db
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          eq(documents.companyId, env.companyId),
          eq(documents.orderId, env.orderId),
          eq(documents.type, env.type),
          ne(documents.status, "cancelled"),
        ),
      )
      .limit(1)
  )[0];
  if (existing !== undefined) {
    throw new ConflictError(DUPLICATE_LIVE_DOCUMENT_MESSAGE);
  }
}

export async function createStaffDocument(env: {
  readonly ctx: StaffCtx;
  readonly input: CreateInput;
  readonly templateName: string;
  readonly basis: string | null;
  readonly order: OrderSnapshot;
  readonly seller: SellerFacts;
  readonly buyer: BuyerDetails;
  readonly counterpartyId: string | null;
  readonly now?: Date;
}): Promise<DocumentView> {
  const {
    ctx,
    input,
    templateName,
    basis,
    order,
    seller,
    buyer,
    counterpartyId,
  } = env;
  assertOrderNotCanceled(order.status);

  const first = order.items[0];
  if (first === undefined) {
    throw new CoreInvariantError(
      `order ${order.orderId} has no line snapshots to copy`,
    );
  }
  const currency = first.currency;
  for (const item of order.items) {
    if (item.currency !== currency) {
      throw new CoreInvariantError(
        `order ${order.orderId} line currencies are not uniform`,
      );
    }
  }

  const documentId = randomUUID();
  const supplierDetails = snapshotSupplier(seller);
  const now = env.now ?? new Date();
  const issuedOn = kyivCalendarDay(now);
  const db = requireWritable(ctx.db);

  await assertNoLiveDocument({
    db,
    companyId: ctx.companyId,
    orderId: order.orderId,
    type: input.type,
  });

  const sequence = await allocateNextDocumentNumber(
    db,
    ctx.companyId,
    input.type,
  );
  const documentNumber = formatDocumentNumber(
    seller.prefix,
    input.type,
    sequence,
  );

  const lines = order.items.map((item) => {
    const itemId = randomUUID();
    const taxTreatment = parseTaxTreatment(item.taxTreatment);
    return {
      itemId,
      productId: item.productId,
      variantId: item.variantId,
      titleSnapshot: item.titleSnapshot,
      quantityMilli: item.quantityMilli,
      unitPriceMinor: item.unitPriceMinor,
      discountKind: item.discountKind,
      discountValue: item.discountValue,
      discountAmountMinor: item.discountAmountMinor,
      taxTreatment,
      taxRateBp: item.taxRateBp,
      taxAmountMinor: item.taxAmountMinor,
      netAmountMinor: item.netAmountMinor,
      grossAmountMinor: item.grossAmountMinor,
      currency: item.currency,
      quantityMilliBig: BigInt(item.quantityMilli),
      unitPriceMinorBig: BigInt(item.unitPriceMinor),
      discountValueBig: BigInt(item.discountValue),
      discountAmountMinorBig: BigInt(item.discountAmountMinor),
      taxAmountMinorBig: BigInt(item.taxAmountMinor),
      netAmountMinorBig: BigInt(item.netAmountMinor),
      grossAmountMinorBig: BigInt(item.grossAmountMinor),
    };
  });

  let totalNetMinor = 0n;
  let totalTaxMinor = 0n;
  let totalGrossMinor = 0n;
  for (const line of lines) {
    totalNetMinor += line.netAmountMinorBig;
    totalTaxMinor += line.taxAmountMinorBig;
    totalGrossMinor += line.grossAmountMinorBig;
  }

  let inserted: { createdAt: Date } | undefined;
  try {
    inserted = (
      await db
        .insert(documents)
        .values({
          id: documentId,
          companyId: ctx.companyId,
          orderId: order.orderId,
          counterpartyId,
          type: input.type,
          status: "issued",
          documentNumber,
          issuedOn,
          supplierDetails,
          buyerDetails: buyer,
          totalNetMinor,
          totalTaxMinor,
          totalGrossMinor,
          currency,
          templateSource: "system",
          templateName,
          basis,
          createdVia: ctx.channel,
        })
        .returning({ createdAt: documents.createdAt })
    )[0];
  } catch (error) {
    throw mapLiveDocumentUniqueViolation(error);
  }
  if (inserted === undefined) {
    throw new CoreInvariantError(
      "documents.createFromOrder insert returned no row",
    );
  }

  await db.insert(documentItems).values(
    lines.map((line) => ({
      id: line.itemId,
      companyId: ctx.companyId,
      documentId,
      productId: line.productId,
      variantId: line.variantId,
      titleSnapshot: line.titleSnapshot,
      quantityMilli: line.quantityMilliBig,
      unitPriceMinor: line.unitPriceMinorBig,
      discountKind: line.discountKind,
      discountValue: line.discountValueBig,
      discountAmountMinor: line.discountAmountMinorBig,
      taxTreatment: line.taxTreatment,
      taxRateBp: line.taxRateBp,
      taxAmountMinor: line.taxAmountMinorBig,
      netAmountMinor: line.netAmountMinorBig,
      grossAmountMinor: line.grossAmountMinorBig,
      currency: line.currency,
    })),
  );

  ctx.emit(documentsCreated, {
    aggregate: { type: "document", id: documentId },
    payload: {
      documentId,
      orderId: order.orderId,
      type: input.type,
      documentNumber,
    },
  });

  return {
    documentId,
    orderId: order.orderId,
    counterpartyId,
    type: input.type,
    status: "issued",
    documentNumber,
    issuedOn,
    supplierDetails,
    buyerDetails: buyer,
    totalNetMinor: moneyToCanonical(totalNetMinor),
    totalTaxMinor: moneyToCanonical(totalTaxMinor),
    totalGrossMinor: moneyToCanonical(totalGrossMinor),
    currency,
    templateSource: "system",
    templateName,
    basis,
    createdAt: inserted.createdAt.toISOString(),
    items: lines.map((line) => ({
      itemId: line.itemId,
      productId: line.productId,
      variantId: line.variantId,
      titleSnapshot: line.titleSnapshot,
      quantityMilli: line.quantityMilli,
      unitPriceMinor: line.unitPriceMinor,
      discountKind: line.discountKind,
      discountValue: line.discountValue,
      discountAmountMinor: line.discountAmountMinor,
      taxTreatment: line.taxTreatment,
      taxRateBp: line.taxRateBp,
      taxAmountMinor: line.taxAmountMinor,
      netAmountMinor: line.netAmountMinor,
      grossAmountMinor: line.grossAmountMinor,
      currency: line.currency,
    })),
  };
}
