/**
 * Live staff AI mount (SHO-524 / ADR-0037).
 *
 * `POST /assistant/chat` is a dedicated Hono route — not `/rpc`. Session
 * cookie + `x-company-id` match other staff HTTP. Membership is verified
 * by `executeAction` (`assistant.getStaffActor`), never by the selector.
 * Tool `execute` calls `executeAction` with `channel: "ai"`. Missing
 * Anthropic config fails typed after auth; the process still boots.
 *
 * The handler wraps the T1–T4 host plus the USD/turn budget. Chat body
 * is `{ conversationId, text, locale? }`. Legacy
 * `x-confirmation-challenge-id` calls the host confirm executor and
 * ignores client text.
 */
import {
  assistantConfirmBodySchema,
  createStaffLanguageModel,
  StaffAssistantNotConfiguredError,
  type LanguageModel,
  type StaffProviderAdapter,
} from "@showzy/ai";
import { getStaffActor } from "@showzy/assistant";
import {
  COMPANY_SELECTOR_HEADER,
  CONFIRMATION_CHALLENGE_HEADER,
} from "@showzy/contract";
import { toWireError } from "@showzy/contract/server";
import {
  executeAction,
  type ActionPipelineDeps,
  type ActionRegistry,
  type RateLimitStore,
  type SessionPrincipal,
} from "@showzy/core";
import {
  CoreError,
  CoreInvariantError,
  RateLimitError,
  ValidationError,
} from "@showzy/core/errors";
import type { Logger } from "pino";

import {
  canonicalizeAiBudgetCompanyId,
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
  enforceStaffAssistantBudget,
  recordStaffAssistantBudgetSpend,
  releaseStaffAssistantBudgetHold,
  type StaffAssistantBudgetLimits,
} from "./assistant-budget-guard.js";
import {
  executeStaffAssistantHostChat,
  executeStaffAssistantHostConfirm,
  type StaffAssistantHostRuntime,
} from "./assistant-host.js";
import { ASSISTANT_INVOCATION_CHANNEL } from "./assistant-invocation.js";
import { REQUEST_ID_HEADER } from "./request-id.js";

export {
  ASSISTANT_CHAT_PATH,
  ASSISTANT_INVOCATION_CHANNEL,
} from "./assistant-invocation.js";

export { readStaffAssistantCompanyTradeName } from "./assistant-host.js";

export interface StaffAssistantRuntime {
  readonly model: string;
  readonly gateModel?: string;
  readonly anthropicApiKey?: string;
  /** Constructed once in `apps/api` composition from config (SHO-508). */
  readonly provider?: StaffProviderAdapter;
  /** Tests inject MockLanguageModelV3 — never a live LLM in CI. */
  readonly languageModel?: LanguageModel;
}

export interface StaffAssistantChatOptions {
  readonly request: Request;
  readonly requestId: string;
  readonly clientIp: string;
  readonly registry: ActionRegistry;
  readonly pipeline: ActionPipelineDeps;
  readonly getSession: (headers: Headers) => Promise<SessionPrincipal | null>;
  readonly assistant?: StaffAssistantRuntime;
  readonly pendingStore?: StaffAssistantPendingStore;
  readonly conversationLock?: ConversationLock;
  readonly rateLimitStore?: RateLimitStore;
  readonly budgetStore?: AiBudgetStore;
  readonly budgetLimits?: StaffAssistantBudgetLimits;
}

function headerOrNull(headers: Headers, name: string): string | null {
  const value = headers.get(name);
  return value === null || value === "" ? null : value;
}

function optionalHeader(headers: Headers, name: string): string | undefined {
  const value = headers.get(name);
  return value === null || value === "" ? undefined : value;
}

function jsonResponse(
  status: number,
  body: Record<string, unknown>,
  requestId: string,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "private, no-store",
      [REQUEST_ID_HEADER]: requestId,
    },
  });
}

function unauthenticatedResponse(requestId: string): Response {
  return jsonResponse(
    401,
    {
      code: "UNAUTHENTICATED",
      status: 401,
      message: "Authentication required.",
    },
    requestId,
  );
}

