/**
 * Pure view-model logic for the web order detail (SHO-378). Line prices
 * are snapshots from `orders.get` — never client reprice.
 */
import type { QueryFailureKind } from "../../../api/errors";
import type { OrdersCopy, OrdersDetailCopy } from "../../../i18n/orders";
import type { GetOrderOutput } from "../api/get";
import type { OrderQueryLoadState } from "../shared/classify-order-load";
import { localizeCustomerNameSnapshot } from "../shared/customer-name";
import {
  formatOrderMoney,
  formatOrderQuantityMilli,
} from "../shared/format-order-money";
import type { OrderDetailActions } from "../shared/order-permissions";
import {
  orderStatusTone,
  type OrderLifecycleStatus,
  type OrderStatusTone,
} from "../shared/order-status";
import {
  EMPTY_ORDER_THUMBNAIL,
  type OrderThumbnailView,
} from "../shared/order-thumbnails";

const TIMES = "\u00D7";

export function commentIfPresent(comment: string | null): string | null {
  if (comment === null) {
    return null;
  }
  const trimmed = comment.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function customerPhoneIfPresent(phone: string | null): string | null {
  if (phone === null) {
    return null;
  }
  const trimmed = phone.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Canvas PhoneIcon beside the number — visual only, no `tel:`. */
export function orderDetailShowsPhoneIcon(phone: string | null): boolean {
  return customerPhoneIfPresent(phone) !== null;
}

export function formatOrderNumber(orderNumber: string): string {
  return `#${orderNumber}`;
}

/**
 * First-seen unique `productId` values from order lines so detail can
 * hydrate catalog primary images without a second snapshot field.
 */
export function uniqueOrderLineProductIds(
  items: ReadonlyArray<{ readonly productId: string }>,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.productId)) {
      continue;
    }
    seen.add(item.productId);
    ids.push(item.productId);
  }
  return ids;
}

/**
 * Catalog primary image is the first ordered `imageFileIds` entry
 * (`listProducts.primaryImageFileId`). Empty → package placeholder.
 */
export function catalogPrimaryImageFileId(
  imageFileIds: readonly string[] | undefined,
): string | null {
  if (imageFileIds === undefined || imageFileIds.length === 0) {
    return null;
  }
  return imageFileIds[0] ?? null;
}

export type OrderLineCatalogImage = {
  readonly productId: string;
  readonly primaryImageFileId: string | null;
};

/**
 * Join catalog primary images onto unique line product ids. Pure so the
 * detail thumbnail hook can memoize from `productIds` + `imageFileIds`.
 */
export function orderLineCatalogImages(
  productIds: readonly string[],
  imageFileIdsByIndex: readonly (readonly string[] | undefined)[],
): readonly OrderLineCatalogImage[] {
  return productIds.map((productId, index) => ({
    productId,
    primaryImageFileId: catalogPrimaryImageFileId(imageFileIdsByIndex[index]),
  }));
}

/** Keep the previous items array when productId/fileId pairs did not change. */
export function reuseOrderLineCatalogImages(
  previous: readonly OrderLineCatalogImage[],
  next: readonly OrderLineCatalogImage[],
): readonly OrderLineCatalogImage[] {
  if (previous.length !== next.length) {
    return next;
  }
  for (let index = 0; index < previous.length; index += 1) {
    const left = previous[index];
    const right = next[index];
    if (
      left === undefined ||
      right === undefined ||
      left.productId !== right.productId ||
      left.primaryImageFileId !== right.primaryImageFileId
    ) {
      return next;
    }
  }
  return previous;
}

/**
 * Catalog list join: skip a file id without `files:view` so the row
 * stays a placeholder.
 */
export function orderLineThumbnailFileId(
  canFetch: boolean,
  primaryImageFileId: string | null,
): string | null {
  return canFetch ? primaryImageFileId : null;
}

export type OrderDetailLineView = {
  readonly itemId: string;
  readonly productId: string;
  readonly title: string;
  readonly metaLabel: string;
  readonly grossLabel: string;
  readonly thumbnailFileId: string | null;
  readonly thumbnailUrl: string | null;
  readonly thumbnailFailed: boolean;
};

