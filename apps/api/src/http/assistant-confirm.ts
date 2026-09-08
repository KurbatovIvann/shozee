/**
 * Authenticated confirmation resume (SHO-516 / ADR-0035). Sibling of
 * `POST /assistant/choice` — no gate, no model, no confirmation GETDEL
 * of the api record. Core still GETDELs its challenge.
 *
 * Session, actor, company, and conversation are resolved before Redis.
 * Client body is `{ conversationId, challengeId }` only.
 */
import {
  assistantConfirmBodySchema,
  attemptKey,
  clipStaffAssistantToolResult,
  commitTurnSpeech,
  extractUuidResultIds,
  presentConfirmationDoneSpeech,
  STAFF_ASSISTANT_CONFIRMATION_EXPIRED_COPY,
  toProviderToolName,
  type AssistantConfirmInteractionResult,
  type ConfirmationPendingRecord,
  type ConfirmationResumeResult,
  type StaffAssistantLocale,
} from "@showzy/ai";
import {
  getConversation,
  getStaffActor,
  recordAssistantTurn,
} from "@showzy/assistant";
import { COMPANY_SELECTOR_HEADER } from "@showzy/contract";
import { toWireError } from "@showzy/contract/server";
import {
  executeAction,
  type ActionPipelineDeps,
  type ActionRegistry,
  type ImplementedAction,
  type SessionPrincipal,
} from "@showzy/core";
import {
  ConcurrentRetryError,
  ConfirmationRequiredError,
  CoreError,
  CoreInvariantError,
  RateLimitError,
  TimeoutError,
  ValidationError,
} from "@showzy/core/errors";
import type { z } from "zod";

import {
  isConfirmationPendingRecord,
  type StaffAssistantPendingInteractionStore,
} from "../stores/pending-interaction.js";
import { ASSISTANT_INVOCATION_CHANNEL } from "./assistant-invocation.js";
import { REQUEST_ID_HEADER } from "./request-id.js";

export const ASSISTANT_CONFIRM_PATH = "/assistant/confirm";

const CONFIRMATION_RESOLUTION = "confirmed" as const;

export interface StaffAssistantConfirmOptions {
  readonly request: Request;
  readonly requestId: string;
  readonly clientIp: string;
  readonly registry: ActionRegistry;
  readonly pipeline: ActionPipelineDeps;
  readonly getSession: (headers: Headers) => Promise<SessionPrincipal | null>;
  readonly pendingStore: StaffAssistantPendingInteractionStore;
}

export interface PendingConfirmationResumeInput {
  readonly conversationId: string;
  readonly challengeId: string;
  readonly requestId: string;
  readonly clientIp: string;
  readonly registry: ActionRegistry;
  readonly pipeline: ActionPipelineDeps;
  readonly pendingStore: StaffAssistantPendingInteractionStore;
  readonly session: SessionPrincipal;
  readonly companySelector: string | null;
}

function headerOrNull(headers: Headers, name: string): string | null {
  const value = headers.get(name);
  return value === null || value === "" ? null : value;
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

function interactionResponse(
  result: AssistantConfirmInteractionResult,
  requestId: string,
): Response {
  return jsonResponse(200, result, requestId);
}

function staffRequest(options: {
  readonly requestId: string;
  readonly clientIp: string;
  readonly aiTraceId: string;
  readonly toolCallId?: string;
  readonly idempotencyKey?: string;
  readonly confirmationChallengeId?: string;
}) {
  return {
    requestId: options.requestId,
    correlationId: options.requestId,
    channel: ASSISTANT_INVOCATION_CHANNEL,
    clientIp: options.clientIp,
    aiTraceId: options.aiTraceId,
    ...(options.toolCallId !== undefined
      ? { toolCallId: options.toolCallId }
      : {}),
    ...(options.idempotencyKey !== undefined
      ? { idempotencyKey: options.idempotencyKey }
      : {}),
    ...(options.confirmationChallengeId !== undefined
      ? { confirmationChallengeId: options.confirmationChallengeId }
      : {}),
  };
}

async function parseConfirmBody(request: Request): Promise<{
  conversationId: string;
  challengeId: string;
}> {
  let raw: unknown;
  try {
    raw = await request.json();
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
  const parsed = assistantConfirmBodySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues);
  }
  return parsed.data;
}

function requireImplementation(
  registry: ActionRegistry,
  name: string,
): ImplementedAction<z.ZodType, z.ZodType, unknown> {
  const implementation = registry.getImplementation(name);
  if (implementation === undefined) {
    throw new CoreInvariantError(
      `staff assistant tool "${name}" is not registered`,
    );
  }
  return implementation as ImplementedAction<z.ZodType, z.ZodType, unknown>;
}

function requireCompanyId(companySelector: string | null): string {
  if (companySelector === null) {
    throw new CoreInvariantError(
      "staff assistant confirmation resume missing verified company selector",
    );
  }
  return companySelector;
}

