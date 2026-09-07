import { describe, expect, it } from "vitest";

import {
  getDownloadUrlContract,
  getDownloadUrlInputSchema,
} from "./get-download-url.contract.js";

const fileId = "11111111-1111-4111-8111-111111111111";

describe("files.getDownloadUrl contract", () => {
  it("is a staff client read with files:view, unaudited, and not an idempotent write", () => {
    expect(getDownloadUrlContract.name).toBe("files.getDownloadUrl");
    expect(getDownloadUrlContract.principal).toBe("staff");
    expect(getDownloadUrlContract.transport).toBe("client");
    expect(getDownloadUrlContract.risk).toBe("read");
    expect(getDownloadUrlContract.permissions).toEqual(["files:view"]);
    expect(getDownloadUrlContract.aiExposure).toBe("internal");
    expect(getDownloadUrlContract.audit).toBe(false);
    expect(getDownloadUrlContract.idempotent).toBe(false);
    expect(getDownloadUrlContract.emits).toEqual([]);
    expect(getDownloadUrlContract.timeout).toBe(5_000);
    expect(getDownloadUrlContract.description).toContain("inline");
    expect(getDownloadUrlContract.description).toContain("image/webp");
    expect(getDownloadUrlInputSchema.parse({ fileId })).toEqual({ fileId });
    expect(
      getDownloadUrlInputSchema.parse({ fileId, rendition: "thumb" }),
    ).toEqual({ fileId, rendition: "thumb" });
    expect(() =>
      getDownloadUrlInputSchema.parse({ fileId, rendition: "original" }),
    ).toThrow();
  });
});