function wireResponse(error: unknown, requestId: string): Response {
  if (error instanceof StaffAssistantNotConfiguredError) {
    return jsonResponse(
      503,
      {
        code: error.code,
        status: 503,
        message: error.message,
      },
      requestId,
    );
  }
  const wire = toWireError(error);
  const body: Record<string, unknown> = {
    code: wire.code,
    status: wire.status,
    message: wire.message,
  };
  if (wire.data !== undefined) {
    body.data = wire.data;
  }
  return jsonResponse(wire.status, body, requestId);
}

function failureCode(error: unknown): string {
  if (error instanceof StaffAssistantNotConfiguredError) {
    return error.code;
  }
  if (error instanceof CoreError) {
    return error.code;
  }
  return "INTERNAL";
}

function logFailure(logger: Logger, requestId: string, error: unknown): void {
  const issuePaths =
    error instanceof ValidationError
      ? error.issues.map((issue) => issue.path.map(String).join("."))
      : undefined;
  logger.error(
    {
      request_id: requestId,
      code: failureCode(error),
      ...(issuePaths !== undefined ? { issue_paths: issuePaths } : {}),
    },
    "staff assistant chat failed",
  );
}

function tryCreateProviderModel(
  provider: StaffProviderAdapter | undefined,
  kind: "reply" | "gate",
): LanguageModel | undefined {
  if (provider === undefined) {
    return undefined;
  }
  try {
    return provider.createModel(kind);
  } catch (error) {
    if (error instanceof StaffAssistantNotConfiguredError) {
      return undefined;
    }
    throw error;
  }
}

export function optionalStaffAssistantLanguageModel(
  assistant: StaffAssistantRuntime | undefined,
): LanguageModel | undefined {
  if (assistant?.languageModel !== undefined) {
    return assistant.languageModel;
  }
  const fromProvider = tryCreateProviderModel(assistant?.provider, "reply");
  if (fromProvider !== undefined) {
    return fromProvider;
  }
  if (
    assistant !== undefined &&
    assistant.anthropicApiKey !== undefined &&
    assistant.anthropicApiKey !== ""
  ) {
    return createStaffLanguageModel({
      apiKey: assistant.anthropicApiKey,
      model: assistant.model,
    });
  }
  return undefined;
}

function resolveLanguageModel(
  assistant: StaffAssistantRuntime | undefined,
): LanguageModel {
  const model = optionalStaffAssistantLanguageModel(assistant);
  if (model === undefined) {
    throw new StaffAssistantNotConfiguredError();
  }
  return model;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ValidationError([
      {
        code: "custom",
        path: [],
        message: "Request body must be JSON.",
        input: undefined,
      },
    ]);
  }
}

function conversationIdFromBody(raw: unknown): string {
  if (!isJsonRecord(raw) || typeof raw["conversationId"] !== "string") {
    throw new ValidationError([
      {
        code: "custom",
        path: ["conversationId"],
        message: "conversationId is required.",
        input: undefined,
      },
    ]);
  }
  return raw["conversationId"];
}

function requestWithJsonBody(request: Request, body: unknown): Request {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  return new Request(request.url, {
    method: request.method,
    headers,
    body: JSON.stringify(body),
    signal: request.signal,
  });
}

function staffRequest(options: {
  readonly requestId: string;
  readonly clientIp: string;
}) {
  return {
    requestId: options.requestId,
    correlationId: options.requestId,
    channel: ASSISTANT_INVOCATION_CHANNEL,
    clientIp: options.clientIp,
    aiTraceId: options.requestId,
  };
}

/**
 * Handle `POST /assistant/chat`. Auth denial happens before model
 * construction so a missing Anthropic key cannot mask 401. The language
 * model is resolved before the budget/turn guard so a 503 does not
 * consume a turn slot. Header confirm skips the turn limit and settles
 * the unknown-model USD ceiling.
 */
