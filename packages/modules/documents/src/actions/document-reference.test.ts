import { ENTITY_REF_QUERY_MAX } from "@showzy/validation/entity-ref";
import { describe, expect, it } from "vitest";

import { cancelDocumentContract } from "./cancel.contract.js";
import {
  DOCUMENT_REFERENCE_DESCRIPTION,
  documentReferenceInputSchema,
} from "./document-reference.contract.js";
import { requestSignContract } from "./request-sign.contract.js";
import { shareDocumentContract } from "./share.contract.js";

const validId = "11111111-1111-4111-8111-111111111111";

describe("the document reference input (SHO-869)", () => {
  it("takes a canonical id alone", () => {
    expect(documentReferenceInputSchema.parse({ documentId: validId })).toEqual(
      {
        documentId: validId,
      },
    );
  });

  it("takes a spoken document number alone", () => {
    expect(
      documentReferenceInputSchema.parse({ documentNumber: " KA-РХ-000057 " }),
    ).toEqual({ documentNumber: "KA-РХ-000057" });
  });

  it("refuses neither reference, both, and a number past the query cap", () => {
    for (const input of [
      {},
      { documentId: validId, documentNumber: "57" },
      { documentNumber: "" },
      { documentNumber: "7".repeat(ENTITY_REF_QUERY_MAX + 1) },
    ]) {
      expect(documentReferenceInputSchema.safeParse(input).success).toBe(false);
    }
  });

  it("refuses a smuggled company id beside either reference", () => {
    for (const input of [
      { documentId: validId, companyId: validId },
      { documentNumber: "57", companyId: validId },
    ]) {
      expect(documentReferenceInputSchema.safeParse(input).success).toBe(false);
    }
  });

  it("tells every reader of the three contracts how a number resolves", () => {
    for (const contract of [
      cancelDocumentContract,
      shareDocumentContract,
      requestSignContract,
    ]) {
      expect(contract.description).toContain(DOCUMENT_REFERENCE_DESCRIPTION);
      expect(contract.errors).toContain("NOT_FOUND");
    }
    expect(cancelDocumentContract.errors).toContain("CONFLICT");
    expect(requestSignContract.errors).toContain("CONFLICT");
  });
});
