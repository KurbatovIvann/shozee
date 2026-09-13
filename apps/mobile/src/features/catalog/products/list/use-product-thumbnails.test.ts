import { describe, expect, it } from "vitest";

import { createShowzyQueryClient } from "../../../../api/query-client";
import { contractQueryKey } from "../../../../api/query-options";
import {
  GET_DOWNLOAD_URLS_ACTION,
  LIST_THUMBNAIL_RENDITION,
  type FileDownloadClient,
} from "../../../../api/file-download-query";
import { canFetchFileDownloadUrls } from "../shared/product-permissions";
import {
  failedPrimaryImageFileIds,
  mergeDownloadUrlPages,
  productListDownloadInput,
  productListThumbnailQueryOptions,
  resolveProductThumbnail,
  retainStringMap,
  retainStringSet,
  uniquePrimaryImageFileIds,
} from "./use-product-thumbnails";

const FILE_A = "44444444-4444-4444-8444-444444444444";
const FILE_B = "55555555-5555-4555-8555-555555555555";
const COMPANY_ID = "company-a";

function item(primaryImageFileId: string | null): {
  readonly primaryImageFileId: string | null;
} {
  return { primaryImageFileId };
}

function unusedDownloadUrl(): never {
  throw new TypeError("getDownloadUrl should not run");
}

function stubDownloadUrlsClient(
  onGetDownloadUrls: FileDownloadClient["client"]["files"]["getDownloadUrls"],
): FileDownloadClient {
  return {
    client: {
      files: {
        getDownloadUrl: unusedDownloadUrl,
        getDownloadUrls: onGetDownloadUrls,
      },
    },
  };
}

describe("uniquePrimaryImageFileIds", () => {
  it("skips nulls and duplicates, keeping first-seen order", () => {
    expect(
      uniquePrimaryImageFileIds([
        item(null),
        item(FILE_A),
        item(FILE_B),
        item(FILE_A),
        item(null),
      ]),
    ).toEqual([FILE_A, FILE_B]);
  });
});

describe("productListThumbnailQueryOptions", () => {
  it("batches unique primary image ids onto thumb when files:view is enabled (SHO-244)", async () => {
    const fileIds = uniquePrimaryImageFileIds([
      item(null),
      item(FILE_A),
      item(FILE_B),
      item(FILE_A),
    ]);
    expect(LIST_THUMBNAIL_RENDITION).toBe("thumb");
    expect(productListDownloadInput(fileIds)).toEqual({
      fileIds: [FILE_A, FILE_B],
      rendition: "thumb",
    });

    const seen: unknown[] = [];
    const client = stubDownloadUrlsClient((input) => {
      seen.push(input);
      return Promise.resolve({ files: [] });
    });
    const options = productListThumbnailQueryOptions({
      client,
      companyId: COMPANY_ID,
      getActiveCompany: () => COMPANY_ID,
      fileIds,
      enabled: canFetchFileDownloadUrls("owner"),
    });
    expect(options.enabled).toBe(true);
    expect(options.queryKey).toEqual(
      contractQueryKey(GET_DOWNLOAD_URLS_ACTION, COMPANY_ID, {
        fileIds: [FILE_A, FILE_B],
        rendition: "thumb",
      }),
    );

    const queryClient = createShowzyQueryClient({ retryDelay: () => 0 });
    await queryClient.fetchQuery({ ...options, retry: false });
    expect(seen).toEqual([{ fileIds: [FILE_A, FILE_B], rendition: "thumb" }]);
    queryClient.clear();
  });

  it("stays disabled without files:view so employees skip the download", () => {
    const options = productListThumbnailQueryOptions({
      client: stubDownloadUrlsClient(() => {
        throw new TypeError("getDownloadUrls should not run");
      }),
      companyId: COMPANY_ID,
      getActiveCompany: () => COMPANY_ID,
      fileIds: [FILE_A],
      enabled: canFetchFileDownloadUrls("employee"),
    });
    expect(options.enabled).toBe(false);
    expect(options.queryKey).toEqual(
      contractQueryKey(GET_DOWNLOAD_URLS_ACTION, COMPANY_ID, {
        fileIds: [FILE_A],
        rendition: "thumb",
      }),
    );
  });
});

describe("mergeDownloadUrlPages", () => {
  it("ignores pending pages and last write wins for a repeated fileId", () => {
    const merged = mergeDownloadUrlPages([
      undefined,
      {
        files: [
          { fileId: FILE_A, downloadUrl: "https://example.test/a" },
          { fileId: FILE_B, downloadUrl: "https://example.test/b" },
        ],
      },
      {
        files: [{ fileId: FILE_A, downloadUrl: "https://example.test/a2" }],
      },
    ]);
    expect(merged.get(FILE_A)).toBe("https://example.test/a2");
    expect(merged.get(FILE_B)).toBe("https://example.test/b");
    expect(merged.get("missing")).toBeUndefined();
  });
});

describe("failedPrimaryImageFileIds", () => {
  it("collects ids only from pages whose download query failed", () => {
    expect([
      ...failedPrimaryImageFileIds(
        [{ items: [item(FILE_A)] }, { items: [item(FILE_B), item(null)] }],
        [false, true],
      ),
    ]).toEqual([FILE_B]);
  });
});

describe("retainStringMap / retainStringSet", () => {
  it("keeps the previous collection when contents match so list memo can bail", () => {
    const urls = mergeDownloadUrlPages([
      {
        files: [{ fileId: FILE_A, downloadUrl: "https://example.test/a" }],
      },
    ]);
    const sameUrls = mergeDownloadUrlPages([
      {
        files: [{ fileId: FILE_A, downloadUrl: "https://example.test/a" }],
      },
    ]);
    expect(sameUrls).not.toBe(urls);
    expect(retainStringMap(urls, sameUrls)).toBe(urls);
    expect(
      retainStringMap(
        urls,
        mergeDownloadUrlPages([
          {
            files: [{ fileId: FILE_A, downloadUrl: "https://example.test/b" }],
          },
        ]),
      ),
    ).not.toBe(urls);

    const failed = failedPrimaryImageFileIds(
      [{ items: [item(FILE_A)] }],
      [true],
    );
    const sameFailed = failedPrimaryImageFileIds(
      [{ items: [item(FILE_A)] }],
      [true],
    );
    expect(sameFailed).not.toBe(failed);
    expect(retainStringSet(failed, sameFailed)).toBe(failed);
    expect(
      retainStringSet(
        failed,
        failedPrimaryImageFileIds([{ items: [item(FILE_B)] }], [true]),
      ),
    ).not.toBe(failed);
  });
});

describe("resolveProductThumbnail", () => {
  it("maps a download-query error to failed, not success with an empty URL", () => {
    expect(
      resolveProductThumbnail({
        fileId: FILE_A,
        url: undefined,
        downloadFailed: true,
      }),
    ).toEqual({ kind: "failed" });
    expect(
      resolveProductThumbnail({
        fileId: FILE_A,
        url: undefined,
        downloadFailed: false,
      }),
    ).toEqual({ kind: "empty" });
    expect(
      resolveProductThumbnail({
        fileId: FILE_A,
        url: "https://example.test/a",
        downloadFailed: true,
      }),
    ).toEqual({ kind: "ready", url: "https://example.test/a" });
    expect(
      resolveProductThumbnail({
        fileId: null,
        url: undefined,
        downloadFailed: true,
      }),
    ).toEqual({ kind: "empty" });
  });
});
