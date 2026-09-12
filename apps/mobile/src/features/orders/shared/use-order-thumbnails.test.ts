import { describe, expect, it } from "vitest";

import { createShowzyQueryClient } from "../../../api/query-client";
import { contractQueryKey } from "../../../api/query-options";
import {
  GET_DOWNLOAD_URLS_ACTION,
  type FileDownloadClient,
} from "../../../api/file-download-query";
import {
  ORDER_THUMBNAIL_RENDITION,
  orderThumbnailDownloadInput,
  orderThumbnailQueryOptions,
} from "./use-order-thumbnails";

const FILE_A = "44444444-4444-4444-8444-444444444444";
const FILE_B = "55555555-5555-4555-8555-555555555555";
const COMPANY_ID = "company-a";

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

describe("orderThumbnailQueryOptions signing rendition", () => {
  it("signs the list rendition instead of the full-size original", async () => {
    expect(ORDER_THUMBNAIL_RENDITION).toBe("thumb");
    expect(orderThumbnailDownloadInput([FILE_A, FILE_B])).toEqual({
      fileIds: [FILE_A, FILE_B],
      rendition: "thumb",
    });

    const seen: unknown[] = [];
    const client = stubDownloadUrlsClient((input) => {
      seen.push(input);
      return Promise.resolve({ files: [] });
    });
    const options = orderThumbnailQueryOptions({
      client,
      companyId: COMPANY_ID,
      getActiveCompany: () => COMPANY_ID,
      fileIds: [FILE_A, FILE_B],
      enabled: true,
    });
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

  it("stays disabled when the caller disables it, without signing anything", () => {
    const options = orderThumbnailQueryOptions({
      client: stubDownloadUrlsClient(() => {
        throw new TypeError("getDownloadUrls should not run");
      }),
      companyId: COMPANY_ID,
      getActiveCompany: () => COMPANY_ID,
      fileIds: [FILE_A],
      enabled: false,
    });
    expect(options.enabled).toBe(false);
  });
});
