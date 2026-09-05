import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  getSharedContract,
  getSharedInputSchema,
  getSharedOutputSchema,
} from "./get-shared.contract.js";

const getSharedSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "get-shared.ts"),
  "utf8",
);

describe("documents.getShared contract", () => {
  it("is a public-target client read with empty permissions and no audit", () => {
    expect(getSharedContract.name).toBe("documents.getShared");
    expect(getSharedContract.principal).toBe("public");
    expect(getSharedContract.publicScope).toBe("target");
    expect(getSharedContract.transport).toBe("client");
    expect(getSharedContract.risk).toBe("read");
    expect(getSharedContract.permissions).toEqual([]);
    expect(getSharedContract.aiExposure).toBe("internal");
    expect(getSharedContract.audit).toBe(false);
    expect(getSharedContract.idempotent).toBe(false);
    expect(getSharedContract.requiresConfirmation).toBe(false);
    expect(getSharedContract.emits).toEqual([]);
    expect(getSharedContract.atomicCalls).toEqual([]);
    expect(getSharedContract.atomicCallers).toEqual([]);
    expect(getSharedContract.timeout).toBe(2_000);
    expect(getSharedContract.rateLimit).toBeUndefined();
    expect(Object.keys(getSharedOutputSchema.shape).toSorted()).toEqual([
      "basis",
      "buyerDetails",
      "counterpartyId",
      "createdAt",
      "currency",
      "documentId",
      "documentNumber",
      "issuedOn",
      "items",
      "orderId",
      "pdfDownloadUrl",
      "signedDownloadUrl",
      "status",
      "supplierDetails",
      "templateName",
      "templateSource",
      "totalGrossMinor",
      "totalNetMinor",
      "totalTaxMinor",
      "type",
    ]);
  });

  it("accepts token and rejects companyId", () => {
    expect(getSharedInputSchema.parse({ token: "abc" })).toEqual({
      token: "abc",
    });
    expect(getSharedInputSchema.safeParse({}).success).toBe(false);
    expect(getSharedInputSchema.safeParse({ token: "" }).success).toBe(false);
    expect(
      getSharedInputSchema.safeParse({ token: "abc", companyId: "x" }).success,
    ).toBe(false);
  });

  it("does not write, emit, or nest a public files URL action", () => {
    expect(getSharedSource).not.toContain(".insert(");
    expect(getSharedSource).not.toContain(".update(");
    expect(getSharedSource).not.toContain(".delete(");
    expect(getSharedSource).not.toContain("ctx.emit");
    expect(getSharedSource).not.toContain("issueGeneratedDownloadUrl");
    expect(getSharedSource).not.toContain("issueShareDownloadUrl");
    expect(getSharedSource).not.toContain("issueShareSigningDownloadUrl");
    expect(getSharedSource).not.toContain("issueSystemSigningDownloadUrl");
    expect(getSharedSource).toContain('ctx.scope !== "target"');
    expect(getSharedSource).toContain("sharedTokenResourceSchema");
    expect(getSharedSource).not.toContain("isSharedTokenResource");
  });
});