function expiredResult(): AssistantConfirmInteractionResult {
  return { status: "expired" };
}

function errorResult(
  code: string,
  message: string,
): AssistantConfirmInteractionResult {
  return { status: "error", code, message };
}

function expiredCopy(locale: StaffAssistantLocale): string {
  return STAFF_ASSISTANT_CONFIRMATION_EXPIRED_COPY[locale];
}

function toHttpResult(
  stored: ConfirmationResumeResult,
): AssistantConfirmInteractionResult {
  if (stored.status === "completed") {
    return {
      status: "completed",
      text: stored.text,
      actionName: stored.actionName,
      toolCallId: stored.toolCallId,
      ...(stored.output !== undefined ? { output: stored.output } : {}),
      ...(stored.presentation !== undefined
        ? { presentation: stored.presentation }
        : {}),
    };
  }
  if (stored.status === "error") {
    return errorResult(
      stored.code ?? "INTERNAL",
      stored.message ?? stored.text,
    );
  }
  return expiredResult();
}

async function resolveStaffConversation(options: {
  readonly pipeline: ActionPipelineDeps;
  readonly requestId: string;
  readonly clientIp: string;
  readonly conversationId: string;
  readonly staffPrincipal: {
    readonly mode: "staff";
    readonly session: SessionPrincipal;
    readonly companySelector: string | null;
  };
}) {
  const baseRequest = staffRequest({
    requestId: options.requestId,
    clientIp: options.clientIp,
    aiTraceId: options.requestId,
  });
  await executeAction(options.pipeline, {
    action: getStaffActor,
    input: {},
    request: baseRequest,
    principal: options.staffPrincipal,
  });
  return executeAction(options.pipeline, {
    action: getConversation,
    input: { conversationId: options.conversationId },
    request: baseRequest,
    principal: options.staffPrincipal,
  });
}

async function persistConfirmationTurn(options: {
  readonly pipeline: ActionPipelineDeps;
  readonly conversationId: string;
  readonly challengeId: string;
  readonly requestId: string;
  readonly clientIp: string;
  readonly principal: {
    readonly mode: "staff";
    readonly session: SessionPrincipal;
    readonly companySelector: string | null;
  };
  readonly body: string;
  readonly actionName: string;
  readonly toolCallId: string;
  readonly resultIds: readonly string[];
  readonly outcome: "success" | "error";
  readonly modelTrace?: unknown;
  readonly toolName?: string;
}): Promise<void> {
  await executeAction(options.pipeline, {
    action: recordAssistantTurn,
    input: {
      conversationId: options.conversationId,
      body: options.body,
      toolRuns: [
        {
          actionName: options.actionName,
          toolCallId: options.toolCallId,
          resultIds: [...options.resultIds],
          outcome: options.outcome,
          ...(options.toolName !== undefined && options.toolName.length > 0
            ? { toolName: options.toolName }
            : {}),
          ...(options.outcome === "success" && options.modelTrace !== undefined
            ? { modelTrace: options.modelTrace }
            : {}),
        },
      ],
    },
    request: staffRequest({
      requestId: options.requestId,
      clientIp: options.clientIp,
      aiTraceId: options.requestId,
      idempotencyKey: attemptKey(
        "turn",
        options.conversationId,
        options.challengeId,
      ),
    }),
    principal: options.principal,
  });
}

async function markCompleted(
  store: StaffAssistantPendingInteractionStore,
  record: ConfirmationPendingRecord,
  bind: { actorId: string; companyId: string; conversationId: string },
  resumeResult: ConfirmationResumeResult,
): Promise<void> {
  await store.complete({
    kind: "confirmation",
    id: record.id,
    bind,
    resolution: CONFIRMATION_RESOLUTION,
    resumeResult,
  });
}

function isRetryableConfirmationResumeError(error: unknown): boolean {
  return (
    error instanceof ConcurrentRetryError ||
    error instanceof RateLimitError ||
    error instanceof TimeoutError
  );
}

/**
 * Modelless executor for `POST /assistant/confirm`. Temporary pipeline
 * errors leave the record claimed so a later POST can finish.
 */
