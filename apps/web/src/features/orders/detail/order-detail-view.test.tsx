/**
 * Order detail view affordances (SHO-378). Permission hide is proven
 * here because every seeded staff role holds `orders:edit`.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ordersCopy } from "../../../i18n/orders";
import {
  ANNA_CUSTOMER,
  ANNA_ORDER_DETAIL,
  ROSE_FILE_ID,
  ROSE_PRODUCT_ID,
  ROSE_THUMB_URL,
} from "../../../test/orders-fixtures";
import type { GetOrderOutput } from "../api/get";
import { OrderDetailView } from "./order-detail-view";
import {
  toOrderDetailView,
  withOrderLineThumbnails,
} from "./order-detail.presenter";

const copy = ordersCopy("uk");

const ORDER: GetOrderOutput = {
  ...ANNA_ORDER_DETAIL,
  items: ANNA_ORDER_DETAIL.items.map((item) => ({ ...item })),
};

const VIEW = toOrderDetailView({
  order: ORDER,
  copy,
  customerPhone: ANNA_CUSTOMER.phone,
});

const NOOP = (): void => undefined;

afterEach(cleanup);

const HIDDEN_WRITES = {
  showConfirm: false,
  showStart: false,
  showComplete: false,
  showActions: false,
  cancelEnabled: false,
} as const;

function renderDetail(
  flags: {
    readonly showConfirm: boolean;
    readonly showStart: boolean;
    readonly showComplete: boolean;
    readonly showActions: boolean;
    readonly cancelEnabled: boolean;
  } = {
    showConfirm: true,
    showStart: false,
    showComplete: false,
    showActions: true,
    cancelEnabled: true,
  },
): void {
  render(
    <OrderDetailView
      copy={copy}
      state={{ kind: "ready" }}
      order={VIEW}
      headerTitle="#KL-K7K3K4"
      showBack={false}
      onBack={NOOP}
      showConfirm={flags.showConfirm}
      showStart={flags.showStart}
      showComplete={flags.showComplete}
      showActions={flags.showActions}
      cancelEnabled={flags.cancelEnabled}
      confirmPending={false}
      startPending={false}
      completePending={false}
      cancelPending={false}
      statusBanner={null}
      onRetry={NOOP}
      onConfirm={NOOP}
      onStart={NOOP}
      onComplete={NOOP}
      onCancel={NOOP}
    />,
  );
}

describe("OrderDetailView (SHO-378)", () => {
  it("hides every write when orders:edit is not granted", () => {
    renderDetail(HIDDEN_WRITES);
    expect(screen.queryByRole("button", { name: "Підтвердити" })).toBeNull();
    expect(screen.queryByRole("button", { name: "В роботу" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Виконано" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: copy.detail.actionsLabel }),
    ).toBeNull();
    expect(screen.queryByText("Виставити документ")).toBeNull();
    expect(screen.queryByText("Issue document")).toBeNull();
  });

  it("shows the confirm CTA and cancel menu on an open new order", () => {
    renderDetail();
    expect(screen.getByRole("button", { name: "Підтвердити" })).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", { name: copy.detail.actionsLabel }),
    );
    expect(
      screen.getByRole("menuitem", { name: "Скасувати замовлення" }),
    ).toBeDefined();
    expect(screen.queryByText("Виставити документ")).toBeNull();
  });

  it("renders the phone as text without a tel: link", () => {
    renderDetail(HIDDEN_WRITES);
    expect(screen.getByText("+380671112233")).toBeDefined();
    expect(document.querySelector('a[href^="tel:"]')).toBeNull();
    expect(screen.queryByRole("link", { name: "+380671112233" })).toBeNull();
  });

  it("renders a package placeholder when the line has no catalog photo", () => {
    renderDetail(HIDDEN_WRITES);
    expect(document.querySelector("img")).toBeNull();
    expect(
      screen.queryByLabelText(copy.detail.thumbnailUnavailable),
    ).toBeNull();
  });

  it("renders the signed thumb URL when the catalog join succeeds", () => {
    const withThumb = {
      ...VIEW,
      lines: withOrderLineThumbnails(
        VIEW.lines,
        new Map([
          [
            ROSE_PRODUCT_ID,
            {
              fileId: ROSE_FILE_ID,
              url: ROSE_THUMB_URL,
              failed: false,
            },
          ],
        ]),
      ),
    };
    render(
      <OrderDetailView
        copy={copy}
        state={{ kind: "ready" }}
        order={withThumb}
        headerTitle="#KL-K7K3K4"
        showBack={false}
        onBack={NOOP}
        showConfirm={false}
        showStart={false}
        showComplete={false}
        showActions={false}
        cancelEnabled={false}
        confirmPending={false}
        startPending={false}
        completePending={false}
        cancelPending={false}
        statusBanner={null}
        onRetry={NOOP}
        onConfirm={NOOP}
        onStart={NOOP}
        onComplete={NOOP}
        onCancel={NOOP}
      />,
    );
    const img = document.querySelector(`img[data-file-id="${ROSE_FILE_ID}"]`);
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe(ROSE_THUMB_URL);
    expect(img?.getAttribute("alt")).toBe("");
  });
});
