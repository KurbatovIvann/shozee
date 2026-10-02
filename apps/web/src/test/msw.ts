import {
  COMPANY_SELECTOR_HEADER,
  CONFIRMATION_CHALLENGE_HEADER,
  IDEMPOTENCY_KEY_HEADER,
} from "@showzy/contract";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import type { CompanyMembership } from "../features/companies/api/list-mine";

/** jsdom document origin — same-origin `/api/auth` and `/rpc`. */
export const PANEL_ORIGIN = "http://localhost:3000";

export type MockSessionUser = {
  readonly id: string;
  readonly email: string | null;
  readonly phoneNumber: string | null;
};

export type RpcCall = {
  readonly path: string;
  readonly companyId: string | null;
};

export type MutationRpcCall = {
  readonly path: string;
  readonly companyId: string | null;
  readonly idempotencyKey: string | null;
  readonly confirmationChallengeId: string | null;
  readonly input: unknown;
};

export type OrdersListRpcCall = {
  readonly path: string;
  readonly companyId: string | null;
  readonly input: unknown;
};

type SessionState = { user: MockSessionUser | null };

type RpcState = {
  memberships: CompanyMembership[];
  occupiedSlugs: string[];
  createNetworkFailuresRemaining: number;
  createConfirmationsRemaining: number;
  confirmationChallengeId: string;
  calls: RpcCall[];
  mutationCalls: MutationRpcCall[];
  listOrdersItems: unknown[];
  listOrdersCalls: OrdersListRpcCall[];
  orderDetails: Record<string, Record<string, unknown>>;
  customersById: Record<string, Record<string, unknown>>;
  listCustomersItems: unknown[];
  listCustomersCalls: OrdersListRpcCall[];
  listProductsItems: unknown[];
  listProductsCalls: OrdersListRpcCall[];
  productDetails: Record<string, Record<string, unknown>>;
  getDownloadUrlsCalls: OrdersListRpcCall[];
  orderCreateNetworkFailuresRemaining: number;
  createdOrdersByKey: Record<string, Record<string, unknown>>;
};

type SessionJson = {
  readonly session: {
    readonly id: string;
    readonly userId: string;
    readonly token: string;
    readonly expiresAt: string;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly name: string;
    readonly emailVerified: boolean;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly phoneNumber: string | null;
  };
} | null;

type AuthMsw = {
  readonly sessionState: SessionState;
  readonly rpcState: RpcState;
  readonly server: ReturnType<typeof setupServer>;
  listening: boolean;
};

/**
 * Vitest `setupFiles` re-evaluate per file and `globalSetup` is a
 * different process. Keep one `setupServer` + session on `globalThis`
 * so `listen()` is once-per-worker and tests mutate the same session.
 */
function authMsw(): AuthMsw {
  const g = globalThis as typeof globalThis & { __showzyPanelMsw?: AuthMsw };
  const existing = g.__showzyPanelMsw;
  if (existing !== undefined) {
    return existing;
  }
  const sessionState: SessionState = { user: null };
  const rpcState: RpcState = {
    memberships: [],
    occupiedSlugs: [],
    createNetworkFailuresRemaining: 0,
    createConfirmationsRemaining: 0,
    confirmationChallengeId: "challenge-1",
    calls: [],
    mutationCalls: [],
    listOrdersItems: [],
    listOrdersCalls: [],
    orderDetails: {},
    customersById: {},
    listCustomersItems: [],
    listCustomersCalls: [],
    listProductsItems: [],
    listProductsCalls: [],
    productDetails: {},
    getDownloadUrlsCalls: [],
    orderCreateNetworkFailuresRemaining: 0,
    createdOrdersByKey: {},
  };
  const created: AuthMsw = {
    sessionState,
    rpcState,
    server: setupServer(...allHandlers(sessionState, rpcState)),
    listening: false,
  };
  g.__showzyPanelMsw = created;
  return created;
}

