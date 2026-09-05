import { implementAction } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";
import { documents } from "@showzy/db/schema/documents";
import { getSupplierSignedFlags } from "@showzy/doc-signing/get-supplier-signed-flags";
import { moneyToCanonical } from "@showzy/module-kit/canonical";
import { paginate } from "@showzy/validation/pagination";
import { and, desc, eq, lt, or } from "drizzle-orm";

import { parseStatus, parseType } from "../services/parse-document.js";
import { buyerLabelFromSnapshot } from "../services/snapshots.js";
import {
  formatListDocumentsCursor,
  listDocumentsContract,
  parseListDocumentsCursor,
} from "./list.contract.js";

export const listDocuments = implementAction(listDocumentsContract, {
  handler: async (input, ctx) => {
    const cursor =
      input.cursor === undefined
        ? undefined
        : parseListDocumentsCursor(input.cursor);
    if (input.cursor !== undefined && cursor === undefined) {
      throw new CoreInvariantError(
        "listDocuments cursor passed validation but failed to parse",
      );
    }

    const cursorPredicate =
      cursor === undefined
        ? undefined
        : or(
            lt(documents.createdAt, new Date(cursor.createdAt)),
            and(
              eq(documents.createdAt, new Date(cursor.createdAt)),
              lt(documents.id, cursor.id),
            ),
          );

    const pageRows = await ctx.db
      .select({
        id: documents.id,
        type: documents.type,
        documentNumber: documents.documentNumber,
        orderId: documents.orderId,
        counterpartyId: documents.counterpartyId,
        status: documents.status,
        totalGrossMinor: documents.totalGrossMinor,
        currency: documents.currency,
        issuedOn: documents.issuedOn,
        createdAt: documents.createdAt,
        buyerDetails: documents.buyerDetails,
      })
      .from(documents)
      .where(
        and(
          eq(documents.companyId, ctx.companyId),
          input.type === "all" ? undefined : eq(documents.type, input.type),
          input.orderId === undefined
            ? undefined
            : eq(documents.orderId, input.orderId),
          cursorPredicate,
        ),
      )
      .orderBy(desc(documents.createdAt), desc(documents.id))
      .limit(input.limit + 1);

    const { page, nextCursor } = paginate(pageRows, input.limit, (last) =>
      formatListDocumentsCursor(last.createdAt, last.id),
    );

    const flags = await ctx.call(getSupplierSignedFlags, {
      documentIds: page.map((row) => row.id),
    });
    const signed = new Map(
      flags.flags.map((flag) => [flag.documentId, flag.supplierSigned]),
    );

    return {
      items: page.map((row) => ({
        documentId: row.id,
        type: parseType(row.type),
        documentNumber: row.documentNumber,
        orderId: row.orderId,
        counterpartyId: row.counterpartyId,
        status: parseStatus(row.status),
        totalGrossMinor: moneyToCanonical(row.totalGrossMinor),
        currency: row.currency,
        issuedOn: row.issuedOn,
        createdAt: row.createdAt.toISOString(),
        buyerLabel: buyerLabelFromSnapshot(row.buyerDetails),
        supplierSigned: signed.get(row.id) === true,
      })),
      nextCursor,
    };
  },
});
