/**
 * Orders create (SHO-379). `/rpc` is mocked with MSW — never module
 * internals. Asserts public URL, RHF validation, retry attempt reuse,
 * LeaveDialog, wire errors by `error.code`, and no catalog prices on
 * the create form. Does not parse pathname prefixes.
 */
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { interpolate } from "../../i18n/locale";
import { ordersCopy } from "../../i18n/orders";
import {
  FLOWERS_COMPANY_ID,
  FLOWERS_MEMBERSHIP,
  signedInOwner,
} from "../company-fixtures";
import {
  listMineState,
  PANEL_ORIGIN,
  seedCustomer,
  seedProduct,
  server,
  sessionState,
} from "../msw";
import {
  ANNA_CUSTOMER,
  ANNA_ORDER,
  CREATED_ORDER_ID,
  CREATED_ORDER_NUMBER,
  ROSE_FILE_ID,
  ROSE_PRODUCT,
  ROSE_PRODUCT_WITH_IMAGE,
  ROSE_THUMB_URL,
} from "../orders-fixtures";
import { renderApp } from "../render";

afterEach(cleanup);

class FakeResizeObserver implements ResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }

  observe(): void {}

  unobserve(): void {}

  disconnect(): void {
    FakeResizeObserver.instances = FakeResizeObserver.instances.filter(
      (item) => item !== this,
    );
  }

  takeRecords(): ResizeObserverEntry[] {
    return [];
  }
}

const nativeResizeObserver = globalThis.ResizeObserver;

beforeEach(() => {
  FakeResizeObserver.instances = [];
  globalThis.ResizeObserver = FakeResizeObserver;
});

afterEach(() => {
  globalThis.ResizeObserver = nativeResizeObserver;
  FakeResizeObserver.instances = [];
});

const copy = ordersCopy("uk");

const ZOYA_CUSTOMER = {
  ...ANNA_CUSTOMER,
  id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  name: "Зоя Прихована",
  phone: "+380501112233",
};

const HIDDEN_PRODUCT = {
  ...ROSE_PRODUCT,
  id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  name: "Хризантема Прихована",
};

const CAKE_PRODUCT_ID = "14141414-1414-4141-8141-141414141414";
const CAKE_VARIANT_ID = "15151515-1515-4151-8151-151515151515";
const ARCHIVE_CAKE_ID = "16161616-1616-4161-8161-161616161616";
const ARCHIVE_VARIANT_ID = "17171717-1717-4171-8171-171717171717";

const CAKE_PRODUCT = {
  ...ROSE_PRODUCT,
  id: CAKE_PRODUCT_ID,
  name: "Торт Макарон",
  variantCount: 1,
  variants: [
    {
      id: CAKE_VARIANT_ID,
      name: "Lemon",
      status: "active" as const,
      basePriceMinor: null,
      currency: null,
    },
  ],
};

const ARCHIVE_CAKE_PRODUCT = {
  ...ROSE_PRODUCT,
  id: ARCHIVE_CAKE_ID,
  name: "Архівний торт",
  variantCount: 0,
  variants: [
    {
      id: ARCHIVE_VARIANT_ID,
      name: "Old",
      status: "archived" as const,
      basePriceMinor: null,
      currency: null,
    },
  ],
};

