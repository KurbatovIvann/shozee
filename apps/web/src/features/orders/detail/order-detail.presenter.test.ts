import { UNLINKED_CUSTOMER_NAME_SNAPSHOT } from "@showzy/contract";
import { describe, expect, it } from "vitest";

import { ordersCopy } from "../../../i18n/orders";
import type { GetOrderOutput } from "../api/get";
import { orderDetailActions } from "../shared/order-permissions";
import {
  catalogPrimaryImageFileId,
  commentIfPresent,
  formatOrderNumber,
  mapOrderWriteFailure,
  orderDetailWriteChrome,
  orderLineCatalogImages,
  orderLineThumbnailFileId,
  orderWriteBanner,
  planOrderStatusWrite,
  reuseOrderLineCatalogImages,
  toOrderDetailView,
  uniqueOrderLineProductIds,
  withOrderLineThumbnails,
} from "./order-detail.presenter";

const ORDER: GetOrderOutput = {
  orderId: "11111111-1111-4111-8111-111111111111",
  orderNumber: "KL-K7K3K4",
  customer: {
    nameSnapshot: "Анна Мельник",
    linkedCustomerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  },
  status: "new",
  comment: "  Packed separately  ",
  totalNetMinor: "150000",
  totalTaxMinor: "0",
  totalGrossMinor: "150000",
  currency: "UAH",
  confirmedAt: null,
  createdAt: "2026-03-15T12:00:00.000Z",
  items: [
    {
      itemId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      productId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      variantId: null,
      titleSnapshot: "Троянди",
      quantityMilli: "3000",
      unitPriceMinor: "50000",
      discountKind: "none",
      discountValue: "0",
      discountAmountMinor: "0",
      taxTreatment: "exempt",
      taxRateBp: 0,
      taxAmountMinor: "0",
      netAmountMinor: "150000",
      grossAmountMinor: "150000",
      currency: "UAH",
      priceSource: "base",
      personalPriceId: null,
      priceListId: null,
      priceListEntryId: null,
      resolverVersion: 1,
    },
  ],
};

describe("order detail presenter (SHO-378)", () => {
  it("formats #PREFIX-TOKEN, snapshot lines, and comment without repricing", () => {
    const copy = ordersCopy("uk");
    const view = toOrderDetailView({
      order: ORDER,
      copy,
      customerPhone: "  +380671112233  ",
    });
    expect(formatOrderNumber(view.orderNumber)).toBe("#KL-K7K3K4");
    expect(view.customerName).toBe("Анна Мельник");
    expect(view.status).toBe("new");
    expect(view.statusLabel).toBe("Нове");
    expect(view.statusTone).toBe("action");
    expect(view.comment).toBe("Packed separately");
    expect(view.lines).toHaveLength(1);
    expect(view.lines[0]?.title).toBe("Троянди");
    expect(view.lines[0]?.metaLabel).toContain("\u00D7");
    expect(view.lines[0]?.metaLabel).toContain("3");
    expect(view.showPhoneIcon).toBe(true);
    expect(view.customerPhone).toBe("+380671112233");
    expect(view.dueLabel).toContain("₴");
  });

  it("drops blank comments and phones", () => {
    expect(commentIfPresent("   ")).toBeNull();
    expect(commentIfPresent(null)).toBeNull();
    const copy = ordersCopy("uk");
    const view = toOrderDetailView({
      order: { ...ORDER, comment: "   " },
      copy,
      customerPhone: "  ",
    });
    expect(view.comment).toBeNull();
    expect(view.showPhoneIcon).toBe(false);
  });

  it("names the customer from the order snapshot, not the linked record", () => {
    const view = toOrderDetailView({
      order: {
        ...ORDER,
        customer: {
          nameSnapshot: "Анна Коваль",
          linkedCustomerId: ORDER.customer.linkedCustomerId,
        },
      },
      copy: ordersCopy("uk"),
      customerPhone: "+380671112233",
    });
    expect(view.customerName).toBe("Анна Коваль");
  });

  it("localizes the unlinked snapshot sentinel", () => {
    const view = toOrderDetailView({
      order: {
        ...ORDER,
        customer: {
          nameSnapshot: UNLINKED_CUSTOMER_NAME_SNAPSHOT,
          linkedCustomerId: null,
        },
      },
      copy: ordersCopy("uk"),
      customerPhone: null,
    });
    expect(view.customerName).toBe("Клієнт видалений");
  });

  it("hides write chrome until the get is ready", () => {
    const flags = orderDetailActions({ canEdit: true, status: "new" });
    expect(
      orderDetailWriteChrome({
        stateKind: "loading",
        hasOrder: false,
        actionFlags: flags,
      }).showConfirm,
    ).toBe(false);
    expect(
      orderDetailWriteChrome({
        stateKind: "ready",
        hasOrder: true,
        actionFlags: flags,
      }).showConfirm,
    ).toBe(true);
  });

  it("maps write failures by kind, never message text", () => {
    const copy = ordersCopy("uk").detail;
    expect(mapOrderWriteFailure("permission")).toBe("permission");
    expect(mapOrderWriteFailure("network")).toBe("offline");
    expect(mapOrderWriteFailure("offline")).toBe("offline");
    expect(mapOrderWriteFailure("conflict")).toBe("error");
    expect(mapOrderWriteFailure("confirmation")).toBeNull();
    expect(orderWriteBanner("permission", copy)).toBe(copy.mutationPermission);
    expect(orderWriteBanner("offline", copy)).toBe(copy.mutationOffline);
    expect(orderWriteBanner("error", copy)).toBe(copy.mutationError);
    expect(planOrderStatusWrite(true)).toBe("retry");
    expect(planOrderStatusWrite(false)).toBe("submit");
  });
});

