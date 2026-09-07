/**
 * Staff AI SSE mount (SHO-322 / feature SHO-318, ADR-0003, ADR-0032).
 *
 * `POST /assistant/chat` is a dedicated Hono route — not `/rpc`. Session
 * cookie + `x-company-id` match other staff HTTP. Membership is verified
 * by `executeAction` (`assistant.getStaffActor`), never by the selector.
 * Tool `execute` calls `executeAction` with `channel: "ai"`; the adapter
 * never fetches `/rpc`. Missing Anthropic config fails typed after auth;
 * the process still boots.
 */
import {
  attemptKey,
  classifyStaffAssistantTurn,
  createStaffLanguageModel,
  EMPTY_STAFF_ASSISTANT_TURN_USAGE,
  estimateStaffAssistantTurnCostUsd,
  filterStaffAiTools,
  lastStaffAssistantUserMessage,
  pausedToolAttemptForChallenge,
  pausedToolAttemptFromToolRuns,
  resolvePausedToolAttempt,
  StaffAssistantNotConfiguredError,
  staffAssistantCacheHitRatio,
  staffAssistantChatBodySchema,
  staffAssistantGateToolPolicy,
  staffAssistantModelMessages,
  staffAssistantShouldSkipIntentGate,
  staffAssistantTurnContextAddendum,
  staffAssistantUncachedInputTokens,
  staffAssistantWorkingSetAddendum,
  streamStaffAssistantChat,
  STAFF_ASSISTANT_DEFAULT_LOCALE,
  STAFF_ASSISTANT_THINKING_DISABLED,
  STAFF_ASSISTANT_TOOL_RUNS_MAX,
  type LanguageModel,
  type PausedToolAttempt,
  type StaffAssistantChatMessage,
  type StaffAssistantForcedToolName,
  type StaffAssistantGateSkipReason,
  type StaffAssistantGateToolPolicy,
  type StaffAssistantLocale,
  type StaffAssistantTurnResult,
  type StaffAssistantTurnUsage,
} from "@showzy/ai";
import {
  appendUserMessage,
  getConversation,
  getStaffActor,
  recordAssistantTurn,
} from "@showzy/assistant";
import { getCompany } from "@showzy/companies";
import {
  COMPANY_SELECTOR_HEADER,
  CONFIRMATION_CHALLENGE_HEADER,
} from "@showzy/contract";
import { toWireError } from "@showzy/contract/server";
import {
  executeAction,
  type ActionPipelineDeps,
  type ActionRegistry,
  type ImplementedAction,
  type RateLimitStore,
  type SessionPrincipal,
} from "@showzy/core";
import {
  CoreError,
  CoreInvariantError,
  PermissionDeniedError,
  RateLimitError,
  ValidationError,
} from "@showzy/core/errors";
import type { Logger } from "pino";
import type { z } from "zod";

import {
  canonicalizeAiBudgetCompanyId,
  type AiBudgetStore,
} from "../stores/budget.js";
import type { StaffAssistantChoiceStore } from "../stores/choice.js";
import {
  DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS,
  enforceStaffAssistantBudget,
  recordStaffAssistantBudgetSpend,
  staffAssistantBudgetSpendUsd,
  type StaffAssistantBudgetLimits,
} from "./assistant-budget-guard.js";
import { REQUEST_ID_HEADER } from "./request-id.js";

export const ASSISTANT_CHAT_PATH = "/assistant/chat";

export const ASSISTANT_INVOCATION_CHANNEL = "ai" as const;

/**
 * Trade name for the uncached turn-context addendum. `companies.get`
 * requires `documents:view`; a permission denial omits the name line
 * without failing the chat turn (SHO-360).
 */
export async function readStaffAssistantCompanyTradeName(
  load: () => Promise<{ readonly name: string }>,
): Promise<string | undefined> {
  try {
    const company = await load();
    const name = company.name.trim();
    return name === "" ? undefined : name;
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      return undefined;
    }
    throw error;
  }
}

export interface StaffAssistantRuntime {
  readonly model: string;
  readonly gateModel?: string;
  readonly anthropicApiKey?: string;
  /** Tests inject MockLanguageModelV3 — never a live LLM in CI. */
  readonly languageModel?: LanguageModel;
  readonly gateLanguageModel?: LanguageModel;
  /**
   * Tests inject a cost estimate (including `null` for an unpriced model).
   * Production uses `estimateStaffAssistantTurnCostUsd`.
   */
  readonly estimateTurnCostUsd?: (options: {
    readonly reply: StaffAssistantTurnUsage;
    readonly replyModelId: string;
    readonly gate: StaffAssistantTurnUsage;
    readonly gateModelId: string;
  }) => number | null;
}