export function withOrderLineThumbnails(
  lines: readonly OrderDetailLineView[],
  thumbnailsByProductId: ReadonlyMap<string, OrderThumbnailView>,
): readonly OrderDetailLineView[] {
  return lines.map((line) => {
    const thumbnail =
      thumbnailsByProductId.get(line.productId) ?? EMPTY_ORDER_THUMBNAIL;
    return {
      ...line,
      thumbnailFileId: thumbnail.fileId,
      thumbnailUrl: thumbnail.url,
      thumbnailFailed: thumbnail.failed,
    };
  });
}

export type OrderDetailViewModel = {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly status: OrderLifecycleStatus;
  readonly statusLabel: string;
  readonly statusTone: OrderStatusTone;
  readonly comment: string | null;
  readonly dueLabel: string;
  readonly lines: readonly OrderDetailLineView[];
  readonly customerName: string;
  readonly customerPhone: string | null;
  readonly showPhoneIcon: boolean;
};

export function toOrderDetailView(args: {
  readonly order: GetOrderOutput;
  readonly copy: OrdersCopy;
  readonly customerPhone: string | null;
}): OrderDetailViewModel {
  const customerPhone = customerPhoneIfPresent(args.customerPhone);
  return {
    orderId: args.order.orderId,
    orderNumber: args.order.orderNumber,
    status: args.order.status,
    statusLabel: args.copy.statuses[args.order.status],
    statusTone: orderStatusTone(args.order.status),
    comment: commentIfPresent(args.order.comment),
    dueLabel: formatOrderMoney(args.order.totalGrossMinor, args.order.currency),
    lines: args.order.items.map((item) => {
      const unitLabel = formatOrderMoney(item.unitPriceMinor, item.currency);
      const qtyLabel = formatOrderQuantityMilli(item.quantityMilli);
      return {
        itemId: item.itemId,
        productId: item.productId,
        title: item.titleSnapshot,
        metaLabel: `${unitLabel} ${TIMES} ${qtyLabel}`,
        grossLabel: formatOrderMoney(item.grossAmountMinor, item.currency),
        thumbnailFileId: null,
        thumbnailUrl: null,
        thumbnailFailed: false,
      };
    }),
    customerName: localizeCustomerNameSnapshot(
      args.order.customer.nameSnapshot,
      args.copy.missingCustomer,
    ),
    customerPhone,
    showPhoneIcon: orderDetailShowsPhoneIcon(customerPhone),
  };
}

export function orderDetailHeaderTitle(args: {
  readonly orderNumber: string | null;
  readonly fallbackTitle: string;
}): string {
  if (args.orderNumber === null) {
    return args.fallbackTitle;
  }
  return formatOrderNumber(args.orderNumber);
}

export function orderDetailWriteChrome(args: {
  readonly stateKind: OrderQueryLoadState["kind"];
  readonly hasOrder: boolean;
  readonly actionFlags: OrderDetailActions;
}): OrderDetailActions {
  const ready = args.stateKind === "ready" && args.hasOrder;
  return {
    showConfirm: ready && args.actionFlags.showConfirm,
    showStart: ready && args.actionFlags.showStart,
    showComplete: ready && args.actionFlags.showComplete,
    showActions: ready && args.actionFlags.showActions,
    cancelEnabled: ready && args.actionFlags.cancelEnabled,
  };
}

export type OrderWriteBannerKey = "offline" | "permission" | "error";

export function mapOrderWriteFailure(
  kind: QueryFailureKind | null,
): OrderWriteBannerKey | null {
  if (kind === null) {
    return null;
  }
  if (kind === "offline" || kind === "network") {
    return "offline";
  }
  if (kind === "permission") {
    return "permission";
  }
  if (kind === "confirmation") {
    return null;
  }
  return "error";
}

export function orderWriteBanner(
  key: OrderWriteBannerKey | null,
  copy: OrdersDetailCopy,
): string | null {
  if (key === null) {
    return null;
  }
  if (key === "offline") {
    return copy.mutationOffline;
  }
  if (key === "permission") {
    return copy.mutationPermission;
  }
  return copy.mutationError;
}

export function planOrderStatusWrite(isError: boolean): "retry" | "submit" {
  return isError ? "retry" : "submit";
}
