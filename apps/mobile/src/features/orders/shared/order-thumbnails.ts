/**
 * Batched order thumbnails (SHO-242). Download URLs come from
 * `apps/mobile/src/api/file-download-query.ts`. Copied from the catalog
 * list pattern so orders does not import `features/catalog`. Signed URLs
 * stay in the in-memory query cache only.
 */

/** First-seen unique `primaryImageFileId` values for one list page. */
export type DraftLineThumbnailItem = {
  readonly productId: string;
  readonly primaryImageFileId: string | null;
};

export function draftLineThumbnailItems(
  draftProductIds: readonly string[],
  catalogProductIds: readonly string[],
  imageFileIdsByIndex: ReadonlyArray<readonly string[] | undefined>,
): readonly DraftLineThumbnailItem[] {
  return draftProductIds.map((productId) => {
    const index = catalogProductIds.indexOf(productId);
    const imageFileIds = index < 0 ? undefined : imageFileIdsByIndex[index];
    return {
      productId,
      primaryImageFileId: imageFileIds?.[0] ?? null,
    };
  });
}

export function uniquePrimaryImageFileIds(
  items: ReadonlyArray<{ readonly primaryImageFileId: string | null }>,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const fileId = item.primaryImageFileId;
    if (fileId === null || seen.has(fileId)) {
      continue;
    }
    seen.add(fileId);
    ids.push(fileId);
  }
  return ids;
}

export function mergeDownloadUrlPages(
  pages: ReadonlyArray<
    | {
        readonly files: ReadonlyArray<{
          readonly fileId: string;
          readonly downloadUrl: string;
        }>;
      }
    | undefined
  >,
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const page of pages) {
    if (page === undefined) {
      continue;
    }
    for (const file of page.files) {
      map.set(file.fileId, file.downloadUrl);
    }
  }
  return map;
}

export function stringMapsEqual(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [key, value] of right) {
    if (left.get(key) !== value) {
      return false;
    }
  }
  return true;
}

export function stringSetsEqual(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const value of right) {
    if (!left.has(value)) {
      return false;
    }
  }
  return true;
}

/** Keep the previous Map when contents match so downstream memos can bail. */
export function retainStringMap(
  previous: ReadonlyMap<string, string> | undefined,
  next: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  if (previous !== undefined && stringMapsEqual(previous, next)) {
    return previous;
  }
  return next;
}

/** Keep the previous Set when contents match so downstream memos can bail. */
export function retainStringSet(
  previous: ReadonlySet<string> | undefined,
  next: ReadonlySet<string>,
): ReadonlySet<string> {
  if (previous !== undefined && stringSetsEqual(previous, next)) {
    return previous;
  }
  return next;
}

/** Primary image ids on pages whose `getDownloadUrls` query failed. */
export function failedPrimaryImageFileIds(
  pages: ReadonlyArray<{
    readonly items: ReadonlyArray<{
      readonly primaryImageFileId: string | null;
    }>;
  }>,
  queryFailed: readonly boolean[],
): ReadonlySet<string> {
  const failed = new Set<string>();
  for (let index = 0; index < pages.length; index += 1) {
    if (queryFailed[index] !== true) {
      continue;
    }
    const page = pages[index];
    if (page === undefined) {
      continue;
    }
    for (const id of uniquePrimaryImageFileIds(page.items)) {
      failed.add(id);
    }
  }
  return failed;
}

/**
 * Thumbnail path. A download-query error is `failed`, not
 * "success with an empty URL" (package placeholder).
 */
export function resolveOrderThumbnail(args: {
  readonly fileId: string | null;
  readonly url: string | undefined;
  readonly downloadFailed: boolean;
}):
  | { readonly kind: "empty" }
  | { readonly kind: "failed" }
  | { readonly kind: "ready"; readonly url: string } {
  if (args.fileId === null) {
    return { kind: "empty" };
  }
  if (args.url !== undefined && args.url.length > 0) {
    return { kind: "ready", url: args.url };
  }
  if (args.downloadFailed) {
    return { kind: "failed" };
  }
  return { kind: "empty" };
}

export function orderThumbnailView(args: {
  readonly fileId: string | null;
  readonly url: string | undefined;
  readonly downloadFailed: boolean;
}): {
  readonly fileId: string | null;
  readonly url: string | null;
  readonly failed: boolean;
} {
  const presentation = resolveOrderThumbnail(args);
  return {
    fileId: args.fileId,
    url: presentation.kind === "ready" ? presentation.url : null,
    failed: presentation.kind === "failed",
  };
}

export type OrderThumbnailView = ReturnType<typeof orderThumbnailView>;

export const EMPTY_ORDER_THUMBNAIL: OrderThumbnailView = {
  fileId: null,
  url: null,
  failed: false,
};
