import { describe, expect, it } from "vitest";

import { finalizeUploadContract } from "./finalize-upload.contract.js";

describe("files.finalizeUpload contract", () => {
  it("is a staff client write with files:upload, idempotent audit, and no events", () => {
    expect(finalizeUploadContract.name).toBe("files.finalizeUpload");
    expect(finalizeUploadContract.principal).toBe("staff");
    expect(finalizeUploadContract.transport).toBe("client");
    expect(finalizeUploadContract.risk).toBe("write");
    expect(finalizeUploadContract.permissions).toEqual(["files:upload"]);
    expect(finalizeUploadContract.aiExposure).toBe("internal");
    expect(finalizeUploadContract.audit).toBe(true);
    expect(finalizeUploadContract.idempotent).toBe(true);
    expect(finalizeUploadContract.emits).toEqual([]);
    expect(finalizeUploadContract.timeout).toBe(15_000);
    expect(finalizeUploadContract.description).toContain("thumb");
    expect(finalizeUploadContract.description).toContain("rendition");
  });
});
