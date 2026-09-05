/**
 * Authenticated choice resume (SHO-409 / SHO-401 T8a). Sibling of
 * `POST /assistant/chat` — no gate, no model, no confirmation GETDEL.
 *
 * Session, actor, company, and conversation are resolved before Redis.
 * Client body is `{ conversationId, choiceId, optionId }` only.
 */
import {
  applyChoiceOptionToCanonicalInput,
  assistantChoiceBodySchema,
  attemptKey,
  catalogDomainErrorExtrasFromError,
  catalogPickerConflictExtrasFromError,
  choiceRecordFromPickerConflict,
  extractUuidResultIds,
  peekEnvelopeFromRecord,
  presentCatalogDomainError,
  presentChoiceStaffAssistantNeedsChoice,
  presentCompletedStaffAssistantTurn,
  resolveMappedVariantId,
  STAFF_ASSISTANT_DEFAULT_LOCALE,
  successorChoiceId,
  type AssistantChoiceInteractionResult,
  type CatalogPickerConflictExtras,
  type ChoiceRecord,
  type StaffAssistantChoiceCardEnvelope,
} from "@showzy/ai";
import {
  getConversation,
  getStaffActor,
  recordAssistantTurn,
} from "@showzy/assistant";
import { ReferenceResolutionConflictError } from "@showzy/catalog";
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
  CoreError,
  CoreInvariantError,
  ValidationError,
} from "@showzy/core/errors";
import type { z } from "zod";

import type { StaffAssistantChoiceStore } from "../stores/choice.js";
import { ASSISTANT_INVOCATION_CHANNEL } from "./assistant-chat.js";
import { REQUEST_ID_HEADER } from "./request-id.js";

export const ASSISTANT_CHOICE_PATH = "/assistant/choice";

export interface StaffAssistantChoiceOptions {
  readonly request: Request;
  readonly requestId: string;
  readonly clientIp: string;
  readonly registry: ActionRegistry;
  readonly pipeline: ActionPipelineDeps;
  readonly getSession: (headers: Headers) => Promise<SessionPrincipal | null>;
  readonly choiceStore: StaffAssistantChoiceStore;
  readonly choiceId?: string;
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
  result: AssistantChoiceInteractionResult,
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
  };
}

