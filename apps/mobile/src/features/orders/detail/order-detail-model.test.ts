import { describe, expect, it } from "vitest";

import { ordersCopy } from "../../../i18n/orders";
import type { GetOrderOutput } from "../api/order-detail-query";
import { UNLINKED_CUSTOMER_NAME_SNAPSHOT } from "../shared/customer-name";
import { orderThumbnailView } from "../shared/order-thumbnails";
import {
  catalogPrimaryImageFileId,
  commentIfPresent,
  formatOrderNumber,
  formatQuantityMilli,
  mapOrderWriteFailure,
  orderDetailActionsForView,
  orderDetailCompleteLoading,
  orderDetailConfirmLoading,
  orderDetailHeaderSubtitle,
  orderDetailHeaderTitle,
  orderDetailShowsPhoneIcon,
  orderDetailStartLoading,
  orderDetailWriteChrome,
  orderLineCatalogImages,
  orderLineThumbnailFileId,
  orderWriteBanner,
  planOrderStatusWrite,
  reuseOrderLineCatalogImages,
  toOrderDetailView,
  uniqueOrderLineProductIds,
  withOrderLineThumbnails,
} from "./order-detail-model";

const ORDER_ID = "0f0e2d5c-4a1b-4c3d-9e8f-102938475601";
const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";
const PRODUCT_ID = "33333333-3333-4333-8333-333333333333";

const LINE = {
  itemId: ITEM_ID,
  productId: PRODUCT_ID,
  variantId: null,
  titleSnapshot: "Торт «Київський»",
  quantityMilli: "2000",
  unitPriceMinor: "125000",
  discountKind: "none" as const,
  discountValue: "0",
  discountAmountMinor: "0",
  taxTreatment: "exempt" as const,
  taxRateBp: 0,
  taxAmountMinor: "0",
  netAmountMinor: "250000",
  grossAmountMinor: "250000",
  currency: "UAH",
  priceSource: "base" as const,
  personalPriceId: null,
  priceListId: null,
  priceListEntryId: null,
  resolverVersion: 1,
};

function order(overrides: Partial<GetOrderOutput> = {}): GetOrderOutput {
  return {
    orderId: ORDER_ID,
    orderNumber: "KA-K7X2",
    customer: { nameSnapshot: "Олена Коваль", linkedCustomerId: CUSTOMER_ID },
    status: "new",
    comment: "Без горіхів",
    totalNetMinor: "250000",
    totalTaxMinor: "0",
    totalGrossMinor: "250000",
    currency: "UAH",
    confirmedAt: null,
    createdAt: "2026-08-25T12:00:00.000Z",
    items: [LINE],
    ...overrides,
  };
}

describe("formatQuantityMilli", () => {
  it("formats scale-3 milli as a decimal with trailing zeros omitted", () => {
    expect(formatQuantityMilli("1000")).toBe("1");
    expect(formatQuantityMilli("1500")).toBe("1,5");
    expect(formatQuantityMilli("1050")).toBe("1,05");
    expect(formatQuantityMilli("1001")).toBe("1,001");
    expect(formatQuantityMilli("500")).toBe("0,5");
  });

  it("rejects a non-canonical quantity wire value", () => {
    expect(() => formatQuantityMilli("0")).toThrow();
    expect(() => formatQuantityMilli("01")).toThrow();
    expect(() => formatQuantityMilli("1.5")).toThrow();
  });
});