function seedFirstPageCustomers(): void {
  for (let index = 0; index < 50; index += 1) {
    seedCustomer({
      ...ANNA_CUSTOMER,
      id: `aa000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      name: `Клієнт сторінки ${String(index)}`,
      phone: null,
    });
  }
}

function seedFirstPageProducts(): void {
  for (let index = 0; index < 50; index += 1) {
    seedProduct({
      ...ROSE_PRODUCT,
      id: `cc000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      name: `Товар сторінки ${String(index)}`,
    });
  }
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rpcInputString(input: unknown, key: string): string | undefined {
  if (!isJsonRecord(input)) {
    return undefined;
  }
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function signInWithFlowers(): void {
  sessionState.user = signedInOwner();
  listMineState.memberships = [FLOWERS_MEMBERSHIP];
}

function seedCreateLookups(): void {
  listMineState.listOrdersItems = [ANNA_ORDER];
  seedCustomer(ANNA_CUSTOMER);
  seedProduct(ROSE_PRODUCT);
}

function rpcErrorBody(
  code: string,
  status: number,
  message: string,
  data?: unknown,
) {
  const payload: {
    defined: true;
    code: string;
    status: number;
    message: string;
    data?: unknown;
  } = {
    defined: true,
    code,
    status,
    message,
  };
  if (data !== undefined) {
    payload.data = data;
  }
  return HttpResponse.json({ json: payload }, { status });
}

function expectedSimpleCreate(args?: {
  readonly quantityMilli?: string;
  readonly comment?: string;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    customer: { by: "id", id: ANNA_CUSTOMER.id },
    items: [
      {
        product: { by: "id", id: ROSE_PRODUCT.id },
        variantSelection: { kind: "base" },
        quantity: { milli: args?.quantityMilli ?? "1000" },
      },
    ],
  };
  if (args?.comment !== undefined) {
    payload.comment = args.comment;
  }
  return payload;
}

function createCalls(): typeof listMineState.mutationCalls {
  return listMineState.mutationCalls.filter(
    (call) => call.path === "/rpc/orders/create",
  );
}

async function waitForCreateForm(): Promise<HTMLElement> {
  expect(
    await screen.findByRole("heading", { name: copy.create.title }),
  ).toBeDefined();
  const pane = screen.getByRole("region", { name: copy.create.title });
  expect(screen.getByRole("region", { name: "Замовлення" })).toBeDefined();
  expect(
    screen.queryByRole("heading", { name: "Модуль у розробці" }),
  ).toBeNull();
  return pane;
}

function submitCreateForm(): void {
  const submit = screen.getByRole("button", {
    name: copy.create.submitCreate,
  });
  const form = submit.closest("form");
  if (form === null) {
    throw new Error("expected the order create form");
  }
  fireEvent.submit(form);
}

async function pickCustomerAndProduct(): Promise<void> {
  fireEvent.click(
    screen.getByRole("button", { name: copy.create.customerPlaceholder }),
  );
  fireEvent.click(await screen.findByRole("option", { name: /Анна Мельник/ }));
  fireEvent.click(
    screen.getByRole("button", { name: copy.create.addProductsPlaceholder }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: ROSE_PRODUCT.name }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Додати · 1" }));
  expect(await screen.findByText(ROSE_PRODUCT.name)).toBeDefined();
  await waitFor(() => {
    expect(
      listMineState.calls.some(
        (call) => call.path === "/rpc/catalog/getProduct",
      ),
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: copy.create.submitCreate }),
    ).toHaveProperty("disabled", false);
  });
}

describe("orders create (SHO-379)", () => {
  it("creates via orders.create and lands on the detail URL", async () => {
    signInWithFlowers();
    seedCreateLookups();
    const { router } = await renderApp("/kviti-lviv/orders/new");
    const pane = await waitForCreateForm();
    expect(within(pane).queryByText("₴")).toBeNull();
    expect(within(pane).queryByText(/500/)).toBeNull();
    expect(within(pane).queryByText("50,00")).toBeNull();
    await pickCustomerAndProduct();
    submitCreateForm();
    expect(
      await screen.findByRole("heading", { name: `#${CREATED_ORDER_NUMBER}` }),
    ).toBeDefined();
    expect(router.state.location.pathname).toBe(
      `/kviti-lviv/orders/${CREATED_ORDER_ID}`,
    );
    const writes = createCalls();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.companyId).toBe(FLOWERS_COMPANY_ID);
    expect(writes[0]?.idempotencyKey?.length).toBeGreaterThan(0);
    expect(writes[0]?.input).toEqual(expectedSimpleCreate());
    expect(
      listMineState.calls.every(
        (call) => call.path !== "/rpc/pricing/resolveProductPrices",
      ),
    ).toBe(true);
    expect(
      listMineState.calls.every(
        (call) => call.path !== "/rpc/customers/create",
      ),
    ).toBe(true);
    expect(screen.getByRole("region", { name: "Замовлення" })).toBeDefined();
  });

  it("writes a typed line quantity on create", async () => {
    signInWithFlowers();
    seedCreateLookups();
    await renderApp("/kviti-lviv/orders/new");
    await waitForCreateForm();
    await pickCustomerAndProduct();
    const qty = screen.getByRole("textbox", {
      name: interpolate(copy.create.qtyInput, { name: ROSE_PRODUCT.name }),
    });
    fireEvent.change(qty, { target: { value: "4" } });
    fireEvent.blur(qty);
    submitCreateForm();
    expect(
      await screen.findByRole("heading", { name: `#${CREATED_ORDER_NUMBER}` }),
    ).toBeDefined();
    expect(createCalls()[0]?.input).toEqual(
      expectedSimpleCreate({ quantityMilli: "4000" }),
    );
  });

  it("requires a customer and at least one item", async () => {
    signInWithFlowers();
    seedCreateLookups();
    await renderApp("/kviti-lviv/orders/new");
    await waitForCreateForm();
    submitCreateForm();
    await waitFor(() => {
      expect(
        screen.getAllByRole("alert").map((node) => node.textContent),
      ).toEqual(
        expect.arrayContaining([
          copy.create.errors.customerRequired,
          copy.create.errors.itemsRequired,
        ]),
      );
    });
    expect(createCalls()).toHaveLength(0);
  });

  it("retries the same create attempt after a network failure", async () => {
    signInWithFlowers();
    seedCreateLookups();
    listMineState.orderCreateNetworkFailuresRemaining = 1;
    const { router } = await renderApp("/kviti-lviv/orders/new");
    await waitForCreateForm();
    await pickCustomerAndProduct();
    submitCreateForm();
    expect(await screen.findByText(copy.create.errors.network)).toBeDefined();
    expect(createCalls()).toHaveLength(1);
    const firstKey = createCalls()[0]?.idempotencyKey;
    expect(firstKey?.length).toBeGreaterThan(0);
    submitCreateForm();
    expect(
      await screen.findByRole("heading", { name: `#${CREATED_ORDER_NUMBER}` }),
    ).toBeDefined();
    expect(router.state.location.pathname).toBe(
      `/kviti-lviv/orders/${CREATED_ORDER_ID}`,
    );
    const writes = createCalls();
    expect(writes).toHaveLength(2);
    expect(writes[0]?.idempotencyKey).toBe(writes[1]?.idempotencyKey);
    expect(writes[0]?.input).toEqual(writes[1]?.input);
  });

  it("retries the same attempt after a field edit that restores the wire payload", async () => {
    signInWithFlowers();
    seedCreateLookups();
    listMineState.orderCreateNetworkFailuresRemaining = 1;
    const { router } = await renderApp("/kviti-lviv/orders/new");
    await waitForCreateForm();
    await pickCustomerAndProduct();
    submitCreateForm();
    expect(await screen.findByText(copy.create.errors.network)).toBeDefined();
    expect(createCalls()).toHaveLength(1);
    const firstKey = createCalls()[0]?.idempotencyKey;
    expect(firstKey?.length).toBeGreaterThan(0);
    const comment = screen.getByLabelText(copy.create.commentLabel);
    fireEvent.change(comment, { target: { value: "Упакувати окремо" } });
    fireEvent.click(
      screen.getByRole("button", { name: copy.create.qtyIncrease }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: copy.create.qtyDecrease }),
    );
    fireEvent.change(comment, { target: { value: "" } });
    submitCreateForm();
    expect(
      await screen.findByRole("heading", { name: `#${CREATED_ORDER_NUMBER}` }),
    ).toBeDefined();
    expect(router.state.location.pathname).toBe(
      `/kviti-lviv/orders/${CREATED_ORDER_ID}`,
    );
    const writes = createCalls();
    expect(writes).toHaveLength(2);
    expect(writes[0]?.idempotencyKey).toBe(writes[1]?.idempotencyKey);
    expect(writes[0]?.input).toEqual(writes[1]?.input);
    expect(writes[1]?.input).toEqual(expectedSimpleCreate());
  });

  it("mints a new create attempt when the payload changes after a retryable failure", async () => {
    signInWithFlowers();
    seedCreateLookups();
    listMineState.orderCreateNetworkFailuresRemaining = 1;
    const { router } = await renderApp("/kviti-lviv/orders/new");
    await waitForCreateForm();
    await pickCustomerAndProduct();
    submitCreateForm();
    expect(await screen.findByText(copy.create.errors.network)).toBeDefined();
    expect(createCalls()).toHaveLength(1);
    const firstKey = createCalls()[0]?.idempotencyKey;
    expect(firstKey?.length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText(copy.create.commentLabel), {
      target: { value: "Упакувати окремо" },
    });
    submitCreateForm();
    expect(
      await screen.findByRole("heading", { name: `#${CREATED_ORDER_NUMBER}` }),
    ).toBeDefined();
    expect(router.state.location.pathname).toBe(
      `/kviti-lviv/orders/${CREATED_ORDER_ID}`,
    );
    const writes = createCalls();
    expect(writes).toHaveLength(2);
    expect(writes[0]?.idempotencyKey).not.toBe(writes[1]?.idempotencyKey);
    expect(writes[1]?.input).toEqual(
      expectedSimpleCreate({ comment: "Упакувати окремо" }),
    );
  });

  it("asks to leave when the dirty form navigates away", async () => {
    signInWithFlowers();
    seedCreateLookups();
    const { router } = await renderApp("/kviti-lviv/orders/new");
    await waitForCreateForm();
    fireEvent.change(screen.getByLabelText(copy.create.commentLabel), {
      target: { value: "Упакувати окремо" },
    });
    fireEvent.click(screen.getByRole("button", { name: copy.create.cancel }));
    expect(
      await screen.findByRole("dialog", { name: copy.create.leaveTitle }),
    ).toBeDefined();
    expect(router.state.location.pathname).toBe("/kviti-lviv/orders/new");
    fireEvent.click(
      screen.getByRole("button", { name: copy.create.leaveContinue }),
    );
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(router.state.location.pathname).toBe("/kviti-lviv/orders/new");
    fireEvent.click(screen.getByRole("button", { name: copy.create.cancel }));
    expect(
      await screen.findByRole("dialog", { name: copy.create.leaveTitle }),
    ).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", { name: copy.create.leaveConfirm }),
    );
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/kviti-lviv/orders");
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the permission empty state when orders:create is denied", async () => {
    sessionState.user = signedInOwner();
    listMineState.memberships = [
      {
        ...FLOWERS_MEMBERSHIP,
        role: "employee",
        permissions: ["orders:edit", "orders:view"],
      },
    ];
    await renderApp("/kviti-lviv/orders/new");
    expect(
      await screen.findByRole("heading", {
        name: copy.create.permissionTitle,
      }),
    ).toBeDefined();
    expect(screen.getByText(copy.create.permissionDescription)).toBeDefined();
    expect(
      screen.queryByRole("button", { name: copy.create.submitCreate }),
    ).toBeNull();
  });

  it("maps PERMISSION_DENIED by error.code, never error.message", async () => {
    signInWithFlowers();
    seedCreateLookups();
    server.use(
      http.post(`${PANEL_ORIGIN}/rpc/orders/create`, () =>
        rpcErrorBody("PERMISSION_DENIED", 403, "do-not-match-this"),
      ),
    );
    await renderApp("/kviti-lviv/orders/new");
    await waitForCreateForm();
    await pickCustomerAndProduct();
    submitCreateForm();
    expect(
      await screen.findByText(copy.create.errors.permission),
    ).toBeDefined();
    expect(screen.queryByText("do-not-match-this")).toBeNull();
  });

  it("refreshes listMine after PERMISSION_DENIED so stale create hides", async () => {
    signInWithFlowers();
    seedCreateLookups();
    server.use(
      http.post(`${PANEL_ORIGIN}/rpc/orders/create`, () =>
        rpcErrorBody("PERMISSION_DENIED", 403, "do-not-match-this"),
      ),
    );
    await renderApp("/kviti-lviv/orders/new");
    await waitForCreateForm();
    await pickCustomerAndProduct();
    const listMineBefore = listMineState.calls.filter(
      (call) => call.path === "/rpc/companies/listMine",
    ).length;
    listMineState.memberships = [
      {
        ...FLOWERS_MEMBERSHIP,
        role: "employee",
        permissions: ["orders:view"],
      },
    ];
    submitCreateForm();
    expect(
      await screen.findByText(copy.create.errors.permission),
    ).toBeDefined();
    await waitFor(() => {
      expect(
        listMineState.calls.filter(
          (call) => call.path === "/rpc/companies/listMine",
        ).length,
      ).toBeGreaterThan(listMineBefore);
    });
    expect(
      await screen.findByRole("heading", {
        name: copy.create.permissionTitle,
      }),
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: copy.create.submitCreate }),
    ).toBeNull();
  });

  it("maps VALIDATION issues onto fields by path, never by message", async () => {
    signInWithFlowers();
    seedCreateLookups();
    server.use(
      http.post(`${PANEL_ORIGIN}/rpc/orders/create`, () =>
        rpcErrorBody("VALIDATION", 400, "do-not-match-this", {
          issues: [{ code: "too_small", path: ["items"], message: "secret" }],
        }),
      ),
    );
    await renderApp("/kviti-lviv/orders/new");
    await waitForCreateForm();
    await pickCustomerAndProduct();
    submitCreateForm();
    expect(
      await screen.findByText(copy.create.errors.itemsRequired),
    ).toBeDefined();
    expect(screen.queryByText("do-not-match-this")).toBeNull();
    expect(screen.queryByText("secret")).toBeNull();
  });

  it("finds a customer outside the first unfiltered page via listCustomers.search", async () => {
    signInWithFlowers();
    seedFirstPageCustomers();
    seedCustomer(ZOYA_CUSTOMER);
    seedProduct(ROSE_PRODUCT);
    await renderApp("/kviti-lviv/orders/new");
    await waitForCreateForm();
    fireEvent.click(
      screen.getByRole("button", { name: copy.create.customerPlaceholder }),
    );
    expect(
      await screen.findByRole("option", { name: /Клієнт сторінки 0/ }),
    ).toBeDefined();
    expect(screen.queryByRole("option", { name: /Зоя Прихована/ })).toBeNull();
    fireEvent.change(screen.getByLabelText(copy.create.customerSearchLabel), {
      target: { value: "Зоя" },
    });
    expect(
      await screen.findByRole("option", { name: /Зоя Прихована/ }),
    ).toBeDefined();
    expect(
      listMineState.listCustomersCalls.some(
        (call) => rpcInputString(call.input, "search") === "Зоя",
      ),
    ).toBe(true);
  });

  it("shows every customer the server returns for a search, inflected matches included", async () => {
    signInWithFlowers();
    seedCreateLookups();
    server.use(
      http.post(`${PANEL_ORIGIN}/rpc/customers/listCustomers`, () =>
        HttpResponse.json({
          json: { items: [ZOYA_CUSTOMER], nextCursor: null },
        }),
      ),
    );
    await renderApp("/kviti-lviv/orders/new");
    await waitForCreateForm();
    fireEvent.click(
      screen.getByRole("button", { name: copy.create.customerPlaceholder }),
    );
    fireEvent.change(screen.getByLabelText(copy.create.customerSearchLabel), {
      target: { value: "Зої Прихованої" },
    });
    expect(
      await screen.findByRole("option", { name: /Зоя Прихована/ }),
    ).toBeDefined();
  });

  it("finds a product outside the first unfiltered page via listProducts.query", async () => {
    signInWithFlowers();
    seedCustomer(ANNA_CUSTOMER);
    seedFirstPageProducts();
    seedProduct(HIDDEN_PRODUCT);
    await renderApp("/kviti-lviv/orders/new");
    await waitForCreateForm();
    fireEvent.click(
      screen.getByRole("button", { name: copy.create.addProductsPlaceholder }),
    );
    expect(
      await screen.findByRole("button", { name: "Товар сторінки 0" }),
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: HIDDEN_PRODUCT.name }),
    ).toBeNull();
    fireEvent.change(screen.getByLabelText(copy.create.productSearchLabel), {
      target: { value: "Хризантема" },
    });
    expect(
      await screen.findByRole("button", { name: HIDDEN_PRODUCT.name }),
    ).toBeDefined();
    expect(
      listMineState.listProductsCalls.some(
        (call) => rpcInputString(call.input, "query") === "Хризантема",
      ),
    ).toBe(true);
  });

  it("shows a customers.listCustomers error with retry, not empty copy", async () => {
    signInWithFlowers();
    seedCreateLookups();
    let failCustomers = true;
    let listCalls = 0;
    server.use(
      http.post(`${PANEL_ORIGIN}/rpc/customers/listCustomers`, () => {
        listCalls += 1;
        if (failCustomers) {
          return rpcErrorBody("INTERNAL", 500, "secret-list-message");
        }
        return HttpResponse.json({
          json: { items: [ANNA_CUSTOMER], nextCursor: null },
        });
      }),
    );
    await renderApp("/kviti-lviv/orders/new");
    await waitForCreateForm();
    fireEvent.click(
      screen.getByRole("button", { name: copy.create.customerPlaceholder }),
    );
    expect(await screen.findByText(copy.create.customersError)).toBeDefined();
    expect(screen.queryByText(copy.create.emptyCustomers)).toBeNull();
    expect(screen.queryByText("secret-list-message")).toBeNull();
    const beforeRetry = listCalls;
    failCustomers = false;
    fireEvent.click(
      screen.getByRole("button", { name: copy.create.lookupRetry }),
    );
    expect(
      await screen.findByRole("option", { name: /Анна Мельник/ }),
    ).toBeDefined();
    expect(listCalls).toBeGreaterThan(beforeRetry);
  });

  it("shows a catalog.listProducts error with retry, not empty copy", async () => {
    signInWithFlowers();
    seedCreateLookups();
    let failProducts = true;
    let listCalls = 0;
    server.use(
      http.post(`${PANEL_ORIGIN}/rpc/catalog/listProducts`, () => {
        listCalls += 1;
        if (failProducts) {
          return rpcErrorBody("INTERNAL", 500, "secret-list-message");
        }
        return HttpResponse.json({
          json: { items: [ROSE_PRODUCT], nextCursor: null },
        });
      }),
    );
    await renderApp("/kviti-lviv/orders/new");
    await waitForCreateForm();
    fireEvent.click(
      screen.getByRole("button", { name: copy.create.addProductsPlaceholder }),
    );
    expect(await screen.findByText(copy.create.productsError)).toBeDefined();
    expect(screen.queryByText(copy.create.emptyProducts)).toBeNull();
    expect(screen.queryByText("secret-list-message")).toBeNull();
    const beforeRetry = listCalls;
    failProducts = false;
    fireEvent.click(
      screen.getByRole("button", { name: copy.create.lookupRetry }),
    );
    expect(
      await screen.findByRole("button", { name: ROSE_PRODUCT.name }),
    ).toBeDefined();
    expect(listCalls).toBeGreaterThan(beforeRetry);
  });

  it("does not call getDownloadUrls on create without files:view", async () => {
    sessionState.user = signedInOwner();
    listMineState.memberships = [
      {
        ...FLOWERS_MEMBERSHIP,
        role: "employee",
        permissions: ["orders:create", "orders:edit", "orders:view"],
      },
    ];
    listMineState.listOrdersItems = [ANNA_ORDER];
    seedCustomer(ANNA_CUSTOMER);
    seedProduct(ROSE_PRODUCT_WITH_IMAGE);
    await renderApp("/kviti-lviv/orders/new");
    await waitForCreateForm();
    fireEvent.click(
      screen.getByRole("button", { name: copy.create.addProductsPlaceholder }),
    );
    expect(
      await screen.findByRole("button", { name: ROSE_PRODUCT.name }),
    ).toBeDefined();
    expect(listMineState.getDownloadUrlsCalls).toEqual([]);
  });

  it("loads picker thumbs when files:view is granted to a non-owner", async () => {
    sessionState.user = signedInOwner();
    listMineState.memberships = [
      {
        ...FLOWERS_MEMBERSHIP,
        role: "employee",
        permissions: [
          "files:view",
          "orders:create",
          "orders:edit",
          "orders:view",
        ],
      },
    ];
    listMineState.listOrdersItems = [ANNA_ORDER];
    seedCustomer(ANNA_CUSTOMER);
    seedProduct(ROSE_PRODUCT_WITH_IMAGE);
    await renderApp("/kviti-lviv/orders/new");
    await waitForCreateForm();
    await waitFor(() => {
      expect(listMineState.getDownloadUrlsCalls).toHaveLength(1);
    });
    expect(listMineState.getDownloadUrlsCalls[0]?.input).toMatchObject({
      fileIds: [ROSE_FILE_ID],
      rendition: "thumb",
    });
  });

  it("loads picker thumbs via files.getDownloadUrls with rendition thumb", async () => {
    signInWithFlowers();
    listMineState.listOrdersItems = [ANNA_ORDER];
    seedCustomer(ANNA_CUSTOMER);
    seedProduct(ROSE_PRODUCT_WITH_IMAGE);
    await renderApp("/kviti-lviv/orders/new");
    await waitForCreateForm();
    await waitFor(() => {
      expect(listMineState.getDownloadUrlsCalls).toHaveLength(1);
    });
    expect(listMineState.getDownloadUrlsCalls[0]?.input).toMatchObject({
      fileIds: [ROSE_FILE_ID],
      rendition: "thumb",
    });
    expect(listMineState.getDownloadUrlsCalls[0]?.companyId).toBe(
      FLOWERS_COMPANY_ID,
    );
    fireEvent.click(
      screen.getByRole("button", { name: copy.create.addProductsPlaceholder }),
    );
    expect(
      await screen.findByRole("button", { name: ROSE_PRODUCT.name }),
    ).toBeDefined();
    const img = document.querySelector(`img[data-file-id="${ROSE_FILE_ID}"]`);
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe(ROSE_THUMB_URL);
  });

  it("writes variantSelection.reference by id for an active variant and never sends variant", async () => {
    signInWithFlowers();
    listMineState.listOrdersItems = [ANNA_ORDER];
    seedCustomer(ANNA_CUSTOMER);
    seedProduct(CAKE_PRODUCT);
    await renderApp("/kviti-lviv/orders/new");
    await waitForCreateForm();
    fireEvent.click(
      screen.getByRole("button", { name: copy.create.customerPlaceholder }),
    );
    fireEvent.click(
      await screen.findByRole("option", { name: /Анна Мельник/ }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: copy.create.addProductsPlaceholder }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: CAKE_PRODUCT.name }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Lemon" }));
    fireEvent.click(screen.getByRole("button", { name: "Додати · 1" }));
    expect(await screen.findByText(CAKE_PRODUCT.name)).toBeDefined();
    await waitFor(() => {
      expect(
        listMineState.calls.some(
          (call) => call.path === "/rpc/catalog/getProduct",
        ),
      ).toBe(true);
      expect(
        screen.getByRole("button", { name: copy.create.submitCreate }),
      ).toHaveProperty("disabled", false);
    });
    submitCreateForm();
    expect(
      await screen.findByRole("heading", { name: `#${CREATED_ORDER_NUMBER}` }),
    ).toBeDefined();
    const input = createCalls()[0]?.input;
    expect(input).toEqual({
      customer: { by: "id", id: ANNA_CUSTOMER.id },
      items: [
        {
          product: { by: "id", id: CAKE_PRODUCT.id },
          variantSelection: {
            kind: "reference",
            ref: { by: "id", id: CAKE_VARIANT_ID },
          },
          quantity: { milli: "1000" },
        },
      ],
    });
    expect(JSON.stringify(input)).not.toContain('"variant":');
  });

  it("blocks archived-only variable products from submitting as a base line", async () => {
    signInWithFlowers();
    listMineState.listOrdersItems = [ANNA_ORDER];
    seedCustomer(ANNA_CUSTOMER);
    seedProduct(ARCHIVE_CAKE_PRODUCT);
    await renderApp("/kviti-lviv/orders/new");
    await waitForCreateForm();
    fireEvent.click(
      screen.getByRole("button", { name: copy.create.customerPlaceholder }),
    );
    fireEvent.click(
      await screen.findByRole("option", { name: /Анна Мельник/ }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: copy.create.addProductsPlaceholder }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: ARCHIVE_CAKE_PRODUCT.name }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Додати · 1" }));
    expect(await screen.findByText(ARCHIVE_CAKE_PRODUCT.name)).toBeDefined();
    await waitFor(() => {
      expect(
        listMineState.calls.some(
          (call) => call.path === "/rpc/catalog/getProduct",
        ),
      ).toBe(true);
      expect(
        screen.getByRole("button", { name: copy.create.submitCreate }),
      ).toHaveProperty("disabled", false);
    });
    submitCreateForm();
    expect(
      await screen.findByText(copy.create.errors.itemsNoActiveVariants),
    ).toBeDefined();
    expect(screen.queryByText(copy.create.errors.unavailable)).toBeNull();
    expect(createCalls()).toHaveLength(0);
  });

  it("maps a structured CONFLICT onto the variant picker, not a generic banner", async () => {
    signInWithFlowers();
    seedCreateLookups();
    server.use(
      http.post(`${PANEL_ORIGIN}/rpc/orders/create`, () =>
        rpcErrorBody("CONFLICT", 409, "do-not-match-this", {
          reason: "variant_required",
        }),
      ),
    );
    await renderApp("/kviti-lviv/orders/new");
    await waitForCreateForm();
    await pickCustomerAndProduct();
    submitCreateForm();
    expect(
      await screen.findByText(copy.create.errors.itemsVariantRequired),
    ).toBeDefined();
    expect(screen.queryByText(copy.create.errors.unavailable)).toBeNull();
    expect(screen.queryByText("do-not-match-this")).toBeNull();
  });

  it("maps a bare wire CONFLICT onto the variant picker, not a dead-end banner", async () => {
    signInWithFlowers();
    seedCreateLookups();
    server.use(
      http.post(`${PANEL_ORIGIN}/rpc/orders/create`, () =>
        rpcErrorBody("CONFLICT", 409, "do-not-match-this"),
      ),
    );
    await renderApp("/kviti-lviv/orders/new");
    await waitForCreateForm();
    await pickCustomerAndProduct();
    submitCreateForm();
    expect(
      await screen.findByText(copy.create.errors.itemsVariantRequired),
    ).toBeDefined();
    expect(screen.queryByText(copy.create.errors.unavailable)).toBeNull();
    expect(screen.queryByText("do-not-match-this")).toBeNull();
  });
});
