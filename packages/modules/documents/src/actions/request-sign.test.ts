import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ALREADY_SIGNED_MESSAGE,
  CANCELLED_DOCUMENT_SIGN_MESSAGE,
  CANCELLED_REQUEST_SIGN_MESSAGE,
  CANCELLED_START_MESSAGE,
  PDF_NOT_READY_MESSAGE,
} from "@showzy/validation/signing";

import {
  requestSignContract,
  requestSignInputSchema,
} from "./request-sign.contract.js";
import {
  ALREADY_SIGNED_MESSAGE as REQUEST_SIGN_ALREADY_SIGNED_MESSAGE,
  CANCELLED_REQUEST_SIGN_MESSAGE as REQUEST_SIGN_CANCELLED_MESSAGE,
  PDF_NOT_READY_MESSAGE as REQUEST_SIGN_PDF_NOT_READY_MESSAGE,
  REQUEST_SIGN_KEY_POSSESSION_NOTE,
} from "./request-sign.js";

const validId = "11111111-1111-4111-8111-111111111111";

const requestSignSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "request-sign.ts"),
  "utf8",
);

describe("documents.requestSign contract", () => {
  it("is a staff client high-risk HITL write with documents:edit", () => {
    expect(requestSignContract.name).toBe("documents.requestSign");
    expect(requestSignContract.principal).toBe("staff");
    expect(requestSignContract.transport).toBe("client");
    expect(requestSignContract.risk).toBe("high");
    expect(requestSignContract.permissions).toEqual(["documents:edit"]);
    expect(requestSignContract.aiExposure).toBe("exposed");
    expect(requestSignContract.requiresConfirmation).toBe(true);
    expect(requestSignContract.idempotent).toBe(true);
    expect(requestSignContract.audit).toBe(true);
    expect(requestSignContract.emits).toEqual(["documents.signRequested"]);
    expect(requestSignContract.atomicCalls).toEqual([]);
    expect(requestSignContract.atomicCallers).toEqual([]);
    expect(requestSignContract.timeout).toBe(5_000);
    expect(requestSignContract.rateLimit).toBeUndefined();
  });

  it("accepts documentId and rejects companyId", () => {
    expect(requestSignInputSchema.parse({ documentId: validId })).toEqual({
      documentId: validId,
    });
    expect(requestSignInputSchema.safeParse({}).success).toBe(false);
    expect(
      requestSignInputSchema.safeParse({ documentId: "not-a-uuid" }).success,
    ).toBe(false);
    expect(
      requestSignInputSchema.safeParse({
        documentId: validId,
        companyId: validId,
      }).success,
    ).toBe(false);
  });

  it("keeps the key-possession note free of live numbers and PII", () => {
    expect(REQUEST_SIGN_KEY_POSSESSION_NOTE).toContain("володіння ключем");
    expect(REQUEST_SIGN_KEY_POSSESSION_NOTE).not.toMatch(/\d{6}/);
    expect(REQUEST_SIGN_KEY_POSSESSION_NOTE).not.toContain("@");
    expect(REQUEST_SIGN_KEY_POSSESSION_NOTE).not.toContain("+380");
  });

  it("emits the shared signing-gate clientMessages also used by docSigning.start", () => {
    expect(REQUEST_SIGN_CANCELLED_MESSAGE).toBe(CANCELLED_REQUEST_SIGN_MESSAGE);
    expect(REQUEST_SIGN_CANCELLED_MESSAGE).toBe(CANCELLED_START_MESSAGE);
    expect(REQUEST_SIGN_CANCELLED_MESSAGE).toBe(
      CANCELLED_DOCUMENT_SIGN_MESSAGE,
    );
    expect(REQUEST_SIGN_ALREADY_SIGNED_MESSAGE).toBe(ALREADY_SIGNED_MESSAGE);
    expect(REQUEST_SIGN_PDF_NOT_READY_MESSAGE).toBe(PDF_NOT_READY_MESSAGE);
  });

  it("nests getArtifact and getSigning without foreign schema joins", () => {
    expect(requestSignSource).toContain("getArtifact");
    expect(requestSignSource).toContain("@showzy/doc-generation/get-artifact");
    expect(requestSignSource).toContain("getSigning");
    expect(requestSignSource).toContain("@showzy/doc-signing/get");
    expect(requestSignSource).not.toContain('@showzy/doc-signing"');
    expect(requestSignSource).not.toContain("@showzy/db/schema/doc-signing");
    expect(requestSignSource).not.toContain("@showzy/db/schema/doc-generation");
    expect(requestSignSource).not.toContain("documents.sign");
  });
});
