/**
 * The Hono HTTP app (ADR-0003, contract.md §3): request-id, trusted-proxy
 * IP, better-auth, oRPC at `/rpc`, OpenAPI REST aliases at `/api/v1`,
 * document-share landing, PKI proxy, staff AI JSON at `/assistant/chat`,
 * and a liveness endpoint. Business logic does not live here — every
 * action runs `executeAction` through the contract server router or the
 * dedicated AI mount. `POST /pki/proxy` is HTTP, not an action.
 */
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { ORPCError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import {
  COMPANY_SELECTOR_HEADER,
  CONFIRMATION_CHALLENGE_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  RPC_PREFIX,
  type ContractModuleMap,
} from "@showzy/contract";
import {
  buildServerRouter,
  wireErrorInterceptors,
  type TransportInvocationContext,
} from "@showzy/contract/server";
import {
  createInMemoryRateLimitStore,
  type ActionPipelineDeps,
  type ActionRegistry,
  type RateLimitStore,
  type SessionPrincipal,
} from "@showzy/core";
import type { ActionPrincipal } from "@showzy/core/contract";
import { CoreInvariantError } from "@showzy/core/errors";
import { Hono, type Context } from "hono";

import {
  createMemoryAiBudgetStore,
  type AiBudgetStore,
} from "../stores/budget.js";
import {
  createMemoryConversationLock,
  type ConversationLock,
} from "../stores/conversation-lock.js";
import {
  createMemoryPendingStore,
  type StaffAssistantPendingStore,
} from "../stores/pending.js";
import {
  DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
  type StaffAssistantBudgetLimits,
} from "./assistant-budget-guard.js";
import {
  executeBudgetedStaffAssistantHost,
  executeStaffAssistantChat,
  optionalStaffAssistantLanguageModel,
  type StaffAssistantRuntime,
} from "./assistant-chat.js";
import {
  ASSISTANT_CONFIRM_PATH,
  ASSISTANT_HOST_CHOICE_PATH,
  ASSISTANT_PENDING_ABANDON_PATH,
  ASSISTANT_PENDING_PATH,
  executeStaffAssistantHostChoiceResume,
  executeStaffAssistantHostConfirm,
  executeStaffAssistantPendingAbandon,
  executeStaffAssistantPendingPeek,
  type StaffAssistantHostRuntime,
} from "./assistant-host.js";
import { ASSISTANT_CHAT_PATH } from "./assistant-invocation.js";
import { createAssistantKitApp } from "./assistant-kit.js";
import type { AssistantKitRuntime } from "./assistant-kit-http.js";
import { createTrustedProxyMatcher, resolveClientIp } from "./client-ip.js";
import {
  DOCUMENT_SHARE_LANDING_ROUTE,
  executeDocumentShareLanding,
} from "./document-share-landing.js";
import {
  executePkiProxy,
  PKI_PROXY_PATH,
  type PkiProxyRuntime,
} from "./pki-proxy.js";
import { REQUEST_ID_HEADER, resolveRequestId } from "./request-id.js";

/** OpenAPI REST aliases (contract.md §3). Distinct from `/api/auth`. */
export const REST_PREFIX = "/api/v1";

export const AUTH_PREFIX = "/api/auth";

export const HEALTH_PATH = "/health";

/**
 * oRPC at `/rpc` and OpenAPI REST aliases at `/api/v1` are labeled `ui`.
 * `POST /assistant/chat` sets `channel: "ai"` (security-operations §4).
 * Do not add a client-spoofable `x-channel` header.
 */
export const HTTP_INVOCATION_CHANNEL = "ui" as const;

/**
 * The better-auth instance as the transport sees it: session lookup plus
 * the HTTP handler. Callers pass the `betterAuth(...)` return value.
 */
export interface AuthInstance {
  handler: (request: Request) => Promise<Response> | Response;
  api: {
    getSession: (args: {
      headers: Headers;
    }) => Promise<{ user: { id: string } } | null>;
  };
}

type AppEnv = {
  Variables: {
    requestId: string;
    clientIp: string;
  };
};

export interface CreateAppOptions {
  readonly auth: AuthInstance;
  readonly registry: ActionRegistry;
  readonly contractModules: ContractModuleMap;
  readonly pipeline: ActionPipelineDeps;
  readonly trustedProxies: readonly string[];
  /** Socket peer. Tests inject a header-backed function; boot uses getConnInfo. */
  readonly getPeerAddress: (c: Context<AppEnv>) => string;
  /** SSRF-gated OCSP/TSA proxy (SHO-255). Not an action. */
  readonly pkiProxy: PkiProxyRuntime;
  /** Staff AI JSON (`POST /assistant/chat`). Optional so unit tests of the HTTP shell still boot. */
  readonly assistant?: StaffAssistantRuntime;
  /**
   * Pending HITL store (`POST /assistant/choice`, confirm, abandon, peek).
   * Boot mounts Redis Lua. Tests inject the in-memory CAS store.
   */
  readonly pendingStore?: StaffAssistantPendingStore;
  /**
   * Conversation mutex shared by chat, replace, abandon, and resume.
   * Boot mounts Redis SET NX. Tests inject the in-memory lock.
   */
  readonly conversationLock?: ConversationLock;
  /**
   * Per-user turn limit + Kyiv-day USD budget on `POST /assistant/chat`
   * and HITL resume (`POST /assistant/choice`, `POST /assistant/confirm`)
   * (SHO-505 / SHO-541). Boot mounts Redis. Tests inject memory stores.
   */
  readonly assistantBudget?: {
    readonly rateLimitStore: RateLimitStore;
    readonly budgetStore: AiBudgetStore;
    readonly limits?: StaffAssistantBudgetLimits;
  };
  /**
   * The `assistant-kit` path (`/assistant/kit/*`), off unless this is passed.
   *
   * Parallel to the live assistant, on its own paths and its own Redis key
   * prefix. Boot passes it only when `SHOWZY_ASSISTANT_KIT` is set, so the
   * running assistant is unaffected by its presence and the two can be compared
   * by hand on the same data.
   */
  readonly assistantKit?: AssistantKitRuntime;
}

/**
 * Public and share invocations are unauthenticated (contract.md §3,
 * ADR-0022). Every other client principal needs a session; `system` is
 * not HTTP-routable and stays fail-closed here if composition ever leaks.
 */
function requiresSession(principal: ActionPrincipal): boolean {
  switch (principal) {
    case "public":
    case "share":
      return false;
    case "staff":
    case "customer":
    case "consumer":
    case "account":
    case "system":
      return true;
  }
}

function sessionGate(registry: ActionRegistry) {
  return async (options: {
    next: () => Promise<unknown>;
    context: TransportInvocationContext;
    path: readonly string[];
  }): Promise<unknown> => {
    const contract = registry.getContract(options.path.join("."));
    if (contract !== undefined && requiresSession(contract.principal)) {
      const resolve = readSessionThunk(options.context);
      const session = resolve === undefined ? null : await resolve();
      assignSession(options.context, session);
      if (session === null) {
        throw new ORPCError("UNAUTHENTICATED", {
          defined: true,
          status: 401,
          message: "Authentication required.",
        });
      }
    }
    return options.next();
  };
}

async function resolveSession(
  auth: AuthInstance,
  headers: Headers,
): Promise<SessionPrincipal | null> {
  const result = await auth.api.getSession({ headers });
  if (result === null) {
    return null;
  }
  return { userId: result.user.id };
}

/**
 * oRPC client interceptors receive `path` + `context` but not headers
 * (`ProcedureClientInterceptorOptions`). Stash a thunk on the context
 * object (not a call) so `sessionGate` can `getSession` only when the
 * dispatched principal requires one. Public/share never touch the store.
 *
 * StrictGetMethodPlugin spreads context into a new object, so a WeakMap
 * keyed by identity misses. An enumerable symbol survives `{...context}`
 * and is not a published client-contract field (JSON ignores symbols).
 */
const SESSION_THUNK = Symbol("showzy.pendingSession");

function isSessionThunk(
  value: unknown,
): value is () => Promise<SessionPrincipal | null> {
  return typeof value === "function";
}

function readSessionThunk(
  context: TransportInvocationContext,
): (() => Promise<SessionPrincipal | null>) | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(context, SESSION_THUNK);
  if (descriptor === undefined) {
    return undefined;
  }
  const value: unknown = descriptor.value as unknown;
  return isSessionThunk(value) ? value : undefined;
}