describe("toOrderDetailView", () => {
  const copy = ordersCopy("uk");

  it("maps status pill, snapshot lines, comment, and due from totalGrossMinor", () => {
    const view = toOrderDetailView({
      order: order(),
      copy,
      customerPhone: " +380501112233 ",
    });
    expect(view.status).toBe("new");
    expect(view.statusLabel).toBe("Нове");
    expect(view.statusTone).toBe("action");
    expect(view.comment).toBe("Без горіхів");
    expect(view.dueLabel).toBe("2\u00A0500\u00A0₴");
    expect(view.orderNumber).toBe("KA-K7X2");
    expect(view.lines).toEqual([
      {
        itemId: ITEM_ID,
        productId: PRODUCT_ID,
        title: "Торт «Київський»",
        metaLabel: "1\u00A0250\u00A0₴ \u00D7 2",
        grossLabel: "2\u00A0500\u00A0₴",
        thumbnailFileId: null,
        thumbnailUrl: null,
        thumbnailFailed: false,
      },
    ]);
    expect(view.customerName).toBe("Олена Коваль");
    expect(view.customerPhone).toBe("+380501112233");
    expect(view.showPhoneIcon).toBe(true);
    expect(JSON.stringify(view)).not.toContain("SHZ-");
    expect(JSON.stringify(view)).not.toContain("basePriceMinor");
    expect(JSON.stringify(view.lines)).not.toContain("https://");
  });

  it("maps confirmed, in_progress, done, and canceled pills and hides empty comments", () => {
    const confirmed = toOrderDetailView({
      order: order({ status: "confirmed", comment: "   " }),
      copy,
      customerPhone: null,
    });
    expect(confirmed.statusLabel).toBe("Підтверджено");
    expect(confirmed.statusTone).toBe("focus");
    expect(confirmed.comment).toBeNull();
    expect(confirmed.customerPhone).toBeNull();
    expect(confirmed.showPhoneIcon).toBe(false);

    const inProgress = toOrderDetailView({
      order: order({ status: "in_progress", comment: null }),
      copy,
      customerPhone: null,
    });
    expect(inProgress.statusLabel).toBe("В роботі");
    expect(inProgress.statusTone).toBe("attention");

    const done = toOrderDetailView({
      order: order({ status: "done", comment: null }),
      copy,
      customerPhone: null,
    });
    expect(done.statusLabel).toBe("Виконано");
    expect(done.statusTone).toBe("success");

    const canceled = toOrderDetailView({
      order: order({
        status: "canceled",
        comment: null,
        customer: {
          nameSnapshot: UNLINKED_CUSTOMER_NAME_SNAPSHOT,
          linkedCustomerId: null,
        },
      }),
      copy,
      customerPhone: "",
    });
    expect(canceled.statusLabel).toBe("Скасовано");
    expect(canceled.statusTone).toBe("danger");
    expect(canceled.customerName).toBe(copy.missingCustomer);
    expect(canceled.comment).toBeNull();
    expect(canceled.showPhoneIcon).toBe(false);
  });

  it("keeps snapshot unit/gross even when they would not match a live unit × qty", () => {
    const view = toOrderDetailView({
      order: order({
        totalGrossMinor: "100",
        items: [
          {
            ...LINE,
            quantityMilli: "1000",
            unitPriceMinor: "999",
            netAmountMinor: "100",
            grossAmountMinor: "100",
          },
        ],
      }),
      copy,
      customerPhone: null,
    });
    expect(view.lines[0]?.metaLabel).toBe("9,99\u00A0₴ \u00D7 1");
    expect(view.lines[0]?.grossLabel).toBe("1\u00A0₴");
    expect(view.dueLabel).toBe("1\u00A0₴");
  });
});

describe("orderDetailHeaderTitle", () => {
  it("uses # plus the order number, not the UUID or customer name", () => {
    expect(
      orderDetailHeaderTitle({
        orderNumber: "KA-K7X2",
        fallbackTitle: "Замовлення",
      }),
    ).toBe("#KA-K7X2");
    expect(formatOrderNumber("KA-K7X2")).toBe("#KA-K7X2");
    expect(
      orderDetailHeaderTitle({
        orderNumber: null,
        fallbackTitle: "Замовлення",
      }),
    ).toBe("Замовлення");
    expect(
      orderDetailHeaderTitle({
        orderNumber: "KA-K7X2",
        fallbackTitle: "Замовлення",
      }),
    ).not.toBe(ORDER_ID);
  });
});