export interface StaffAssistantChatOptions {
  readonly request: Request;
  readonly requestId: string;
  readonly clientIp: string;
  readonly registry: ActionRegistry;
  readonly pipeline: ActionPipelineDeps;
  readonly getSession: (headers: Headers) => Promise<SessionPrincipal | null>;
  readonly assistant?: StaffAssistantRuntime;
  /**
   * Choice HITL resume (SHO-401 T8) calls this executor with
   * `choiceResume: true`. `POST /assistant/chat` omits it. Not a client
   * header — confirmation resume stays `x-confirmation-challenge-id`.
   */
  readonly choiceResume?: boolean;
  readonly choiceStore?: StaffAssistantChoiceStore;
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

function logTurnUsage(options: {
  readonly logger: Logger;
  readonly requestId: string;
  readonly conversationId: string;
  readonly companyId: string | null;
  readonly actorId: string;
  readonly model: string;
  readonly gateModel?: string;
  readonly gateSkip?: StaffAssistantGateSkipReason;
  readonly gateUsage: StaffAssistantTurnUsage;
  readonly toolsAttached: boolean;
  readonly usage: StaffAssistantTurnUsage;
  readonly modelSteps: number;
  readonly toolNames: readonly string[];
  readonly historyMessageCount: number;
  readonly historyChars: number;
  readonly toolResultBytesIn: number;
  readonly toolResultBytesOut: number;
  readonly toolsetHash: string;
  readonly estimatedCostUsd: number;
}): void {
  options.logger.info(
    {
      request_id: options.requestId,
      conversation_id: options.conversationId,
      company_id: options.companyId,
      actor_id: options.actorId,
      model: options.model,
      ...(options.gateModel !== undefined
        ? { gate_model: options.gateModel }
        : {}),
      thinking: STAFF_ASSISTANT_THINKING_DISABLED,
      tools_attached: options.toolsAttached,
      ...(options.gateSkip !== undefined
        ? { gate_skip: options.gateSkip }
        : {}),
      gate_input_tokens: options.gateUsage.inputTokens,
      gate_output_tokens: options.gateUsage.outputTokens,
      model_steps: options.modelSteps,
      tool_count: options.toolNames.length,
      tool_names: [...options.toolNames],
      input_tokens: options.usage.inputTokens,
      output_tokens: options.usage.outputTokens,
      cache_read_tokens: options.usage.cacheReadTokens,
      cache_write_tokens: options.usage.cacheWriteTokens,
      uncached_input_tokens: staffAssistantUncachedInputTokens(options.usage),
      cache_hit_ratio: staffAssistantCacheHitRatio(options.usage),
      history_message_count: options.historyMessageCount,
      history_chars: options.historyChars,
      tool_result_bytes_in: options.toolResultBytesIn,
      tool_result_bytes_out: options.toolResultBytesOut,
      toolset_hash: options.toolsetHash,
      estimated_cost_usd: options.estimatedCostUsd,
    },
    "staff assistant turn usage",
  );
}

function logTurnGate(options: {
  readonly logger: Logger;
  readonly requestId: string;
  readonly gateModel: string;
  readonly policy: StaffAssistantGateToolPolicy;
  readonly mode?: string;
  readonly intent?: string;
  readonly confidence?: string;
  readonly skip?: StaffAssistantGateSkipReason;
}): void {
  options.logger.info(
    {
      request_id: options.requestId,
      gate_model: options.gateModel,
      ...(options.mode !== undefined ? { gate_mode: options.mode } : {}),
      ...(options.intent !== undefined ? { gate_intent: options.intent } : {}),
      ...(options.confidence !== undefined
        ? { gate_confidence: options.confidence }
        : {}),
      ...(options.policy.kind === "forced"
        ? { gate_forced_tool: options.policy.toolName }
        : {}),
      ...(options.skip !== undefined ? { gate_skip: options.skip } : {}),
    },
    "staff assistant turn gate",
  );
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

function resolveLanguageModel(
  assistant: StaffAssistantRuntime | undefined,
): LanguageModel {
  if (assistant?.languageModel !== undefined) {
    return assistant.languageModel;
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
  throw new StaffAssistantNotConfiguredError();
}

function resolveGateLanguageModel(
  assistant: StaffAssistantRuntime | undefined,
): LanguageModel | undefined {
  if (assistant?.gateLanguageModel !== undefined) {
    return assistant.gateLanguageModel;
  }
  if (
    assistant !== undefined &&
    assistant.anthropicApiKey !== undefined &&
    assistant.anthropicApiKey !== ""
  ) {
    return createStaffLanguageModel({
      apiKey: assistant.anthropicApiKey,
      model: assistant.gateModel ?? assistant.model,
    });
  }
  return undefined;
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
  // The registry erases callback generics so a stored implementation
  // cannot be invoked without pipeline validation (fnd-T9). The
  // pipeline is exactly what runs here, and every registry entry is an
  // `implementAction` output, so restoring the erased shape is sound.
  return implementation as ImplementedAction<z.ZodType, z.ZodType, unknown>;
}

function confirmationResumeIssue(message: string): ValidationError {
  return new ValidationError([
    {
      code: "custom",
      path: ["messages"],
      message,
      input: undefined,
    },
  ]);
}

async function parseChatBody(request: Request): Promise<{
  conversationId: string;
  messages: StaffAssistantChatMessage[];
  locale: StaffAssistantLocale;
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
  const parsed = staffAssistantChatBodySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues);
  }
  return {
    conversationId: parsed.data.conversationId,
    messages: parsed.data.messages,
    locale: parsed.data.locale ?? STAFF_ASSISTANT_DEFAULT_LOCALE,
  };
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

/**
 * Handle `POST /assistant/chat`. Auth denial happens before model
 * construction so a missing Anthropic key cannot mask 401. The language
 * model is resolved before the budget/turn guard so a 503 does not
 * consume a turn slot.
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
  const aiTraceId = options.requestId;
  const staffPrincipal = {
    mode: "staff" as const,
    session,
    companySelector,
  };
  const baseRequest = staffRequest({
    requestId: options.requestId,
    clientIp: options.clientIp,
    aiTraceId,
  });

  try {
    const actor = await executeAction(options.pipeline, {
      action: getStaffActor,
      input: {},
      request: baseRequest,
      principal: staffPrincipal,
    });

    const body = await parseChatBody(options.request);
    const userMessage = lastStaffAssistantUserMessage(body.messages);
    if (userMessage === undefined && confirmationChallengeId === undefined) {
      throw new ValidationError([
        {
          code: "custom",
          path: ["messages"],
          message: "A user message is required.",
          input: undefined,
        },
      ]);
    }

    const modelMessages = staffAssistantModelMessages(body.messages);
    if (modelMessages.length === 0) {
      throw new ValidationError([
        {
          code: "custom",
          path: ["messages"],
          message: "A user message is required.",
          input: undefined,
        },
      ]);
    }

    const conversation = await executeAction(options.pipeline, {
      action: getConversation,
      input: { conversationId: body.conversationId },
      request: baseRequest,
      principal: staffPrincipal,
    });
    const workingSetAddendum = staffAssistantWorkingSetAddendum(
      conversation.toolRuns,
    );
    const companyName = await readStaffAssistantCompanyTradeName(() =>
      executeAction(options.pipeline, {
        action: getCompany,
        input: {},
        request: baseRequest,
        principal: staffPrincipal,
      }),
    );
    const turnContextAddendum = staffAssistantTurnContextAddendum({
      now: new Date(),
      ...(companyName !== undefined ? { companyName } : {}),
      ...(workingSetAddendum !== undefined ? { workingSetAddendum } : {}),
    });

    let pausedAttempt: PausedToolAttempt | undefined;
    if (confirmationChallengeId !== undefined) {
      const clientAttempt = pausedToolAttemptForChallenge(
        body.messages,
        confirmationChallengeId,
      );
      const persistedAttempt = pausedToolAttemptFromToolRuns(
        conversation.toolRuns,
        confirmationChallengeId,
      );
      const resolved = resolvePausedToolAttempt(
        persistedAttempt,
        clientAttempt,
      );
      if (resolved.status === "missing") {
        throw confirmationResumeIssue(
          "A paused tool attempt is required to resume confirmation.",
        );
      }
      if (resolved.status === "mismatch") {
        throw confirmationResumeIssue(
          "Confirmation context does not match the paused tool attempt.",
        );
      }
      pausedAttempt = resolved.attempt;
    }

    const confirmationResume = confirmationChallengeId !== undefined;
    const choiceResume = options.choiceResume === true;
    if (companySelector === null) {
      throw new CoreInvariantError(
        "staff assistant budget guard requires a verified company selector",
      );
    }
    const companyId = canonicalizeAiBudgetCompanyId(companySelector);
    const budgetLimits =
      options.budgetLimits ?? DEFAULT_STAFF_ASSISTANT_BUDGET_LIMITS;
    const model = resolveLanguageModel(options.assistant);
    const gateLanguageModel = resolveGateLanguageModel(options.assistant);
    const budgetHold = await enforceStaffAssistantBudget({
      logger: options.pipeline.logger,
      requestId: options.requestId,
      userId: session.userId,
      companyId,
      skipTurnLimit: confirmationResume || choiceResume,
      ...(options.rateLimitStore === undefined
        ? {}
        : { rateLimitStore: options.rateLimitStore }),
      ...(options.budgetStore === undefined
        ? {}
        : { budgetStore: options.budgetStore }),
      limits: budgetLimits,
    });
    const skipGate = staffAssistantShouldSkipIntentGate({
      confirmationResume,
      choiceResume,
    });
    let gatePolicy: StaffAssistantGateToolPolicy = { kind: "full" };
    let gateRan = false;
    let gateSkip: StaffAssistantGateSkipReason | undefined;
    let gateUsage = EMPTY_STAFF_ASSISTANT_TURN_USAGE;
    let forcedToolName: StaffAssistantForcedToolName | undefined;

    if (!skipGate && gateLanguageModel !== undefined) {
      const lastUserText = userMessage?.text ?? "";
      if (lastUserText.trim() !== "") {
        const classified = await classifyStaffAssistantTurn({
          model: gateLanguageModel,
          lastUserText,
          abortSignal: options.request.signal,
        });
        gatePolicy = staffAssistantGateToolPolicy(classified);
        gateUsage = classified.usage;
        gateRan = true;
        if (gatePolicy.kind === "forced") {
          forcedToolName = gatePolicy.toolName;
        }
        logTurnGate({
          logger: options.pipeline.logger,
          requestId: options.requestId,
          gateModel: options.assistant?.gateModel ?? "unconfigured",
          policy: gatePolicy,
          mode: classified.mode,
          ...(classified.intent !== undefined
            ? { intent: classified.intent }
            : {}),
          confidence: classified.confidence,
        });
      }
    } else if (skipGate) {
      gateSkip = confirmationResume ? "confirmation_resume" : "choice_resume";
      logTurnGate({
        logger: options.pipeline.logger,
        requestId: options.requestId,
        gateModel: options.assistant?.gateModel ?? "unconfigured",
        policy: { kind: "full" },
        skip: gateSkip,
      });
    }

    const attachTools = gatePolicy.kind !== "none";
    const replyModel =
      !attachTools && gateLanguageModel !== undefined
        ? gateLanguageModel
        : model;
    const replyModelId = attachTools
      ? (options.assistant?.model ?? "unconfigured")
      : (options.assistant?.gateModel ??
        options.assistant?.model ??
        "unconfigured");

    if (userMessage !== undefined) {
      await executeAction(options.pipeline, {
        action: appendUserMessage,
        input: {
          conversationId: body.conversationId,
          body: userMessage.text,
        },
        request: staffRequest({
          requestId: options.requestId,
          clientIp: options.clientIp,
          aiTraceId,
          idempotencyKey: attemptKey(
            "message",
            body.conversationId,
            userMessage.id,
          ),
        }),
        principal: staffPrincipal,
      });
    }

    const contracts = filterStaffAiTools(options.registry.contracts(), {
      role: actor.role,
      permissions: actor.permissions,
    });
    const streamContracts = attachTools ? contracts : [];

    let confirmationClaimed = false;
    function claimPausedAttempt(
      actionName: string,
      requiresConfirmation: boolean,
    ): PausedToolAttempt | undefined {
      if (
        confirmationClaimed ||
        confirmationChallengeId === undefined ||
        pausedAttempt === undefined ||
        !requiresConfirmation ||
        actionName !== pausedAttempt.actionName
      ) {
        return undefined;
      }
      confirmationClaimed = true;
      return pausedAttempt;
    }

    const { response } = streamStaffAssistantChat({
      model: replyModel,
      messages: modelMessages,
      contracts: streamContracts,
      ...(forcedToolName !== undefined ? { forcedToolName } : {}),
      abortSignal: options.request.signal,
      turnContextAddendum,
      locale: body.locale,
      responseHeaders: {
        "cache-control": "private, no-store",
        [REQUEST_ID_HEADER]: options.requestId,
      },
      choiceBind: {
        actorId: session.userId,
        companyId,
        conversationId: body.conversationId,
      },
      ...(options.choiceStore === undefined
        ? {}
        : (() => {
            const choiceStore = options.choiceStore;
            return {
              openChoice: (
                record: Parameters<StaffAssistantChoiceStore["open"]>[0],
              ) => choiceStore.open(record),
            };
          })()),
      execute: (actionName, input, toolOptions) => {
        const action = requireImplementation(options.registry, actionName);
        const resumedAttempt = claimPausedAttempt(
          action.contract.name,
          action.contract.requiresConfirmation,
        );
        const logicalToolCallId =
          resumedAttempt?.toolCallId ?? toolOptions.toolCallId;
        const idempotencyKey = action.contract.idempotent
          ? attemptKey("tool", body.conversationId, logicalToolCallId)
          : undefined;
        return executeAction(options.pipeline, {
          action,
          input,
          request: staffRequest({
            requestId: options.requestId,
            clientIp: options.clientIp,
            aiTraceId,
            toolCallId: toolOptions.toolCallId,
            ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
            ...(resumedAttempt !== undefined &&
            confirmationChallengeId !== undefined
              ? { confirmationChallengeId }
              : {}),
          }),
          principal: staffPrincipal,
        });
      },
      onTurn: async (turn) => {
        const estimateTurnCostUsd =
          options.assistant?.estimateTurnCostUsd ??
          estimateStaffAssistantTurnCostUsd;
        const estimatedCostUsd = estimateTurnCostUsd({
          reply: turn.usage,
          replyModelId,
          gate: gateUsage,
          gateModelId:
            options.assistant?.gateModel ??
            options.assistant?.model ??
            "unconfigured",
        });
        logTurnUsage({
          logger: options.pipeline.logger,
          requestId: options.requestId,
          conversationId: body.conversationId,
          companyId,
          actorId: session.userId,
          model: replyModelId,
          ...(gateRan && options.assistant?.gateModel !== undefined
            ? { gateModel: options.assistant.gateModel }
            : {}),
          ...(gateSkip !== undefined
            ? {
                gateModel:
                  options.assistant?.gateModel ??
                  options.assistant?.model ??
                  "unconfigured",
                gateSkip,
              }
            : {}),
          gateUsage,
          toolsAttached: turn.toolsAttached,
          usage: turn.usage,
          modelSteps: turn.modelSteps,
          toolNames: turn.toolRuns
            .slice(0, STAFF_ASSISTANT_TOOL_RUNS_MAX)
            .map((run) => run.actionName),
          historyMessageCount: turn.historyMessageCount,
          historyChars: turn.historyChars,
          toolResultBytesIn: turn.toolResultBytesIn,
          toolResultBytesOut: turn.toolResultBytesOut,
          toolsetHash: turn.toolsetHash,
          estimatedCostUsd: staffAssistantBudgetSpendUsd(
            estimatedCostUsd,
            budgetLimits.unknownModelTurnUsd,
          ),
        });
        await recordStaffAssistantBudgetSpend({
          logger: options.pipeline.logger,
          requestId: options.requestId,
          companyId,
          estimatedCostUsd,
          hold: budgetHold,
          ...(options.budgetStore === undefined
            ? {}
            : { budgetStore: options.budgetStore }),
          limits: budgetLimits,
        });
        try {
          await persistAssistantTurn({
            pipeline: options.pipeline,
            conversationId: body.conversationId,
            requestId: options.requestId,
            clientIp: options.clientIp,
            aiTraceId,
            principal: staffPrincipal,
            turn,
          });
        } catch (error: unknown) {
          logFailure(options.pipeline.logger, options.requestId, error);
          throw error;
        }
      },
    });

    return response;
  } catch (error) {
    if (!(error instanceof RateLimitError)) {
      logFailure(options.pipeline.logger, options.requestId, error);
    }
    return wireResponse(error, options.requestId);
  }
}

async function persistAssistantTurn(options: {
  readonly pipeline: ActionPipelineDeps;
  readonly conversationId: string;
  readonly requestId: string;
  readonly clientIp: string;
  readonly aiTraceId: string;
  readonly principal: {
    readonly mode: "staff";
    readonly session: SessionPrincipal;
    readonly companySelector: string | null;
  };
  readonly turn: StaffAssistantTurnResult;
}): Promise<void> {
  await executeAction(options.pipeline, {
    action: recordAssistantTurn,
    input: {
      conversationId: options.conversationId,
      body: options.turn.text,
      toolRuns: options.turn.toolRuns.map((run) => ({
        actionName: run.actionName,
        toolCallId: run.toolCallId,
        ...(run.challengeId !== undefined
          ? { challengeId: run.challengeId }
          : {}),
        resultIds: [...run.resultIds],
        outcome: run.outcome,
      })),
    },
    request: staffRequest({
      requestId: options.requestId,
      clientIp: options.clientIp,
      aiTraceId: options.aiTraceId,
      idempotencyKey: attemptKey(
        "turn",
        options.conversationId,
        options.requestId,
      ),
    }),
    principal: options.principal,
  });
}