function sessionJson(sessionState: SessionState): SessionJson {
  if (sessionState.user === null) {
    return null;
  }
  const now = new Date().toISOString();
  const email = sessionState.user.email ?? "380671112233@phone.invalid";
  return {
    session: {
      id: "session-1",
      userId: sessionState.user.id,
      token: "session-token",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      createdAt: now,
      updatedAt: now,
    },
    user: {
      id: sessionState.user.id,
      email,
      name: "",
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
      phoneNumber: sessionState.user.phoneNumber,
    },
  };
}

function rpcJson(data: unknown): Response {
  return HttpResponse.json({ json: data });
}

function recordRpc(rpcState: RpcState, request: Request): void {
  rpcState.calls.push({
    path: new URL(request.url).pathname,
    companyId: request.headers.get(COMPANY_SELECTOR_HEADER),
  });
}

function rpcError(
  code: string,
  status: number,
  message: string,
  data?: unknown,
): Response {
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

function jsonObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function envelopeInput(body: unknown): unknown {
  const record = jsonObject(body);
  if (record === null) {
    return undefined;
  }
  return "json" in record ? record.json : body;
}

function inputString(input: unknown, key: string): string {
  const record = jsonObject(input);
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

function inputStringArray(input: unknown, key: string): string[] {
  const record = jsonObject(input);
  const value = record?.[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function pageLimit(input: unknown): number {
  const record = jsonObject(input);
  const limit = record?.limit;
  if (typeof limit === "number" && Number.isInteger(limit) && limit > 0) {
    return limit;
  }
  return 50;
}

function recordMutation(
  rpcState: RpcState,
  request: Request,
  input: unknown,
): void {
  rpcState.mutationCalls.push({
    path: new URL(request.url).pathname,
    companyId: request.headers.get(COMPANY_SELECTOR_HEADER),
    idempotencyKey: request.headers.get(IDEMPOTENCY_KEY_HEADER),
    confirmationChallengeId: request.headers.get(CONFIRMATION_CHALLENGE_HEADER),
    input,
  });
}

function patchStoredOrderStatus(
  rpcState: RpcState,
  orderId: string,
  status: string,
  extra: Record<string, unknown>,
): Record<string, unknown> | null {
  const current = jsonObject(rpcState.orderDetails[orderId]);
  if (current === null) {
    return null;
  }
  const next = { ...current, status, ...extra };
  rpcState.orderDetails[orderId] = next;
  rpcState.listOrdersItems = rpcState.listOrdersItems.map((item) => {
    const record = jsonObject(item);
    if (record === null || record.orderId !== orderId) {
      return item;
    }
    return { ...record, status };
  });
  return next;
}

function writeOrderStatus(
  rpcState: RpcState,
  orderId: string,
  allowedFrom: readonly string[],
  nextStatus: string,
  extra: Record<string, unknown>,
): Response {
  const current = jsonObject(rpcState.orderDetails[orderId]);
  if (current === null) {
    return rpcError("NOT_FOUND", 404, "Order not found.");
  }
  const currentStatus =
    typeof current.status === "string" ? current.status : "";
  if (!allowedFrom.includes(currentStatus)) {
    return rpcError("CONFLICT", 409, "Invalid status transition.");
  }
  const updated = patchStoredOrderStatus(rpcState, orderId, nextStatus, extra);
  if (updated === null) {
    return rpcError("NOT_FOUND", 404, "Order not found.");
  }
  return rpcJson({
    orderId,
    customerId: updated.customerId ?? null,
    status: nextStatus,
    ...extra,
  });
}

function prefixFromSlug(slug: string): string {
  const letters = slug
    .replace(/[^a-z]/g, "")
    .slice(0, 2)
    .toUpperCase();
  return `${letters}XX`.slice(0, 2);
}

function membershipFromCreate(name: string, slug: string): CompanyMembership {
  return {
    membershipId: crypto.randomUUID(),
    role: "owner",
    permissions: [],
    company: {
      id: crypto.randomUUID(),
      name,
      slug,
      prefix: prefixFromSlug(slug),
    },
  };
}

function allHandlers(sessionState: SessionState, rpcState: RpcState) {
  return [
    http.get(`${PANEL_ORIGIN}/api/auth/get-session`, () => {
      return HttpResponse.json(sessionJson(sessionState));
    }),
    http.post(`${PANEL_ORIGIN}/api/auth/phone-number/send-otp`, () => {
      return HttpResponse.json({ status: true });
    }),
    http.post(`${PANEL_ORIGIN}/api/auth/sign-out`, () => {
      sessionState.user = null;
      return HttpResponse.json({ success: true });
    }),
    http.post(`${PANEL_ORIGIN}/api/auth/phone-number/verify`, () => {
      sessionState.user = {
        id: "user-1",
        email: null,
        phoneNumber: "+380671112233",
      };
      return HttpResponse.json(sessionJson(sessionState));
    }),
    http.post(
      `${PANEL_ORIGIN}/api/auth/email-otp/send-verification-otp`,
      () => {
        return HttpResponse.json({ status: true });
      },
    ),
    http.post(`${PANEL_ORIGIN}/api/auth/sign-in/email-otp`, () => {
      sessionState.user = {
        id: "user-1",
        email: "user@example.com",
        phoneNumber: null,
      };
      return HttpResponse.json(sessionJson(sessionState));
    }),
    http.post(`${PANEL_ORIGIN}/rpc/companies/listMine`, ({ request }) => {
      recordRpc(rpcState, request);
      return rpcJson({ memberships: rpcState.memberships });
    }),
    http.post(`${PANEL_ORIGIN}/rpc/companies/get`, ({ request }) => {
      recordRpc(rpcState, request);
      const companyId = request.headers.get(COMPANY_SELECTOR_HEADER);
      const current = rpcState.memberships.find(
        (membership) => membership.company.id === companyId,
      )?.company;
      return rpcJson({
        id: current?.id ?? "c0c0c0c0-0000-4000-8000-000000000099",
        name: current?.name ?? "unknown",
        slug: current?.slug ?? "unknown",
        prefix: current?.prefix ?? "XX",
        legal: null,
      });
    }),
    http.post(`${PANEL_ORIGIN}/rpc/companies/create`, async ({ request }) => {
      recordRpc(rpcState, request);
      const body: unknown = await request.json();
      const input = envelopeInput(body);
      rpcState.mutationCalls.push({
        path: new URL(request.url).pathname,
        companyId: request.headers.get(COMPANY_SELECTOR_HEADER),
        idempotencyKey: request.headers.get(IDEMPOTENCY_KEY_HEADER),
        confirmationChallengeId: request.headers.get(
          CONFIRMATION_CHALLENGE_HEADER,
        ),
        input,
      });
      if (rpcState.createNetworkFailuresRemaining > 0) {
        rpcState.createNetworkFailuresRemaining -= 1;
        return HttpResponse.error();
      }
      if (rpcState.createConfirmationsRemaining > 0) {
        rpcState.createConfirmationsRemaining -= 1;
        return rpcError(
          "CONFIRMATION_REQUIRED",
          409,
          "Confirmation required.",
          {
            challenge: {
              challengeId: rpcState.confirmationChallengeId,
              summary: "Create this company",
              expiresAt: new Date(Date.now() + 300_000).toISOString(),
              risk: "high",
            },
          },
        );
      }
      const record = jsonObject(input);
      const name = typeof record?.name === "string" ? record.name.trim() : "";
      const slug = typeof record?.slug === "string" ? record.slug : "";
      if (name.length === 0 || slug.length === 0) {
        return rpcError("VALIDATION", 400, "Invalid.", { issues: [] });
      }
      const existing = rpcState.memberships.find(
        (membership) => membership.company.slug === slug,
      );
      if (existing !== undefined) {
        if (existing.company.name === name) {
          return rpcJson(existing);
        }
        return rpcError(
          "CONFLICT",
          409,
          "This company address is already taken.",
        );
      }
      if (rpcState.occupiedSlugs.includes(slug)) {
        return rpcError(
          "CONFLICT",
          409,
          "This company address is already taken.",
        );
      }
      const created = membershipFromCreate(name, slug);
      rpcState.memberships = [...rpcState.memberships, created];
      return rpcJson(created);
    }),
    http.post(
      `${PANEL_ORIGIN}/rpc/companies/updateLegal`,
      async ({ request }) => {
        recordRpc(rpcState, request);
        const body: unknown = await request.json();
        const input = envelopeInput(body);
        const companyId = request.headers.get(COMPANY_SELECTOR_HEADER);
        rpcState.mutationCalls.push({
          path: new URL(request.url).pathname,
          companyId,
          idempotencyKey: request.headers.get(IDEMPOTENCY_KEY_HEADER),
          confirmationChallengeId: request.headers.get(
            CONFIRMATION_CHALLENGE_HEADER,
          ),
          input,
        });
        const current = rpcState.memberships.find(
          (membership) => membership.company.id === companyId,
        )?.company;
        const record = jsonObject(input);
        const now = new Date().toISOString();
        return rpcJson({
          id: current?.id ?? "c0c0c0c0-0000-4000-8000-000000000099",
          name: current?.name ?? "unknown",
          slug: current?.slug ?? "unknown",
          prefix: current?.prefix ?? "XX",
          legal: {
            id: crypto.randomUUID(),
            companyType: record?.companyType ?? "fop",
            legalName:
              typeof record?.legalName === "string" ? record.legalName : null,
            edrpou: record?.edrpou ?? null,
            legalAddress: record?.legalAddress ?? null,
            iban: record?.iban ?? null,
            bankName: record?.bankName ?? null,
            bankMfo: record?.bankMfo ?? null,
            bankEdrpou: record?.bankEdrpou ?? null,
            phone: record?.phone ?? null,
            email: record?.email ?? null,
            createdAt: now,
            updatedAt: now,
          },
        });
      },
    ),
    http.post(`${PANEL_ORIGIN}/rpc/orders/list`, async ({ request }) => {
      recordRpc(rpcState, request);
      const body: unknown = await request.json();
      const input = envelopeInput(body);
      rpcState.listOrdersCalls.push({
        path: new URL(request.url).pathname,
        companyId: request.headers.get(COMPANY_SELECTOR_HEADER),
        input,
      });
      return rpcJson({
        kind: "page.summary",
        items: rpcState.listOrdersItems,
        nextCursor: null,
        customerMatchTruncated: false,
      });
    }),
    http.post(`${PANEL_ORIGIN}/rpc/orders/get`, async ({ request }) => {
      recordRpc(rpcState, request);
      const body: unknown = await request.json();
      const input = envelopeInput(body);
      const orderId = inputString(input, "orderId");
      const stored = jsonObject(rpcState.orderDetails[orderId]);
      if (stored === null) {
        return rpcError("NOT_FOUND", 404, "Order not found.");
      }
      return rpcJson(stored);
    }),
    http.post(
      `${PANEL_ORIGIN}/rpc/customers/getCustomer`,
      async ({ request }) => {
        recordRpc(rpcState, request);
        const body: unknown = await request.json();
        const input = envelopeInput(body);
        const id = inputString(input, "id");
        const stored = jsonObject(rpcState.customersById[id]);
        if (stored === null) {
          return rpcError("NOT_FOUND", 404, "Customer not found.");
        }
        return rpcJson(stored);
      },
    ),
    http.post(`${PANEL_ORIGIN}/rpc/orders/confirm`, async ({ request }) => {
      recordRpc(rpcState, request);
      const body: unknown = await request.json();
      const input = envelopeInput(body);
      recordMutation(rpcState, request, input);
      const confirmedAt = "2026-08-29T12:00:00.000Z";
      return writeOrderStatus(
        rpcState,
        inputString(input, "orderId"),
        ["new"],
        "confirmed",
        { confirmedAt },
      );
    }),
    http.post(`${PANEL_ORIGIN}/rpc/orders/start`, async ({ request }) => {
      recordRpc(rpcState, request);
      const body: unknown = await request.json();
      const input = envelopeInput(body);
      recordMutation(rpcState, request, input);
      return writeOrderStatus(
        rpcState,
        inputString(input, "orderId"),
        ["confirmed"],
        "in_progress",
        {},
      );
    }),
    http.post(`${PANEL_ORIGIN}/rpc/orders/complete`, async ({ request }) => {
      recordRpc(rpcState, request);
      const body: unknown = await request.json();
      const input = envelopeInput(body);
      recordMutation(rpcState, request, input);
      return writeOrderStatus(
        rpcState,
        inputString(input, "orderId"),
        ["in_progress"],
        "done",
        {},
      );
    }),
    http.post(`${PANEL_ORIGIN}/rpc/orders/cancel`, async ({ request }) => {
      recordRpc(rpcState, request);
      const body: unknown = await request.json();
      const input = envelopeInput(body);
      recordMutation(rpcState, request, input);
      return writeOrderStatus(
        rpcState,
        inputString(input, "orderId"),
        ["new", "confirmed", "in_progress"],
        "canceled",
        {},
      );
    }),
    http.post(
      `${PANEL_ORIGIN}/rpc/customers/listCustomers`,
      async ({ request }) => {
        recordRpc(rpcState, request);
        const body: unknown = await request.json();
        const input = envelopeInput(body);
        rpcState.listCustomersCalls.push({
          path: new URL(request.url).pathname,
          companyId: request.headers.get(COMPANY_SELECTOR_HEADER),
          input,
        });
        const search = inputString(input, "search").trim().toLowerCase();
        const matched =
          search.length === 0
            ? rpcState.listCustomersItems
            : rpcState.listCustomersItems.filter((item) => {
                const record = jsonObject(item);
                if (record === null) {
                  return false;
                }
                const name =
                  typeof record.name === "string"
                    ? record.name.toLowerCase()
                    : "";
                const phone =
                  typeof record.phone === "string"
                    ? record.phone.toLowerCase()
                    : "";
                return name.includes(search) || phone.includes(search);
              });
        const limit = pageLimit(input);
        return rpcJson({
          items: matched.slice(0, limit),
          nextCursor: matched.length > limit ? "next" : null,
        });
      },
    ),
    http.post(
      `${PANEL_ORIGIN}/rpc/catalog/listProducts`,
      async ({ request }) => {
        recordRpc(rpcState, request);
        const body: unknown = await request.json();
        const input = envelopeInput(body);
        rpcState.listProductsCalls.push({
          path: new URL(request.url).pathname,
          companyId: request.headers.get(COMPANY_SELECTOR_HEADER),
          input,
        });
        const query = inputString(input, "query").trim().toLowerCase();
        const matched =
          query.length === 0
            ? rpcState.listProductsItems
            : rpcState.listProductsItems.filter((item) => {
                const record = jsonObject(item);
                const name =
                  typeof record?.name === "string"
                    ? record.name.toLowerCase()
                    : "";
                return name.includes(query);
              });
        const limit = pageLimit(input);
        return rpcJson({
          items: matched.slice(0, limit),
          nextCursor: matched.length > limit ? "next" : null,
        });
      },
    ),
    http.post(`${PANEL_ORIGIN}/rpc/catalog/getProduct`, async ({ request }) => {
      recordRpc(rpcState, request);
      const body: unknown = await request.json();
      const input = envelopeInput(body);
      const productId = inputString(input, "productId");
      const stored = jsonObject(rpcState.productDetails[productId]);
      if (stored === null) {
        return rpcError("NOT_FOUND", 404, "Product not found.");
      }
      return rpcJson(stored);
    }),
    http.post(
      `${PANEL_ORIGIN}/rpc/files/getDownloadUrls`,
      async ({ request }) => {
        recordRpc(rpcState, request);
        const body: unknown = await request.json();
        const input = envelopeInput(body);
        rpcState.getDownloadUrlsCalls.push({
          path: new URL(request.url).pathname,
          companyId: request.headers.get(COMPANY_SELECTOR_HEADER),
          input,
        });
        const fileIds = inputStringArray(input, "fileIds");
        if (fileIds.length === 0) {
          return rpcError("VALIDATION", 400, "fileIds required");
        }
        const rendition = inputString(input, "rendition");
        return rpcJson({
          files: fileIds.map((fileId) => ({
            fileId,
            downloadUrl:
              rendition.length === 0
                ? `https://files.test/${fileId}`
                : `https://files.test/${fileId}?r=${rendition}`,
            expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          })),
        });
      },
    ),
    http.post(`${PANEL_ORIGIN}/rpc/orders/create`, async ({ request }) => {
      recordRpc(rpcState, request);
      const body: unknown = await request.json();
      const input = envelopeInput(body);
      recordMutation(rpcState, request, input);
      if (rpcState.orderCreateNetworkFailuresRemaining > 0) {
        rpcState.orderCreateNetworkFailuresRemaining -= 1;
        return HttpResponse.error();
      }
      const key = request.headers.get(IDEMPOTENCY_KEY_HEADER);
      if (key !== null) {
        const existing = jsonObject(rpcState.createdOrdersByKey[key]);
        if (existing !== null) {
          return rpcJson(existing);
        }
      }
      const record = jsonObject(input);
      const customerRef = jsonObject(record?.customer);
      const customerId =
        customerRef?.by === "id" && typeof customerRef.id === "string"
          ? customerRef.id
          : "";
      const customer = jsonObject(rpcState.customersById[customerId]);
      if (customerId.length === 0 || customer === null) {
        return rpcError("NOT_FOUND", 404, "do-not-match-this-message");
      }
      const rawItems = Array.isArray(record?.items) ? record.items : [];
      if (rawItems.length === 0) {
        return rpcError("VALIDATION", 400, "do-not-match-this-message", {
          issues: [{ path: ["items"], message: "secret" }],
        });
      }
      const createdAt = "2026-09-03T12:00:00.000Z";
      const orderId = "99999999-9999-4999-8999-999999999999";
      const orderNumber = "KL-NEW01";
      const customerName =
        typeof customer.name === "string" ? customer.name : "Customer";
      const getItems = rawItems.map((item) => {
        const line = jsonObject(item);
        const productRef = jsonObject(line?.product);
        const variantRef = jsonObject(line?.variant);
        const quantity = jsonObject(line?.quantity);
        const productId =
          productRef?.by === "id" && typeof productRef.id === "string"
            ? productRef.id
            : "";
        const variantId =
          variantRef?.by === "id" && typeof variantRef.id === "string"
            ? variantRef.id
            : null;
        const milli =
          typeof quantity?.milli === "string" ? quantity.milli : "1000";
        const product = rpcState.listProductsItems
          .map((row) => jsonObject(row))
          .find((row) => row?.id === productId);
        const productName =
          typeof product?.name === "string" ? product.name : "Item";
        return {
          itemId: crypto.randomUUID(),
          productId,
          variantId,
          titleSnapshot: productName,
          quantityMilli: milli,
          unitPriceMinor: "0",
          discountKind: "none",
          discountValue: "0",
          discountAmountMinor: "0",
          taxTreatment: "exempt",
          taxRateBp: 0,
          taxAmountMinor: "0",
          netAmountMinor: "0",
          grossAmountMinor: "0",
          currency: "UAH",
          priceSource: "base",
          personalPriceId: null,
          priceListId: null,
          priceListEntryId: null,
          resolverVersion: 1,
        };
      });
      const commentRaw =
        typeof record?.comment === "string" ? record.comment.trim() : "";
      const getView = {
        orderId,
        orderNumber,
        customerId,
        status: "new",
        comment: commentRaw.length > 0 ? commentRaw : null,
        totalNetMinor: "0",
        totalTaxMinor: "0",
        totalGrossMinor: "0",
        currency: "UAH",
        confirmedAt: null,
        createdAt,
        items: getItems,
      };
      const listRow = {
        orderId,
        orderNumber,
        customer: {
          nameSnapshot: customerName,
          linkedCustomerId: customerId,
        },
        status: "new",
        itemCount: getItems.length,
        totalGrossMinor: "0",
        currency: "UAH",
        createdAt,
      };
      const summary = {
        orderId,
        orderNumber,
        customer: {
          nameSnapshot: customerName,
          linkedCustomerId: customerId,
        },
        status: "new",
        itemCount: getItems.length,
        totalNetMinor: "0",
        totalTaxMinor: "0",
        totalGrossMinor: "0",
        currency: "UAH",
        createdAt,
      };
      rpcState.orderDetails[orderId] = getView;
      rpcState.listOrdersItems = [...rpcState.listOrdersItems, listRow];
      if (key !== null) {
        rpcState.createdOrdersByKey[key] = summary;
      }
      return rpcJson(summary);
    }),
  ];
}

const msw = authMsw();

export const sessionState = msw.sessionState;
export const listMineState = msw.rpcState;
export const server = msw.server;

export function resetAuthMocks(): void {
  sessionState.user = null;
  listMineState.memberships = [];
  listMineState.occupiedSlugs = [];
  listMineState.createNetworkFailuresRemaining = 0;
  listMineState.createConfirmationsRemaining = 0;
  listMineState.confirmationChallengeId = "challenge-1";
  listMineState.calls = [];
  listMineState.mutationCalls = [];
  listMineState.listOrdersItems = [];
  listMineState.listOrdersCalls = [];
  listMineState.orderDetails = {};
  listMineState.customersById = {};
  listMineState.listCustomersItems = [];
  listMineState.listCustomersCalls = [];
  listMineState.listProductsItems = [];
  listMineState.listProductsCalls = [];
  listMineState.productDetails = {};
  listMineState.getDownloadUrlsCalls = [];
  listMineState.orderCreateNetworkFailuresRemaining = 0;
  listMineState.createdOrdersByKey = {};
}

export function seedOrderDetail(view: object): void {
  const record = jsonObject(structuredClone(view));
  if (record === null) {
    return;
  }
  const orderId = record.orderId;
  if (typeof orderId !== "string") {
    return;
  }
  listMineState.orderDetails[orderId] = record;
}

export function seedCustomer(view: object): void {
  const record = jsonObject(structuredClone(view));
  if (record === null) {
    return;
  }
  const id = record.id;
  if (typeof id !== "string") {
    return;
  }
  listMineState.customersById[id] = record;
  const already = listMineState.listCustomersItems.some((item) => {
    const row = jsonObject(item);
    return row?.id === id;
  });
  if (!already) {
    listMineState.listCustomersItems = [
      ...listMineState.listCustomersItems,
      record,
    ];
  }
}

export function seedProduct(view: object): void {
  const record = jsonObject(structuredClone(view));
  if (record === null) {
    return;
  }
  const id = record.id;
  if (typeof id !== "string") {
    return;
  }
  const createdAt =
    typeof record.createdAt === "string"
      ? record.createdAt
      : "2026-01-01T00:00:00.000Z";
  const updatedAt =
    typeof record.updatedAt === "string" ? record.updatedAt : createdAt;
  const name = typeof record.name === "string" ? record.name : "Product";
  const basePriceMinor =
    typeof record.basePriceMinor === "string" ? record.basePriceMinor : "0";
  const currency =
    typeof record.currency === "string" ? record.currency : "UAH";
  const status = typeof record.status === "string" ? record.status : "active";
  const variantCount =
    typeof record.variantCount === "number"
      ? record.variantCount
      : Array.isArray(record.variants)
        ? record.variants.length
        : 0;
  const listRow = {
    id,
    name,
    basePriceMinor,
    currency,
    status,
    variantCount,
    primaryImageFileId:
      typeof record.primaryImageFileId === "string"
        ? record.primaryImageFileId
        : null,
    createdAt,
    updatedAt,
  };
  const detail = {
    id,
    name,
    basePriceMinor,
    currency,
    status,
    createdAt,
    updatedAt,
    variants: Array.isArray(record.variants) ? record.variants : [],
    imageFileIds: Array.isArray(record.imageFileIds) ? record.imageFileIds : [],
  };
  listMineState.productDetails[id] = detail;
  const alreadyIndex = listMineState.listProductsItems.findIndex((item) => {
    const row = jsonObject(item);
    return row?.id === id;
  });
  if (alreadyIndex === -1) {
    listMineState.listProductsItems = [
      ...listMineState.listProductsItems,
      listRow,
    ];
    return;
  }
  const next = [...listMineState.listProductsItems];
  next[alreadyIndex] = listRow;
  listMineState.listProductsItems = next;
}

export function ensureAuthServer(): void {
  if (msw.listening) {
    return;
  }
  server.listen({ onUnhandledRequest: "error" });
  msw.listening = true;
}