async function parseChoiceBody(request: Request): Promise<{
  conversationId: string;
  choiceId: string;
  optionId: string;
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
  const parsed = assistantChoiceBodySchema.safeParse(raw);
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
  // Registry erases callback generics; pipeline validation still runs.
  return implementation as ImplementedAction<z.ZodType, z.ZodType, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireCompanyId(companySelector: string | null): string {
  if (companySelector === null) {
    throw new CoreInvariantError(
      "staff assistant choice resume missing verified company selector",
    );
  }
  return companySelector;
}

function choiceToolCallId(choiceId: string): string {
  return `choice:${choiceId}`;
}

function expiredResult(): AssistantChoiceInteractionResult {
  return { status: "expired" };
}

function errorResult(
  code: string,
  message: string,
): AssistantChoiceInteractionResult {
  return { status: "error", code, message };
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

function completedEntity(output: unknown): {
  orderId: string;
  orderNumber: string;
} {
  if (!isRecord(output)) {
    throw new CoreInvariantError(
      "orders.create choice resume returned a non-object",
    );
  }
  const orderId = output["orderId"];
  const orderNumber = output["orderNumber"];
  if (typeof orderId !== "string" || orderId === "") {
    throw new CoreInvariantError("orders.create choice resume missing orderId");
  }
  if (typeof orderNumber !== "string" || orderNumber === "") {
    throw new CoreInvariantError(
      "orders.create choice resume missing orderNumber",
    );
  }
  return { orderId, orderNumber };
}

async function persistChoiceTurn(options: {
  readonly pipeline: ActionPipelineDeps;
  readonly conversationId: string;
  readonly choiceId: string;
  readonly requestId: string;
  readonly clientIp: string;
  readonly principal: {
    readonly mode: "staff";
    readonly session: SessionPrincipal;
    readonly companySelector: string | null;
  };
  readonly body: string;
  readonly toolCallId: string;
  readonly resultIds: readonly string[];
  readonly outcome: "success" | "choice_required" | "error";
  readonly challengeId?: string;
}): Promise<void> {
  await executeAction(options.pipeline, {
    action: recordAssistantTurn,
    input: {
      conversationId: options.conversationId,
      body: options.body,
      toolRuns: [
        {
          actionName: "orders.create",
          toolCallId: options.toolCallId,
          resultIds: [...options.resultIds],
          outcome: options.outcome,
          ...(options.challengeId !== undefined
            ? { challengeId: options.challengeId }
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
        options.choiceId,
      ),
    }),
    principal: options.principal,
  });
}

async function openSuccessorChoice(options: {
  readonly store: StaffAssistantChoiceStore;
  readonly parent: ChoiceRecord;
  readonly patchedInput: ChoiceRecord["canonicalInput"];
  readonly extras: CatalogPickerConflictExtras;
}): Promise<ChoiceRecord | undefined> {
  const nextId = successorChoiceId(options.parent.choiceId);
  const next = choiceRecordFromPickerConflict({
    choiceId: nextId,
    bind: {
      actorId: options.parent.actorId,
      companyId: options.parent.companyId,
      conversationId: options.parent.conversationId,
    },
    canonicalInput: options.patchedInput,
    extras: options.extras,
    ...(options.parent.locale !== undefined
      ? { locale: options.parent.locale }
      : {}),
  });
  if (next === undefined) {
    return undefined;
  }
  await options.store.open(next);
  const peeked = await options.store.peek({
    choiceId: nextId,
    bind: {
      actorId: next.actorId,
      companyId: next.companyId,
      conversationId: next.conversationId,
    },
  });
  if (peeked.kind !== "found") {
    throw new CoreInvariantError(
      "choice resume could not read the successor choice record",
    );
  }
  return peeked.record;
}

/**
 * `POST /assistant/choice`. Auth denial happens before any Redis claim.
 */
export async function executeStaffAssistantChoiceResume(
  options: StaffAssistantChoiceOptions,
): Promise<Response> {
  const session = await options.getSession(options.request.headers);
  if (session === null) {
    return unauthenticatedResponse(options.requestId);
  }

  const companySelector = headerOrNull(
    options.request.headers,
    COMPANY_SELECTOR_HEADER,
  );
  const staffPrincipal = {
    mode: "staff" as const,
    session,
    companySelector,
  };

  try {
    const body = await parseChoiceBody(options.request);
    const conversation = await resolveStaffConversation({
      pipeline: options.pipeline,
      requestId: options.requestId,
      clientIp: options.clientIp,
      conversationId: body.conversationId,
      staffPrincipal,
    });
    const companyId = requireCompanyId(companySelector);
    const bind = {
      actorId: session.userId,
      companyId,
      conversationId: conversation.id,
    };
    const claimed = await options.choiceStore.claim({
      choiceId: body.choiceId,
      bind,
      optionId: body.optionId,
    });
    if (claimed.kind === "expired" || claimed.kind === "forbidden") {
      return interactionResponse(expiredResult(), options.requestId);
    }
    if (claimed.kind === "conflict") {
      return interactionResponse(
        errorResult(
          "CHOICE_OPTION_CONFLICT",
          "This choice was already resolved with a different option.",
        ),
        options.requestId,
      );
    }
    if (claimed.kind === "invalid_option") {
      return interactionResponse(
        errorResult("CHOICE_INVALID_OPTION", "That option is not available."),
        options.requestId,
      );
    }

    const record = claimed.record;
    const mappedId = resolveMappedVariantId(record.optionMap, body.optionId);
    if (mappedId === undefined) {
      return interactionResponse(
        errorResult("CHOICE_INVALID_OPTION", "That option is not available."),
        options.requestId,
      );
    }
    const patched = applyChoiceOptionToCanonicalInput(
      record.canonicalInput,
      record.target,
      mappedId,
    );
    const locale = record.locale ?? STAFF_ASSISTANT_DEFAULT_LOCALE;
    const toolCallId = choiceToolCallId(record.choiceId);
    const createAction = requireImplementation(
      options.registry,
      "orders.create",
    );

    try {
      const output: unknown = await executeAction(options.pipeline, {
        action: createAction,
        input: patched,
        request: staffRequest({
          requestId: options.requestId,
          clientIp: options.clientIp,
          aiTraceId: options.requestId,
          toolCallId,
          idempotencyKey: attemptKey(
            "choice",
            conversation.id,
            record.choiceId,
          ),
        }),
        principal: staffPrincipal,
      });
      const entity = completedEntity(output);
      const text =
        presentCompletedStaffAssistantTurn({
          locale,
          toolResults: [{ toolName: "orders.create", output }],
        }) ?? `Order ${entity.orderNumber}.`;
      await persistChoiceTurn({
        pipeline: options.pipeline,
        conversationId: conversation.id,
        choiceId: record.choiceId,
        requestId: options.requestId,
        clientIp: options.clientIp,
        principal: staffPrincipal,
        body: text,
        toolCallId,
        challengeId: record.choiceId,
        resultIds: extractUuidResultIds(output),
        outcome: "success",
      });
      await options.choiceStore.complete({
        choiceId: record.choiceId,
        bind,
        optionId: body.optionId,
      });
      return interactionResponse(
        { status: "completed", text, entity },
        options.requestId,
      );
    } catch (error) {
      const extras = catalogPickerConflictExtrasFromError(error);
      if (extras !== undefined) {
        const next = await openSuccessorChoice({
          store: options.choiceStore,
          parent: record,
          patchedInput: patched,
          extras,
        });
        if (next !== undefined) {
          const needsChoice = presentChoiceStaffAssistantNeedsChoice({
            locale,
            record: next,
          });
          await persistChoiceTurn({
            pipeline: options.pipeline,
            conversationId: conversation.id,
            choiceId: record.choiceId,
            requestId: options.requestId,
            clientIp: options.clientIp,
            principal: staffPrincipal,
            body: needsChoice.text,
            toolCallId: choiceToolCallId(next.choiceId),
            challengeId: next.choiceId,
            resultIds: [],
            outcome: "choice_required",
          });
          await options.choiceStore.complete({
            choiceId: record.choiceId,
            bind,
            optionId: body.optionId,
          });
          return interactionResponse(needsChoice, options.requestId);
        }
      }
      const domainError = catalogDomainErrorExtrasFromError(error);
      if (domainError !== undefined) {
        const text = presentCatalogDomainError({
          locale,
          extras: domainError,
        });
        await persistChoiceTurn({
          pipeline: options.pipeline,
          conversationId: conversation.id,
          choiceId: record.choiceId,
          requestId: options.requestId,
          clientIp: options.clientIp,
          principal: staffPrincipal,
          body: text,
          toolCallId,
          resultIds: [],
          outcome: "error",
        });
        await options.choiceStore.complete({
          choiceId: record.choiceId,
          bind,
          optionId: body.optionId,
        });
        return interactionResponse(
          errorResult(
            error instanceof CoreError ? error.code : "CONFLICT",
            text,
          ),
          options.requestId,
        );
      }
      if (error instanceof ReferenceResolutionConflictError) {
        await persistChoiceTurn({
          pipeline: options.pipeline,
          conversationId: conversation.id,
          choiceId: record.choiceId,
          requestId: options.requestId,
          clientIp: options.clientIp,
          principal: staffPrincipal,
          body: error.clientMessage,
          toolCallId,
          resultIds: [],
          outcome: "error",
        });
        await options.choiceStore.complete({
          choiceId: record.choiceId,
          bind,
          optionId: body.optionId,
        });
        return interactionResponse(
          errorResult(error.code, error.clientMessage),
          options.requestId,
        );
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof CoreError) {
      options.pipeline.logger.error(
        {
          request_id: options.requestId,
          code: error.code,
        },
        "staff assistant choice resume failed",
      );
    }
    return wireResponse(error, options.requestId);
  }
}

/**
 * `GET /assistant/choice/:choiceId?conversationId=`. Safe peek only.
 */
export async function executeStaffAssistantChoicePeek(
  options: StaffAssistantChoiceOptions,
): Promise<Response> {
  const session = await options.getSession(options.request.headers);
  if (session === null) {
    return unauthenticatedResponse(options.requestId);
  }

  const companySelector = headerOrNull(
    options.request.headers,
    COMPANY_SELECTOR_HEADER,
  );
  const staffPrincipal = {
    mode: "staff" as const,
    session,
    companySelector,
  };

  try {
    const url = new URL(options.request.url);
    const conversationId = url.searchParams.get("conversationId");
    const choiceId = options.choiceId ?? url.pathname.split("/").at(-1);
    if (
      conversationId === null ||
      conversationId === "" ||
      choiceId === undefined ||
      choiceId === ""
    ) {
      throw new ValidationError([
        {
          code: "custom",
          path: ["conversationId"],
          message: "conversationId and choiceId are required.",
          input: undefined,
        },
      ]);
    }
    const parsedConversation =
      assistantChoiceBodySchema.shape.conversationId.safeParse(conversationId);
    const parsedChoice =
      assistantChoiceBodySchema.shape.choiceId.safeParse(choiceId);
    if (!parsedConversation.success || !parsedChoice.success) {
      throw new ValidationError([
        {
          code: "custom",
          path: ["choiceId"],
          message: "conversationId and choiceId must be UUIDs.",
          input: undefined,
        },
      ]);
    }
    const conversation = await resolveStaffConversation({
      pipeline: options.pipeline,
      requestId: options.requestId,
      clientIp: options.clientIp,
      conversationId: parsedConversation.data,
      staffPrincipal,
    });
    const companyId = requireCompanyId(companySelector);
    const peeked = await options.choiceStore.peek({
      choiceId: parsedChoice.data,
      bind: {
        actorId: session.userId,
        companyId,
        conversationId: conversation.id,
      },
    });
    if (peeked.kind === "expired" || peeked.kind === "forbidden") {
      const expired: Pick<StaffAssistantChoiceCardEnvelope, "status"> = {
        status: "expired",
      };
      return jsonResponse(200, expired, options.requestId);
    }
    const envelope = peekEnvelopeFromRecord(peeked.record);
    return jsonResponse(200, envelope, options.requestId);
  } catch (error) {
    if (error instanceof CoreError) {
      options.pipeline.logger.error(
        {
          request_id: options.requestId,
          code: error.code,
        },
        "staff assistant choice peek failed",
      );
    }
    return wireResponse(error, options.requestId);
  }
}
