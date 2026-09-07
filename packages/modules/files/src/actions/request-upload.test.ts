import { describe, expect, it } from "vitest";

import { MAX_UPLOAD_BYTES } from "../wire.contract.js";
import {
  requestUploadContract,
  requestUploadInputSchema,
  requestUploadOutputSchema,
} from "./request-upload.contract.js";

describe("files.requestUpload contract", () => {
  it("is a staff client write with files:upload, idempotent audit, and no events", () => {
    expect(requestUploadContract.name).toBe("files.requestUpload");
    expect(requestUploadContract.principal).toBe("staff");
    expect(requestUploadContract.transport).toBe("client");
    expect(requestUploadContract.risk).toBe("write");
    expect(requestUploadContract.permissions).toEqual(["files:upload"]);
    expect(requestUploadContract.aiExposure).toBe("internal");
    expect(requestUploadContract.audit).toBe(true);
    expect(requestUploadContract.idempotent).toBe(true);
    expect(requestUploadContract.emits).toEqual([]);
    expect(requestUploadContract.timeout).toBe(5_000);
    expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
  });

  it("does not accept a client-supplied object key, URL, or company id", () => {
    expect(Object.keys(requestUploadInputSchema.shape).toSorted()).toEqual([
      "byteSize",
      "checksumSha256",
      "mimeType",
      "purpose",
    ]);
    expect(requestUploadContract.description).toContain("/uploads/");
    expect(requestUploadContract.description).toContain("/catalog/");
    expect(requestUploadContract.description).toContain("getUploadUrl");
    expect(Object.keys(requestUploadOutputSchema.shape).toSorted()).toEqual([
      "fileId",
    ]);
  });
});