function stashSessionThunk(
  context: TransportInvocationContext,
  resolve: () => Promise<SessionPrincipal | null>,
): void {
  Object.defineProperty(context, SESSION_THUNK, {
    value: resolve,
    enumerable: true,
    configurable: true,
  });
}

function assignSession(
  context: TransportInvocationContext,
  session: SessionPrincipal | null,
): void {
  Object.assign(context, { session });
}

function headerOrNull(headers: Headers, name: string): string | null {
  const value = headers.get(name);
  return value === null || value === "" ? null : value;
}

function optionalHeader(headers: Headers, name: string): string | undefined {
  const value = headers.get(name);
  return value === null || value === "" ? undefined : value;
}

interface TransportRequest {
  readonly req: { readonly raw: Request };
  get(key: "requestId" | "clientIp"): string;
}

function buildTransportContext(
  c: TransportRequest,
  auth: AuthInstance,
): TransportInvocationContext {
  const headers = c.req.raw.headers;
  const idempotencyKey = optionalHeader(headers, IDEMPOTENCY_KEY_HEADER);
  const confirmationChallengeId = optionalHeader(
    headers,
    CONFIRMATION_CHALLENGE_HEADER,
  );
  const context: TransportInvocationContext = {
    requestId: c.get("requestId"),
    channel: HTTP_INVOCATION_CHANNEL,
    session: null,
    companySelector: headerOrNull(headers, COMPANY_SELECTOR_HEADER),
    clientIp: c.get("clientIp"),
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    ...(confirmationChallengeId !== undefined
      ? { confirmationChallengeId }
      : {}),
  };
  stashSessionThunk(context, () => resolveSession(auth, headers));
  return context;
}

