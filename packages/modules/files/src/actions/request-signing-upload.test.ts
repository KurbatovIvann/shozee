import { describe, expect, it } from "vitest";

import { MAX_DOCUMENT_BYTES } from "../wire.contract.js";
import {
  requestSigningUploadContract,
  requestSigningUploadInputSchema,
  requestSigningUploadOutputSchema,
} from "./request-signing-upload.contract.js";

describe("files.requestSigningUpload contract", () => {
  it("is a staff client write with documents:edit, idempotent audit, and no events", () => {
    expect(requestSigningUploadContract.name).toBe(
      "files.requestSigningUpload",
    );
    expect(requestSigningUploadContract.principal).toBe("staff");
    expect(requestSigningUploadContract.transport).toBe("client");
    expect(requestSigningUploadContract.risk).toBe("write");
    expect(requestSigningUploadContract.permissions).toEqual([
      "documents:edit",
    ]);
    expect(requestSigningUploadContract.permissions).not.toContain(
      "files:upload",
    );
    expect(requestSigningUploadContract.aiExposure).toBe("internal");
    expect(requestSigningUploadContract.audit).toBe(true);
    expect(requestSigningUploadContract.idempotent).toBe(true);
    expect(requestSigningUploadContract.emits).toEqual([]);
    expect(requestSigningUploadContract.timeout).toBe(5_000);
    expect(MAX_DOCUMENT_BYTES).toBe(25 * 1024 * 1024);
  });

  it("does not accept a client-supplied object key, URL, or company id", () => {
    expect(
      Object.keys(requestSigningUploadInputSchema.shape).toSorted(),
    ).toEqual(["byteSize", "checksumSha256", "mimeType", "purpose"]);
    expect(requestSigningUploadContract.description).toContain("/uploads/");
    expect(requestSigningUploadContract.description).toContain("/signing/");
    expect(requestSigningUploadContract.description).toContain(
      "getSigningUploadUrl",
    );
    expect(
      Object.keys(requestSigningUploadOutputSchema.shape).toSorted(),
    ).toEqual(["fileId"]);
    expect(
      requestSigningUploadInputSchema.safeParse({
        purpose: "catalog",
        mimeType: "application/vnd.etsi.asic-e+zip",
        byteSize: 12,
        checksumSha256: "a".repeat(64),
      }).success,
    ).toBe(false);
    expect(
      requestSigningUploadInputSchema.safeParse({
        purpose: "signing",
        mimeType: "application/pdf",
        byteSize: 12,
        checksumSha256: "a".repeat(64),
      }).success,
    ).toBe(false);
    expect(
      requestSigningUploadInputSchema.safeParse({
        purpose: "signing",
        mimeType: "application/vnd.etsi.asic-e+zip",
        byteSize: 0,
        checksumSha256: "a".repeat(64),
      }).success,
    ).toBe(false);
    expect(
      requestSigningUploadInputSchema.safeParse({
        purpose: "signing",
        mimeType: "application/vnd.etsi.asic-e+zip",
        byteSize: MAX_DOCUMENT_BYTES + 1,
        checksumSha256: "a".repeat(64),
      }).success,
    ).toBe(false);
  });
});