describe("orderDetailHeaderSubtitle", () => {
  it("uses the order name snapshot, or the missing-customer copy", () => {
    expect(
      orderDetailHeaderSubtitle({
        nameSnapshot: "Олена Коваль",
        missingCustomer: "Клієнт видалений",
      }),
    ).toBe("Олена Коваль");
    expect(
      orderDetailHeaderSubtitle({
        nameSnapshot: UNLINKED_CUSTOMER_NAME_SNAPSHOT,
        missingCustomer: "Клієнт видалений",
      }),
    ).toBe("Клієнт видалений");
    expect(
      orderDetailHeaderSubtitle({
        nameSnapshot: null,
        missingCustomer: "Клієнт видалений",
      }),
    ).toBe("");
  });
});

describe("orderDetailShowsPhoneIcon", () => {
  it("is visible only when a phone number is present", () => {
    expect(orderDetailShowsPhoneIcon("+380501112233")).toBe(true);
    expect(orderDetailShowsPhoneIcon(" +380501112233 ")).toBe(true);
    expect(orderDetailShowsPhoneIcon(null)).toBe(false);
    expect(orderDetailShowsPhoneIcon("")).toBe(false);
    expect(orderDetailShowsPhoneIcon("   ")).toBe(false);
  });
});

describe("line thumbnails", () => {
  const FILE_A = "44444444-4444-4444-8444-444444444444";
  const FILE_B = "66666666-6666-4666-8666-666666666666";
  const PRODUCT_B = "55555555-5555-4555-8555-555555555555";

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
      order: order(),
      copy: ordersCopy("uk"),
      customerPhone: null,
    });
    expect(snapshot.lines[0]?.thumbnailFileId).toBeNull();
    expect(snapshot.showPhoneIcon).toBe(false);

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
    expect(
      orderThumbnailView({
        fileId: skipped,
        url: "https://example.test/a",
        downloadFailed: false,
      }),
    ).toEqual({ fileId: null, url: null, failed: false });
    expect(orderLineThumbnailFileId(true, FILE_A)).toBe(FILE_A);
    expect(orderLineThumbnailFileId(true, null)).toBeNull();
  });
});

describe("orderDetailActionsForView", () => {
  const hiddenWrites = {
    showConfirm: false,
    showStart: false,
    showComplete: false,
    showActions: false,
    cancelEnabled: false,
  };

  it("shows one primary CTA per open status", () => {
    expect(orderDetailActionsForView({ canEdit: true, status: "new" })).toEqual(
      {
        showConfirm: true,
        showStart: false,
        showComplete: false,
        showActions: true,
        cancelEnabled: true,
      },
    );
    expect(
      orderDetailActionsForView({ canEdit: true, status: "confirmed" }),
    ).toEqual({
      showConfirm: false,
      showStart: true,
      showComplete: false,
      showActions: true,
      cancelEnabled: true,
    });
    expect(
      orderDetailActionsForView({ canEdit: true, status: "in_progress" }),
    ).toEqual({
      showConfirm: false,
      showStart: false,
      showComplete: true,
      showActions: true,
      cancelEnabled: true,
    });
  });

  it("hides the primary CTA and disables cancel on terminal statuses", () => {
    expect(
      orderDetailActionsForView({ canEdit: true, status: "done" }),
    ).toEqual({
      showConfirm: false,
      showStart: false,
      showComplete: false,
      showActions: true,
      cancelEnabled: false,
    });
    expect(
      orderDetailActionsForView({ canEdit: true, status: "canceled" }),
    ).toEqual({
      showConfirm: false,
      showStart: false,
      showComplete: false,
      showActions: true,
      cancelEnabled: false,
    });
  });

  it("hides every write without edit", () => {
    expect(
      orderDetailActionsForView({ canEdit: false, status: "new" }),
    ).toEqual(hiddenWrites);
    expect(
      orderDetailActionsForView({ canEdit: false, status: "in_progress" }),
    ).toEqual(hiddenWrites);
  });

  it("hides confirm and actions when a cached order is error or offline", () => {
    const actionFlags = orderDetailActionsForView({
      canEdit: true,
      status: "new",
    });
    expect(actionFlags).toEqual({
      showConfirm: true,
      showStart: false,
      showComplete: false,
      showActions: true,
      cancelEnabled: true,
    });
    const cached = { hasOrder: true, actionFlags };
    expect(orderDetailWriteChrome({ stateKind: "error", ...cached })).toEqual(
      hiddenWrites,
    );
    expect(orderDetailWriteChrome({ stateKind: "offline", ...cached })).toEqual(
      hiddenWrites,
    );
    expect(orderDetailWriteChrome({ stateKind: "loading", ...cached })).toEqual(
      hiddenWrites,
    );
    expect(orderDetailWriteChrome({ stateKind: "ready", ...cached })).toEqual(
      actionFlags,
    );
    expect(
      orderDetailWriteChrome({
        stateKind: "ready",
        hasOrder: false,
        actionFlags,
      }),
    ).toEqual(hiddenWrites);
  });
});

