/**
 * `files.getDownloadUrl` / `files.getDownloadUrls` read bindings
 * (SHO-137 / SHO-140 / SHO-247). Signed URLs are short-lived and live
 * only in the in-memory query cache — never in device prefs or any
 * persisted store. `staleTime` tracks `expiresAt` so a re-observed row
 * refetches a fresh URL instead of rendering a dead one.
 *
 * Optional `rendition` is part of the contract input (and therefore the
 * TanStack key) so thumb/card/hero/full caches never mix. Omitted
 * rendition keeps original-object signing for non-catalog callers.
 * Catalog surfaces must pass a named size (SHO-244).
 */
import type { ContractClient } from "./client";
import { requireReadyClient } from "./errors";
import { contractQueryOptions } from "./query-options";

export const GET_DOWNLOAD_URL_ACTION = "files.getDownloadUrl";
export const GET_DOWNLOAD_URLS_ACTION = "files.getDownloadUrls";
export const LIST_THUMBNAIL_RENDITION = "thumb" as const;

type ShowzyClient = ContractClient;
type GetDownloadUrl = ShowzyClient["client"]["files"]["getDownloadUrl"];
type GetDownloadUrls = ShowzyClient["client"]["files"]["getDownloadUrls"];

export type CatalogFileRendition = NonNullable<
  Parameters<GetDownloadUrl>[0]["rendition"]
>;

/** Structural client so tests can stub files downloads without a full router. */
export type FileDownloadClient = {
  readonly client: {
    readonly files: {
      readonly getDownloadUrl: GetDownloadUrl;
      readonly getDownloadUrls: GetDownloadUrls;
    };
  };
};

export type DownloadUrlOutput = Awaited<ReturnType<GetDownloadUrl>>;
export type DownloadUrlsOutput = Awaited<ReturnType<GetDownloadUrls>>;

/** Refetch this long before the signed URL actually expires. */
export const DOWNLOAD_URL_EXPIRY_MARGIN_MS = 30_000;

export function downloadUrlStaleTimeMs(
  data: Pick<DownloadUrlOutput, "expiresAt"> | undefined,
  nowMs: number,
): number {
  if (data === undefined) {
    return 0;
  }
  const expiresAtMs = Date.parse(data.expiresAt);
  if (Number.isNaN(expiresAtMs)) {
    return 0;
  }
  return Math.max(0, expiresAtMs - nowMs - DOWNLOAD_URL_EXPIRY_MARGIN_MS);
}

export function downloadUrlsStaleTimeMs(
  data: Pick<DownloadUrlsOutput, "files"> | undefined,
  nowMs: number,
): number {
  if (data === undefined || data.files.length === 0) {
    return 0;
  }
  return Math.min(
    ...data.files.map((file) => downloadUrlStaleTimeMs(file, nowMs)),
  );
}

export function fileDownloadUrlInput(args: {
  readonly fileId: string;
  readonly rendition?: CatalogFileRendition;
}): Parameters<GetDownloadUrl>[0] {
  if (args.rendition === undefined) {
    return { fileId: args.fileId };
  }
  return { fileId: args.fileId, rendition: args.rendition };
}

export function fileDownloadUrlsInput(args: {
  readonly fileIds: readonly string[];
  readonly rendition?: CatalogFileRendition;
}): Parameters<GetDownloadUrls>[0] {
  const fileIds = [...args.fileIds];
  if (args.rendition === undefined) {
    return { fileIds };
  }
  return { fileIds, rendition: args.rendition };
}

export function fileDownloadUrlQueryOptions(args: {
  readonly client: FileDownloadClient | null;
  readonly companyId: string | null;
  readonly fileId: string;
  readonly rendition?: CatalogFileRendition;
  readonly getActiveCompany: () => string | null;
}) {
  const client = args.client;
  const input =
    args.rendition === undefined
      ? fileDownloadUrlInput({ fileId: args.fileId })
      : fileDownloadUrlInput({
          fileId: args.fileId,
          rendition: args.rendition,
        });
  return {
    ...contractQueryOptions({
      actionName: GET_DOWNLOAD_URL_ACTION,
      companyId: args.companyId,
      input,
      getActiveCompany: args.getActiveCompany,
      queryFn: () =>
        requireReadyClient(client).client.files.getDownloadUrl(input),
    }),
    staleTime: (query: {
      readonly state: { readonly data: DownloadUrlOutput | undefined };
    }) => downloadUrlStaleTimeMs(query.state.data, Date.now()),
    enabled: client !== null && args.companyId !== null,
  };
}

export function fileDownloadUrlsQueryOptions(args: {
  readonly client: FileDownloadClient | null;
  readonly companyId: string | null;
  readonly fileIds: readonly string[];
  readonly rendition?: CatalogFileRendition;
  readonly getActiveCompany: () => string | null;
}) {
  const client = args.client;
  const input =
    args.rendition === undefined
      ? fileDownloadUrlsInput({ fileIds: args.fileIds })
      : fileDownloadUrlsInput({
          fileIds: args.fileIds,
          rendition: args.rendition,
        });
  return {
    ...contractQueryOptions({
      actionName: GET_DOWNLOAD_URLS_ACTION,
      companyId: args.companyId,
      input,
      getActiveCompany: args.getActiveCompany,
      queryFn: () =>
        requireReadyClient(client).client.files.getDownloadUrls(input),
    }),
    staleTime: (query: {
      readonly state: { readonly data: DownloadUrlsOutput | undefined };
    }) => downloadUrlsStaleTimeMs(query.state.data, Date.now()),
    enabled:
      client !== null && args.companyId !== null && input.fileIds.length > 0,
  };
}