export async function executeStaffAssistantChat(
  options: StaffAssistantChatOptions,
): Promise<Response> {
  const session = await options.getSession(options.request.headers);
  if (session === null) {
    return unauthenticatedResponse(options.requestId);
  }

  const companySelector = headerOrNull(
    options.request.headers,
    COMPANY_SELECTOR_HEADER,
  );
  const confirmationChallengeId = optionalHeader(
    options.request.headers,
    CONFIRMATION_CHALLENGE_HEADER,
  );
  const staffPrincipal = {
    mode: "staff" as const,
    session,
    companySelector,
  };
  const pendingStore = options.pendingStore ?? createMemoryPendingStore();
  const conversationLock =
    options.conversationLock ?? createMemoryConversationLock();

  try {
    await executeAction(options.pipeline, {
      action: getStaffActor,
      input: {},
      request: staffRequest({
        requestId: options.requestId,
        clientIp: options.clientIp,
      }),
      principal: staffPrincipal,
    });

    const rawBody = await parseJsonBody(options.request);
    const model = resolveLanguageModel(options.assistant);
    if (companySelector === null) {
      throw new CoreInvariantError(
        "staff assistant budget guard requires a verified company selector",
      );
    }
    const budgetCompanyId = canonicalizeAiBudgetCompanyId(companySelector);
    const budgetLimits =
      options.budgetLimits ?? DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS;
    const headerConfirm = confirmationChallengeId !== undefined;
    const budgetHold = await enforceStaffAssistantBudget({
      logger: options.pipeline.logger,
      requestId: options.requestId,
      userId: session.userId,
      companyId: budgetCompanyId,
      skipTurnLimit: headerConfirm,
      ...(options.rateLimitStore === undefined
        ? {}
        : { rateLimitStore: options.rateLimitStore }),
      ...(options.budgetStore === undefined
        ? {}
        : { budgetStore: options.budgetStore }),
      limits: budgetLimits,
    });
    let budgetSettled = false;
    const hostRuntime: Omit<StaffAssistantHostRuntime, "request"> = {
      requestId: options.requestId,
      clientIp: options.clientIp,
      registry: options.registry,
      pipeline: options.pipeline,
      getSession: options.getSession,
      pendingStore,
      conversationLock,
      model,
    };
    try {
      let hostRequest: Request;
      if (headerConfirm) {
        const parsedConfirm = assistantConfirmBodySchema.safeParse({
          conversationId: conversationIdFromBody(rawBody),
          challengeId: confirmationChallengeId,
        });
        if (!parsedConfirm.success) {
          throw new ValidationError(parsedConfirm.error.issues);
        }
        hostRequest = requestWithJsonBody(options.request, parsedConfirm.data);
      } else {
        hostRequest = requestWithJsonBody(options.request, rawBody);
      }
      const response = headerConfirm
        ? await executeStaffAssistantHostConfirm({
            ...hostRuntime,
            request: hostRequest,
          })
        : await executeStaffAssistantHostChat({
            ...hostRuntime,
            request: hostRequest,
          });
      if (response.ok) {
        await recordStaffAssistantBudgetSpend({
          logger: options.pipeline.logger,
          requestId: options.requestId,
          companyId: budgetCompanyId,
          estimatedCostUsd: null,
          hold: budgetHold,
          ...(options.budgetStore === undefined
            ? {}
            : { budgetStore: options.budgetStore }),
          limits: budgetLimits,
        });
        budgetSettled = true;
      }
      return response;
    } finally {
      if (!budgetSettled) {
        await releaseStaffAssistantBudgetHold({
          logger: options.pipeline.logger,
          requestId: options.requestId,
          companyId: budgetCompanyId,
          hold: budgetHold,
          ...(options.budgetStore === undefined
            ? {}
            : { budgetStore: options.budgetStore }),
        });
      }
    }
  } catch (error) {
    if (!(error instanceof RateLimitError)) {
      logFailure(options.pipeline.logger, options.requestId, error);
    }
    return wireResponse(error, options.requestId);
  }
}
