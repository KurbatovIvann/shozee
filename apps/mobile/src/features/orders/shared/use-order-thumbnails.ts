/**
 * Batched list thumbnails for orders (SHO-242 / SHO-243). Download URLs
 * come from `apps/mobile/src/api/file-download-query.ts` — do not
 * duplicate that handshake. Lives in `shared/` so the detail ticket can
 * reuse it without importing `features/catalog`.
 */
import { useQueries } from "@tanstack/react-query";
import { useRef } from "react";

import type { ContractClient } from "../../../api/client";
import {
  fileDownloadUrlsQueryOptions,
  type FileDownloadClient,
} from "../../../api/file-download-query";
import {
  failedPrimaryImageFileIds,
  mergeDownloadUrlPages,
  retainStringMap,
  retainStringSet,
  uniquePrimaryImageFileIds,
} from "./order-thumbnails";

export const ORDER_THUMBNAIL_RENDITION = "thumb" as const;

export function orderThumbnailDownloadInput(fileIds: readonly string[]): {
  readonly fileIds: string[];
  readonly rendition: typeof ORDER_THUMBNAIL_RENDITION;
} {
  return { fileIds: [...fileIds], rendition: ORDER_THUMBNAIL_RENDITION };
}

export function orderThumbnailQueryOptions(args: {
  readonly client: FileDownloadClient | null;
  readonly companyId: string | null;
  readonly getActiveCompany: () => string | null;
  readonly fileIds: readonly string[];
  readonly enabled: boolean;
}) {
  const options = fileDownloadUrlsQueryOptions({
    client: args.client,
    companyId: args.companyId,
    getActiveCompany: args.getActiveCompany,
    ...orderThumbnailDownloadInput(args.fileIds),
  });
  return {
    ...options,
    enabled: options.enabled && args.enabled,
  };
}

export function useOrderThumbnails(args: {
  readonly client: ContractClient | null;
  readonly companyId: string | null;
  readonly getActiveCompany: () => string | null;
  readonly pages: ReadonlyArray<{
    readonly items: ReadonlyArray<{
      readonly primaryImageFileId: string | null;
    }>;
  }>;
  readonly enabled: boolean;
}): {
  readonly urlsByFileId: ReadonlyMap<string, string>;
  readonly failedFileIds: ReadonlySet<string>;
} {
  const thumbnailQueries = useQueries({
    queries: args.pages.map((page) =>
      orderThumbnailQueryOptions({
        client: args.client,
        companyId: args.companyId,
        getActiveCompany: args.getActiveCompany,
        fileIds: uniquePrimaryImageFileIds(page.items),
        enabled: args.enabled,
      }),
    ),
  });
  const nextUrls = mergeDownloadUrlPages(
    thumbnailQueries.map((query) => query.data),
  );
  const nextFailed = failedPrimaryImageFileIds(
    args.pages,
    thumbnailQueries.map((query) => query.isError),
  );
  const urlsRef = useRef<ReadonlyMap<string, string> | undefined>(undefined);
  const failedRef = useRef<ReadonlySet<string> | undefined>(undefined);
  const urlsByFileId = retainStringMap(urlsRef.current, nextUrls);
  const failedFileIds = retainStringSet(failedRef.current, nextFailed);
  urlsRef.current = urlsByFileId;
  failedRef.current = failedFileIds;

  return {
    urlsByFileId,
    failedFileIds,
  };
}