describe("line thumbnails", () => {
  const FILE_A = "44444444-4444-4444-8444-444444444444";
  const FILE_B = "66666666-6666-4666-8666-666666666666";
  const PRODUCT_B = "55555555-5555-4555-8555-555555555555";
  const PRODUCT_ID = ORDER.items[0]?.productId ?? "";

  it("keeps first-seen unique product ids", () => {
    expect(
      uniqueOrderLineProductIds([
        { productId: PRODUCT_ID },
        { productId: PRODUCT_B },
        { productId: PRODUCT_ID },
      ]),
    ).toEqual([PRODUCT_ID, PRODUCT_B]);
  });

  it("maps a catalog primary file id vs an empty placeholder", () => {
    expect(catalogPrimaryImageFileId([FILE_A, PRODUCT_B])).toBe(FILE_A);
    expect(catalogPrimaryImageFileId([])).toBeNull();
    expect(catalogPrimaryImageFileId(undefined)).toBeNull();

    const snapshot = toOrderDetailView({
      order: ORDER,
      copy: ordersCopy("uk"),
      customerPhone: null,
    });
    expect(snapshot.lines[0]?.productId).toBe(PRODUCT_ID);
    expect(snapshot.lines[0]?.thumbnailFileId).toBeNull();

    const withFile = withOrderLineThumbnails(
      snapshot.lines,
      new Map([
        [
          PRODUCT_ID,
          {
            fileId: FILE_A,
            url: "https://example.test/a",
            failed: false,
          },
        ],
      ]),
    );
    expect(withFile[0]?.thumbnailFileId).toBe(FILE_A);
    expect(withFile[0]?.thumbnailUrl).toBe("https://example.test/a");
    expect(withFile[0]?.thumbnailFailed).toBe(false);

    const placeholder = withOrderLineThumbnails(snapshot.lines, new Map());
    expect(placeholder[0]?.thumbnailFileId).toBeNull();
    expect(placeholder[0]?.thumbnailUrl).toBeNull();
    expect(placeholder[0]?.thumbnailFailed).toBe(false);
  });

  it("joins catalog imageFileIds onto product ids and reuses the items array", () => {
    const imageFileIds = [FILE_A];
    const first = orderLineCatalogImages(
      [PRODUCT_ID, PRODUCT_B],
      [imageFileIds, undefined],
    );
    expect(first).toEqual([
      { productId: PRODUCT_ID, primaryImageFileId: FILE_A },
      { productId: PRODUCT_B, primaryImageFileId: null },
    ]);
    const second = orderLineCatalogImages(
      [PRODUCT_ID, PRODUCT_B],
      [imageFileIds, []],
    );
    expect(reuseOrderLineCatalogImages(first, second)).toBe(first);
    expect(
      reuseOrderLineCatalogImages(first, [
        { productId: PRODUCT_ID, primaryImageFileId: FILE_B },
        { productId: PRODUCT_B, primaryImageFileId: null },
      ]),
    ).not.toBe(first);
  });

  it("skips a catalog file id without files:view so fileId and url stay null", () => {
    const skipped = orderLineThumbnailFileId(false, FILE_A);
    expect(skipped).toBeNull();
    expect(orderLineThumbnailFileId(true, FILE_A)).toBe(FILE_A);
    expect(orderLineThumbnailFileId(true, null)).toBeNull();
  });
});