describe("orderDetailConfirmLoading", () => {
  const idle = {
    confirmPending: false,
    startPending: false,
    completePending: false,
    cancelPending: false,
  };

  it("does not paint Confirm as loading while other writes are in flight", () => {
    const chrome = orderDetailWriteChrome({
      stateKind: "ready",
      hasOrder: true,
      actionFlags: orderDetailActionsForView({
        canEdit: true,
        status: "new",
      }),
    });
    expect(chrome.showConfirm).toBe(true);
    expect(
      orderDetailConfirmLoading({
        ...idle,
        cancelPending: true,
      }),
    ).toBe(false);
    expect(
      orderDetailConfirmLoading({
        ...idle,
        startPending: true,
        completePending: true,
      }),
    ).toBe(false);
  });

  it("shows Confirm loading only when confirm is in flight", () => {
    expect(
      orderDetailConfirmLoading({
        ...idle,
        confirmPending: true,
      }),
    ).toBe(true);
    expect(orderDetailConfirmLoading(idle)).toBe(false);
  });

  it("keeps start and complete loading on their own attempts", () => {
    expect(
      orderDetailStartLoading({
        ...idle,
        startPending: true,
        confirmPending: true,
      }),
    ).toBe(true);
    expect(
      orderDetailStartLoading({
        ...idle,
        confirmPending: true,
      }),
    ).toBe(false);
    expect(
      orderDetailCompleteLoading({
        ...idle,
        completePending: true,
        startPending: true,
      }),
    ).toBe(true);
    expect(
      orderDetailCompleteLoading({
        ...idle,
        startPending: true,
      }),
    ).toBe(false);
  });
});

describe("commentIfPresent", () => {
  it("treats blank comments as absent", () => {
    expect(commentIfPresent(null)).toBeNull();
    expect(commentIfPresent("  ")).toBeNull();
    expect(commentIfPresent("Нотатка")).toBe("Нотатка");
  });
});

describe("order write banners", () => {
  const copy = ordersCopy("uk").detail;

  it("maps offline, permission, and other failures", () => {
    expect(mapOrderWriteFailure(null)).toBeNull();
    expect(mapOrderWriteFailure("offline")).toBe("offline");
    expect(mapOrderWriteFailure("permission")).toBe("permission");
    expect(mapOrderWriteFailure("conflict")).toBe("error");
    expect(orderWriteBanner("offline", copy)).toBe(copy.mutationOffline);
    expect(orderWriteBanner("permission", copy)).toBe(copy.mutationPermission);
    expect(orderWriteBanner("error", copy)).toBe(copy.mutationError);
  });

  it("retries a failed write and submits a fresh one otherwise", () => {
    expect(planOrderStatusWrite(true)).toBe("retry");
    expect(planOrderStatusWrite(false)).toBe("submit");
  });
});
