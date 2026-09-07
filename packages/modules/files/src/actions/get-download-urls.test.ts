import { describe, expect, it } from "vitest";

import { ATTACHMENT_FACTS_MAX_IDS } from "./get-attachment-facts.contract.js";
import {
  getDownloadUrlsContract,
  getDownloadUrlsInputSchema,
} from "./get-download-urls.contract.js";

const fileId = "11111111-1111-4111-8111-111111111111";

describe("files.getDownloadUrls contract", () => {
  it("is a staff client read with files:view, unaudited, and not an idempotent write", () => {
    expect(getDownloadUrlsContract.name).toBe("files.getDownloadUrls");
    expect(getDownloadUrlsContract.principal).toBe("staff");
    expect(getDownloadUrlsContract.transport).toBe("client");
    expect(getDownloadUrlsContract.risk).toBe("read");
    expect(getDownloadUrlsContract.permissions).toEqual(["files:view"]);
    expect(getDownloadUrlsContract.aiExposure).toBe("internal");
    expect(getDownloadUrlsContract.audit).toBe(false);
    expect(getDownloadUrlsContract.idempotent).toBe(false);
    expect(getDownloadUrlsContract.emits).toEqual([]);
    expect(getDownloadUrlsContract.timeout).toBe(5_000);
    expect(ATTACHMENT_FACTS_MAX_IDS).toBe(50);
    expect(getDownloadUrlsContract.description).toContain("inline");
    expect(getDownloadUrlsContract.description).toContain("image/webp");
    expect(getDownloadUrlsInputSchema.parse({ fileIds: [fileId] })).toEqual({
      fileIds: [fileId],
    });
    expect(
      getDownloadUrlsInputSchema.parse({
        fileIds: [fileId],
        rendition: "card",
      }),
    ).toEqual({ fileIds: [fileId], rendition: "card" });
    expect(() =>
      getDownloadUrlsInputSchema.parse({
        fileIds: [fileId],
        rendition: "original",
      }),
    ).toThrow();
  });
});
