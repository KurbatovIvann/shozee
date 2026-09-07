import { describe, expect, it } from "vitest";

import {
  getSigningUploadUrlContract,
  getSigningUploadUrlOutputSchema,
} from "./get-signing-upload-url.contract.js";

describe("files.getSigningUploadUrl contract", () => {
  it("is a staff client read with documents:edit, unaudited, and not an idempotent write", () => {
    expect(getSigningUploadUrlContract.name).toBe("files.getSigningUploadUrl");
    expect(getSigningUploadUrlContract.principal).toBe("staff");
    expect(getSigningUploadUrlContract.transport).toBe("client");
    expect(getSigningUploadUrlContract.risk).toBe("read");
    expect(getSigningUploadUrlContract.permissions).toEqual(["documents:edit"]);
    expect(getSigningUploadUrlContract.permissions).not.toContain(
      "files:upload",
    );
    expect(getSigningUploadUrlContract.aiExposure).toBe("internal");
    expect(getSigningUploadUrlContract.audit).toBe(false);
    expect(getSigningUploadUrlContract.idempotent).toBe(false);
    expect(getSigningUploadUrlContract.emits).toEqual([]);
    expect(getSigningUploadUrlContract.timeout).toBe(5_000);
    expect(getSigningUploadUrlContract.description).toContain(
      "PUT TTL plus skew margin",
    );
    expect(getSigningUploadUrlContract.description).toContain(
      "call this action again; do not mint a new requestSigningUpload idempotency key",
    );
    expect(getSigningUploadUrlContract.description).toContain(
      "call requestSigningUpload with a new idempotency key",
    );
    expect(
      Object.keys(getSigningUploadUrlOutputSchema.shape).toSorted(),
    ).toEqual(["expiresAt", "fileId", "uploadUrl"]);
  });
});
