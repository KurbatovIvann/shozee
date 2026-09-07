import { describe, expect, it } from "vitest";

import {
  getUploadUrlContract,
  getUploadUrlOutputSchema,
} from "./get-upload-url.contract.js";

describe("files.getUploadUrl contract", () => {
  it("is a staff client read with files:upload, unaudited, and not an idempotent write", () => {
    expect(getUploadUrlContract.name).toBe("files.getUploadUrl");
    expect(getUploadUrlContract.principal).toBe("staff");
    expect(getUploadUrlContract.transport).toBe("client");
    expect(getUploadUrlContract.risk).toBe("read");
    expect(getUploadUrlContract.permissions).toEqual(["files:upload"]);
    expect(getUploadUrlContract.aiExposure).toBe("internal");
    expect(getUploadUrlContract.audit).toBe(false);
    expect(getUploadUrlContract.idempotent).toBe(false);
    expect(getUploadUrlContract.emits).toEqual([]);
    expect(getUploadUrlContract.timeout).toBe(5_000);
    expect(getUploadUrlContract.description).toContain(
      "PUT TTL plus skew margin",
    );
    expect(getUploadUrlContract.description).toContain(
      "call this action again; do not mint a new requestUpload idempotency key",
    );
    expect(getUploadUrlContract.description).toContain(
      "call requestUpload with a new idempotency key",
    );
    expect(Object.keys(getUploadUrlOutputSchema.shape).toSorted()).toEqual([
      "expiresAt",
      "fileId",
      "uploadUrl",
    ]);
  });
});