function withRequestId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set(REQUEST_ID_HEADER, requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Overwrite forwarded-IP headers with the trusted-proxy-normalized address
 * before better-auth sees the request, so its own IP rate limiter cannot be
 * keyed off a spoofed header (security-operations §2).
 */
function requestWithTrustedIp(request: Request, clientIp: string): Request {
  const headers = new Headers(request.headers);
  headers.delete("x-real-ip");
  headers.set("x-forwarded-for", clientIp);
  return new Request(request, { headers });
}

export function createApp(options: CreateAppOptions): Hono<AppEnv> {
  if (options.pkiProxy.ipHmacSecret.length === 0) {
    throw new CoreInvariantError(
      "pki-proxy constructed with an empty ipHmacSecret — config wiring bug",
    );
  }
  // Two procedure constructions at boot (SHO-277 owner decision: accepted,
  // why-comment only). `contractModules` is the client exposure record
  // (`buildContractRouter` / `toContractProcedure` for the published
  // typed client). `buildServerRouter` then `implement(toContractProcedure)`
  // pairs each descriptor with `executeAction`. They are different layers,
  // not duplicate work to collapse — do not delete `contractRouter`.
  const serverRouter = buildServerRouter(options.contractModules, {
    registry: options.registry,
    pipeline: options.pipeline,
  });
  const interceptors = [
    sessionGate(options.registry),
    ...wireErrorInterceptors,
  ];
  // RPCHandler mutates `clientInterceptors` (prepends StrictGetMethodPlugin).
  // Copy so OpenAPI does not inherit a check whose matching context symbol
  // was never set — that surfaces as a generic 500.
  const rpcHandler = new RPCHandler(serverRouter, {
    clientInterceptors: [...interceptors],
  });
  const openApiHandler = new OpenAPIHandler(serverRouter, {
    clientInterceptors: [...interceptors],
  });

  const app = new Hono<AppEnv>();
  const isTrusted = createTrustedProxyMatcher(options.trustedProxies);

  app.use(async (c, next) => {
    const requestId = resolveRequestId(c.req.header(REQUEST_ID_HEADER));
    c.set("requestId", requestId);
    c.set(
      "clientIp",
      resolveClientIp({
        peerAddress: options.getPeerAddress(c),
        forwardedFor: c.req.header("x-forwarded-for"),
        isTrusted,
      }),
    );
    await next();
    c.header(REQUEST_ID_HEADER, requestId);
  });

  app.get(HEALTH_PATH, (c) => c.json({ status: "ok" }));

  app.post(PKI_PROXY_PATH, async (c) => {
    const result = await executePkiProxy({
      request: c.req.raw,
      requestId: c.get("requestId"),
      clientIp: c.get("clientIp"),
      logger: options.pipeline.logger,
      rateLimitStore: options.pkiProxy.rateLimitStore,
      ipHmacSecret: options.pkiProxy.ipHmacSecret,
      ...(options.pkiProxy.lookup !== undefined
        ? { lookup: options.pkiProxy.lookup }
        : {}),
      ...(options.pkiProxy.fetchImpl !== undefined
        ? { fetchImpl: options.pkiProxy.fetchImpl }
        : {}),
      ...(options.pkiProxy.now !== undefined
        ? { now: options.pkiProxy.now }
        : {}),
    });
    if (result.retryAfterSec !== undefined) {
      c.header("Retry-After", String(result.retryAfterSec));
    }
    c.header("Cache-Control", "private, no-store");
    return c.json(result.body, result.status);
  });

  app.get(DOCUMENT_SHARE_LANDING_ROUTE, async (c) => {
    const result = await executeDocumentShareLanding({
      pipeline: options.pipeline,
      token: c.req.param("token"),
      requestId: c.get("requestId"),
      clientIp: c.get("clientIp"),
    });
    c.header("Cache-Control", "private, no-store");
    c.header("Referrer-Policy", "no-referrer");
    if (result.retryAfterSec !== undefined) {
      c.header("Retry-After", String(result.retryAfterSec));
    }
    return c.html(result.html, result.status);
  });

  const pendingStore = options.pendingStore ?? createMemoryPendingStore();
  const conversationLock =
    options.conversationLock ?? createMemoryConversationLock();
  const assistantBudget = options.assistantBudget ?? {
    rateLimitStore: createInMemoryRateLimitStore(),
    budgetStore: createMemoryAiBudgetStore(),
    limits: DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
  };
  const budgetLimits =
    assistantBudget.limits ?? DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS;
  const hostModel = optionalStaffAssistantLanguageModel(options.assistant);

  function hostRuntime(
    c: Context<AppEnv>,
  ): Omit<StaffAssistantHostRuntime, "request"> {
    return {
      requestId: c.get("requestId"),
      clientIp: c.get("clientIp"),
      registry: options.registry,
      pipeline: options.pipeline,
      getSession: (headers) => resolveSession(options.auth, headers),
      pendingStore,
      conversationLock,
      ...(hostModel !== undefined ? { model: hostModel } : {}),
    };
  }

  app.post(ASSISTANT_CHAT_PATH, async (c) => {
    const response = await executeStaffAssistantChat({
      request: c.req.raw,
      requestId: c.get("requestId"),
      clientIp: c.get("clientIp"),
      registry: options.registry,
      pipeline: options.pipeline,
      getSession: (headers) => resolveSession(options.auth, headers),
      pendingStore,
      conversationLock,
      rateLimitStore: assistantBudget.rateLimitStore,
      budgetStore: assistantBudget.budgetStore,
      budgetLimits,
      ...(options.assistant !== undefined
        ? { assistant: options.assistant }
        : {}),
    });
    return withRequestId(response, c.get("requestId"));
  });

  app.post(ASSISTANT_HOST_CHOICE_PATH, async (c) => {
    const runtime = {
      ...hostRuntime(c),
      request: c.req.raw,
    };
    const response = await executeBudgetedStaffAssistantHost({
      request: runtime.request,
      requestId: runtime.requestId,
      clientIp: runtime.clientIp,
      pipeline: runtime.pipeline,
      getSession: runtime.getSession,
      rateLimitStore: assistantBudget.rateLimitStore,
      budgetStore: assistantBudget.budgetStore,
      budgetLimits,
      ...(options.assistant !== undefined
        ? { assistant: options.assistant }
        : {}),
      run: (model) =>
        executeStaffAssistantHostChoiceResume({ ...runtime, model }),
    });
    return withRequestId(response, c.get("requestId"));
  });

  app.post(ASSISTANT_CONFIRM_PATH, async (c) => {
    const runtime = {
      ...hostRuntime(c),
      request: c.req.raw,
    };
    const response = await executeBudgetedStaffAssistantHost({
      request: runtime.request,
      requestId: runtime.requestId,
      clientIp: runtime.clientIp,
      pipeline: runtime.pipeline,
      getSession: runtime.getSession,
      rateLimitStore: assistantBudget.rateLimitStore,
      budgetStore: assistantBudget.budgetStore,
      budgetLimits,
      ...(options.assistant !== undefined
        ? { assistant: options.assistant }
        : {}),
      run: (model) => executeStaffAssistantHostConfirm({ ...runtime, model }),
    });
    return withRequestId(response, c.get("requestId"));
  });

  app.post(ASSISTANT_PENDING_ABANDON_PATH, async (c) => {
    const response = await executeStaffAssistantPendingAbandon({
      ...hostRuntime(c),
      request: c.req.raw,
    });
    return withRequestId(response, c.get("requestId"));
  });

  app.get(ASSISTANT_PENDING_PATH, async (c) => {
    const response = await executeStaffAssistantPendingPeek({
      ...hostRuntime(c),
      request: c.req.raw,
    });
    return withRequestId(response, c.get("requestId"));
  });

  if (options.assistantKit !== undefined) {
    // Dark by default. Mounted as a whole app so its three routes stay
    // together; it inherits this app's request id and client ip.
    app.route("/", createAssistantKitApp(options.assistantKit));
  }

  app.on(["GET", "POST"], `${AUTH_PREFIX}/*`, async (c) => {
    const response = await options.auth.handler(
      requestWithTrustedIp(c.req.raw, c.get("clientIp")),
    );
    return withRequestId(response, c.get("requestId"));
  });

  app.use(`${RPC_PREFIX}/*`, async (c) => {
    const context = buildTransportContext(c, options.auth);
    const result = await rpcHandler.handle(c.req.raw, {
      prefix: RPC_PREFIX,
      context,
    });
    if (result.matched) {
      return withRequestId(result.response, c.get("requestId"));
    }
    return c.json({ message: "Not found." }, 404);
  });

  app.use(`${REST_PREFIX}/*`, async (c) => {
    const context = buildTransportContext(c, options.auth);
    const result = await openApiHandler.handle(c.req.raw, {
      prefix: REST_PREFIX,
      context,
    });
    if (result.matched) {
      return withRequestId(result.response, c.get("requestId"));
    }
    return c.json({ message: "Not found." }, 404);
  });

  return app;
}