export async function runPendingConfirmationResume(
  options: PendingConfirmationResumeInput,
): Promise<AssistantConfirmInteractionResult> {
  const staffPrincipal = {
    mode: "staff" as const,
    session: options.session,
    companySelector: options.companySelector,
  };
  const conversation = await resolveStaffConversation({
    pipeline: options.pipeline,
    requestId: options.requestId,
    clientIp: options.clientIp,
    conversationId: options.conversationId,
    staffPrincipal,
  });
  const companyId = requireCompanyId(options.companySelector);
  const bind = {
    actorId: options.session.userId,
    companyId,
    conversationId: conversation.id,
  };
  const claimed = await options.pendingStore.claim({
    kind: "confirmation",
    id: options.challengeId,
    bind,
    resolution: CONFIRMATION_RESOLUTION,
  });
  if (claimed.kind === "expired" || claimed.kind === "forbidden") {
    return expiredResult();
  }
  if (claimed.kind === "conflict" || claimed.kind === "invalid_option") {
    return errorResult(
      "CONFIRMATION_CONFLICT",
      "This confirmation was already resolved.",
    );
  }
  const pending = claimed.record;
  if (!isConfirmationPendingRecord(pending)) {
    return expiredResult();
  }
  if (pending.status === "completed" && pending.resumeResult !== undefined) {
    return toHttpResult(pending.resumeResult);
  }
  const locale = pending.locale;
  const action = requireImplementation(options.registry, pending.actionName);
  const toolName = toProviderToolName(pending.actionName);

  const persistTerminalFailure = async (
    code: string,
    protocolOverride: string,
  ): Promise<AssistantConfirmInteractionResult> => {
    const speech = commitTurnSpeech({
      locale,
      toolResults: [],
      rawText: "",
      runs: [{ outcome: "error" }],
      protocolOverride,
    });
    await persistConfirmationTurn({
      pipeline: options.pipeline,
      conversationId: conversation.id,
      challengeId: pending.id,
      requestId: options.requestId,
      clientIp: options.clientIp,
      principal: staffPrincipal,
      body: speech.text,
      actionName: pending.actionName,
      toolCallId: pending.toolCallId,
      resultIds: [],
      outcome: "error",
      toolName,
    });
    const resumeResult: ConfirmationResumeResult = {
      status: "error",
      text: speech.text,
      code,
      message: speech.text,
    };
    await markCompleted(options.pendingStore, pending, bind, resumeResult);
    return toHttpResult(resumeResult);
  };

  let output: unknown;
  try {
    output = await executeAction(options.pipeline, {
      action,
      input: pending.canonicalInput,
      request: staffRequest({
        requestId: options.requestId,
        clientIp: options.clientIp,
        aiTraceId: options.requestId,
        toolCallId: pending.toolCallId,
        idempotencyKey: attemptKey("tool", conversation.id, pending.toolCallId),
        confirmationChallengeId: pending.id,
      }),
      principal: staffPrincipal,
    });
  } catch (error) {
    if (isRetryableConfirmationResumeError(error)) {
      throw error;
    }
    if (error instanceof ConfirmationRequiredError) {
      return persistTerminalFailure(error.code, expiredCopy(locale));
    }
    if (error instanceof CoreError) {
      return persistTerminalFailure(error.code, error.clientMessage);
    }
    throw error;
  }

  const clipped = clipStaffAssistantToolResult(output);
  const speech = commitTurnSpeech({
    locale,
    toolResults: [
      {
        toolName,
        output: clipped,
        toolCallId: pending.toolCallId,
      },
    ],
    rawText: "",
    runs: [{ outcome: "success" }],
    protocolOverride: presentConfirmationDoneSpeech({
      locale,
      actionName: pending.actionName,
    }),
  });
  const resumeResult: ConfirmationResumeResult = {
    status: "completed",
    text: speech.text,
    actionName: pending.actionName,
    toolCallId: pending.toolCallId,
    output: clipped,
  };
  // Domain write already committed. If persist or complete throws, the
  // record stays claimed so a later POST can finish.
  await persistConfirmationTurn({
    pipeline: options.pipeline,
    conversationId: conversation.id,
    challengeId: pending.id,
    requestId: options.requestId,
    clientIp: options.clientIp,
    principal: staffPrincipal,
    body: speech.text,
    actionName: pending.actionName,
    toolCallId: pending.toolCallId,
    resultIds: extractUuidResultIds(output),
    outcome: "success",
    modelTrace: clipped,
    toolName,
  });
  await markCompleted(options.pendingStore, pending, bind, resumeResult);
  return toHttpResult(resumeResult);
}

/**
 * `POST /assistant/confirm`. Auth denial happens before any Redis claim.
 */
export async function executeStaffAssistantConfirmResume(
  options: StaffAssistantConfirmOptions,
): Promise<Response> {
  const session = await options.getSession(options.request.headers);
  if (session === null) {
    return unauthenticatedResponse(options.requestId);
  }

  const companySelector = headerOrNull(
    options.request.headers,
    COMPANY_SELECTOR_HEADER,
  );

  try {
    const body = await parseConfirmBody(options.request);
    const result = await runPendingConfirmationResume({
      conversationId: body.conversationId,
      challengeId: body.challengeId,
      requestId: options.requestId,
      clientIp: options.clientIp,
      registry: options.registry,
      pipeline: options.pipeline,
      pendingStore: options.pendingStore,
      session,
      companySelector,
    });
    return interactionResponse(result, options.requestId);
  } catch (error) {
    if (error instanceof CoreError) {
      options.pipeline.logger.error(
        {
          request_id: options.requestId,
          code: error.code,
        },
        "staff assistant confirmation resume failed",
      );
    }
    return wireResponse(error, options.requestId);
  }
}
