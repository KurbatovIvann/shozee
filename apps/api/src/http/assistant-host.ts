/**
 * Staff-assistant host (SHO-522 / SHO-524 / ADR-0037).
 *
 * Live `createApp` mounts choice, confirm, pending peek, and abandon.
 * `POST /assistant/host/chat` stays off production — live chat is
 * `POST /assistant/chat` wrapping `executeStaffAssistantHostChat`.
 */
import { randomUUID } from "node:crypto";

import {
  applyChoiceOptionToCanonicalInput,
  assistantAbandonBodySchema,
  assistantConfirmBodySchema,
  assistantChoiceBodySchema,
  assistantHostChatBodySchema,
  assistantHostInteractionResultSchema,
  assistantPendingPeekQuerySchema,
  attemptKey,
  catalogPickerConflictExtrasFromError,
  chatTurnKey,
  choiceCanonicalCreateInputSchema,
  choiceRecordFromPendingChoice,
  choiceRecordFromPickerConflict,
  continueStaffAssistantHostTurn,
  executionAttemptKey,
  extractUuidResultIds,
  StaffAssistantNotConfiguredError,
  filterStaffAiTools,
  HOST_CHOICE_SEED_TOOL_CALL_ID_PREFIX,
  isHostSeededHitlToolCallId,
  isChatTurnKey,
  isPendingReplaceActionName,
  isResumeTurnKey,
  mapPendingReplaceFacadeInput,
  ORDERS_CREATE_ACTION_NAME,
  PENDING_REPLACE_TOOL_NAME,
  pendingChoiceRecordFromChoiceRecord,
  presentChoiceStaffAssistantNeedsChoice,
  publicPendingFromRecord,
  refuseHostPendingOpen,
  resolveMappedVariantId,
  resumeTurnKey,
  runStaffAssistantHostTurn,
  staffAssistantModelMessagesFromPersisted,
  staffAssistantTurnContextAddendum,
  staffAssistantWorkingSetAddendum,
  STAFF_ASSISTANT_DEFAULT_LOCALE,
  successorPendingChoiceId,
  confirmationPendingRecord,
  type AssistantHostInteractionResult,
  type AssistantResumeCard,
  type CatalogPickerConflictExtras,
  type ChoiceCanonicalCreateInput,
  type LanguageModel,
  type PendingInteractionRecord,
  type PublicPending,
  type StaffAssistantHostCheckpoint,
  type StaffAssistantHostStartedRun,
  type StaffAssistantLocale,
  type StaffAssistantPersistedMessage,
} from "@showzy/ai";
import {
  appendUserMessage,
  checkpointAssistantTurn,
  getConversation,
  getModelHistory,
  getStaffActor,
} from "@showzy/assistant";
import { getCompany } from "@showzy/companies";
import { COMPANY_SELECTOR_HEADER } from "@showzy/contract";
import { toWireError } from "@showzy/contract/server";
import {
  executeAction,
  type ActionPipelineDeps,
  type ActionRegistry,
  type ImplementedAction,
  type SessionPrincipal,
  type StaffMembership,
} from "@showzy/core";
import {
  ConfirmationRequiredError,
  CoreError,
  CoreInvariantError,
  PermissionDeniedError,
  ValidationError,
} from "@showzy/core/errors";
import { assistantSurfacesFromToolResults } from "@showzy/validation/assistant-surfaces";
import { Hono, type Context } from "hono";
import type { z } from "zod";

import type { ConversationLock } from "../stores/conversation-lock.js";
import type { StaffAssistantPendingStore } from "../stores/pending.js";
import { ASSISTANT_INVOCATION_CHANNEL } from "./assistant-invocation.js";
import { REQUEST_ID_HEADER, resolveRequestId } from "./request-id.js";

export const ASSISTANT_HOST_CHAT_PATH = "/assistant/host/chat";
export const ASSISTANT_CONFIRM_PATH = "/assistant/confirm";
export const ASSISTANT_PENDING_PATH = "/assistant/pending";
export const ASSISTANT_PENDING_ABANDON_PATH = "/assistant/pending/abandon";
export const ASSISTANT_HOST_CHOICE_PATH = "/assistant/choice";

export interface StaffAssistantHostRuntime {
  readonly request: Request;
  readonly requestId: string;
  readonly clientIp: string;
  readonly registry: ActionRegistry;
  readonly pipeline: ActionPipelineDeps;
  readonly getSession: (headers: Headers) => Promise<SessionPrincipal | null>;
  readonly pendingStore: StaffAssistantPendingStore;
  readonly conversationLock: ConversationLock;
  /**
   * Required for chat, choice resume, and confirm Phase B. Peek and
   * abandon never call the model.
   */
  readonly model?: LanguageModel;
}

type AppEnv = {
  Variables: {
    requestId: string;
    clientIp: string;
  };
};

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

function requireHostModel(model: LanguageModel | undefined): LanguageModel {
  if (model === undefined) {
    throw new StaffAssistantNotConfiguredError();
  }
  return model;
}

function interactionResponse(
  result: AssistantHostInteractionResult,
  requestId: string,
): Response {
  return jsonResponse(
    200,
    assistantHostInteractionResultSchema.parse(result),
    requestId,
  );
}

function expiredResult(): AssistantHostInteractionResult {
  return { status: "expired" };
}

function errorResult(
  code: string,
  message: string,
): AssistantHostInteractionResult {
  return { status: "error", code, message };
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
 * Trade name for the uncached turn-context addendum. `companies.get`
 * requires `companies:view`; a permission denial omits the name line
 * without failing the chat turn (SHO-360 / SHO-537).
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

async function hostTurnContextAddendum(options: {
  readonly pipeline: ActionPipelineDeps;
  readonly requestId: string;
  readonly clientIp: string;
  readonly staffPrincipal: {
    readonly mode: "staff";
    readonly session: SessionPrincipal;
    readonly companySelector: string | null;
  };
  readonly toolRuns: ReadonlyArray<{
    readonly actionName: string;
    readonly resultIds: readonly string[];
    readonly outcome: string;
  }>;
}): Promise<string> {
  const companyName = await readStaffAssistantCompanyTradeName(() =>
    executeAction(options.pipeline, {
      action: getCompany,
      input: {},
      request: staffRequest({
        requestId: options.requestId,
        clientIp: options.clientIp,
        aiTraceId: options.requestId,
      }),
      principal: options.staffPrincipal,
    }),
  );
  const workingSetAddendum = staffAssistantWorkingSetAddendum(options.toolRuns);
  return staffAssistantTurnContextAddendum({
    now: new Date(),
    ...(companyName !== undefined ? { companyName } : {}),
    ...(workingSetAddendum !== undefined ? { workingSetAddendum } : {}),
  });
}

function priorRunsFromHistory(
  history: Awaited<ReturnType<typeof loadHistory>>,
): Array<{
  readonly outcome:
    "success" | "error" | "confirmation_required" | "choice_required";
}> {
  const runs: Array<{
    readonly outcome:
      "success" | "error" | "confirmation_required" | "choice_required";
  }> = [];
  for (const message of history.messages) {
    for (const run of message.toolRuns) {
      if (
        run.outcome === "success" ||
        run.outcome === "error" ||
        run.outcome === "confirmation_required" ||
        run.outcome === "choice_required"
      ) {
        runs.push({ outcome: run.outcome });
      }
    }
  }
  return runs;
}

const RESOLVE_CUSTOMER_REFERENCE_ACTION =
  "customers.resolveCustomerReference" as const;
const RESOLVE_LINE_REFERENCES_ACTION = "catalog.resolveLineReferences" as const;

const CHOICE_PENDING_REPLACE_UNIQUE_REFUSE = {
  status: "error" as const,
  code: "VALIDATION",
  message:
    "This pending still needs a picker. Arguments that resolve uniquely cannot replace it; tap the card or abandon first.",
};

function catalogLineFromChoiceItem(
  item: ChoiceCanonicalCreateInput["items"][number],
): {
  readonly product: ChoiceCanonicalCreateInput["items"][number]["product"];
  readonly variantSelection?:
    | NonNullable<
        ChoiceCanonicalCreateInput["items"][number]["variantSelection"]
      >
    | {
        readonly kind: "reference";
        readonly ref: NonNullable<
          ChoiceCanonicalCreateInput["items"][number]["variant"]
        >;
      };
} {
  if (item.variantSelection !== undefined) {
    return {
      product: item.product,
      variantSelection: item.variantSelection,
    };
  }
  if (item.variant !== undefined) {
    return {
      product: item.product,
      variantSelection: { kind: "reference", ref: item.variant },
    };
  }
  return { product: item.product };
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

function requireCompanyId(companySelector: string | null): string {
  if (companySelector === null) {
    throw new CoreInvariantError(
      "staff assistant host missing verified company selector",
    );
  }
  return companySelector;
}

async function parseJson(request: Request): Promise<unknown> {
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

function modelHistoryToPersisted(
  messages: ReadonlyArray<{
    readonly role: "user" | "assistant";
    readonly text: string;
    readonly toolRuns: ReadonlyArray<{
      readonly action: string;
      readonly toolCallId: string;
      readonly toolName: string | null;
      readonly modelTrace: unknown;
      readonly toolInput: unknown;
      readonly seq: number | null;
      readonly executionId: string | null;
      readonly outcome: string;
    }>;
  }>,
): StaffAssistantPersistedMessage[] {
  return messages.map((message) => ({
    role: message.role,
    body: message.text,
    toolRuns: message.toolRuns.map((run) => ({
      action: run.action,
      toolCallId: run.toolCallId,
      modelTrace: run.modelTrace,
      ...(run.toolName !== null ? { toolName: run.toolName } : {}),
      ...(run.toolInput !== null ? { toolInput: run.toolInput } : {}),
      ...(run.seq !== null ? { seq: run.seq } : {}),
      ...(run.executionId !== null ? { executionId: run.executionId } : {}),
      outcome: run.outcome,
    })),
  }));
}

function resumeCards(options: {
  readonly toolResults: ReadonlyArray<{
    readonly toolName: string;
    readonly output: unknown;
  }>;
  readonly pending: PublicPending | null;
}): AssistantResumeCard[] {
  const cards: AssistantResumeCard[] = [];
  for (const surface of assistantSurfacesFromToolResults(options.toolResults)) {
    cards.push({
      kind: "surface",
      surface: surface.kind,
      data: surface,
    });
  }
  if (options.pending?.kind === "choice") {
    cards.push({ kind: "choice", envelope: options.pending.envelope });
  }
  if (options.pending?.kind === "confirmation") {
    cards.push({
      kind: "confirmation",
      envelope: {
        status: "confirmation_required",
        challengeId: options.pending.challengeId,
        summary: options.pending.summary,
        expiresAt: options.pending.expiresAt,
        actionName: options.pending.actionName,
        toolCallId: options.pending.toolCallId,
      },
    });
  }
  return cards;
}

function okEnvelope(options: {
  readonly speech: string;
  readonly toolResults?: ReadonlyArray<{
    readonly toolName: string;
    readonly output: unknown;
  }>;
  readonly pending: PublicPending | null;
}): AssistantHostInteractionResult {
  return {
    status: "ok",
    speech: options.speech,
    cards: resumeCards({
      toolResults: options.toolResults ?? [],
      pending: options.pending,
    }),
    pending: options.pending,
  };
}

function createHostCheckpoint(options: {
  readonly pipeline: ActionPipelineDeps;
  readonly conversationId: string;
  readonly requestId: string;
  readonly clientIp: string;
  readonly principal: {
    readonly mode: "staff";
    readonly session: SessionPrincipal;
    readonly companySelector: string | null;
  };
  readonly beginKey: string;
}): StaffAssistantHostCheckpoint {
  const base = {
    pipeline: options.pipeline,
    principal: options.principal,
  };
  return {
    async begin() {
      const result = await executeAction(base.pipeline, {
        action: checkpointAssistantTurn,
        input: {
          kind: "begin",
          conversationId: options.conversationId,
          turnKey: options.beginKey,
        },
        request: staffRequest({
          requestId: options.requestId,
          clientIp: options.clientIp,
          aiTraceId: options.requestId,
          idempotencyKey: attemptKey(
            "turn",
            options.conversationId,
            options.beginKey,
          ),
        }),
        principal: base.principal,
      });
      return { messageId: result.messageId };
    },
    async stageRun(input) {
      const result = await executeAction(base.pipeline, {
        action: checkpointAssistantTurn,
        input: {
          kind: "stageRun",
          conversationId: options.conversationId,
          messageId: input.messageId,
          seq: input.seq,
          actionName: input.actionName,
          toolName: input.toolName,
          toolCallId: input.toolCallId,
          toolInput: input.toolInput,
        },
        request: staffRequest({
          requestId: options.requestId,
          clientIp: options.clientIp,
          aiTraceId: options.requestId,
          idempotencyKey: attemptKey(
            "turn",
            options.conversationId,
            `stage:${input.messageId}:${String(input.seq)}`,
          ),
        }),
        principal: base.principal,
      });
      if (result.executionId === null) {
        throw new CoreInvariantError(
          "checkpoint stageRun returned no executionId",
        );
      }
      return { executionId: result.executionId };
    },
    async finishRun(input) {
      await executeAction(base.pipeline, {
        action: checkpointAssistantTurn,
        input: {
          kind: "finishRun",
          conversationId: options.conversationId,
          executionId: input.executionId,
          outcome: input.outcome,
          resultIds: [...input.resultIds],
          ...(input.modelTrace !== undefined
            ? { modelTrace: input.modelTrace }
            : {}),
          ...(input.challengeId !== undefined
            ? { challengeId: input.challengeId }
            : {}),
        },
        request: staffRequest({
          requestId: options.requestId,
          clientIp: options.clientIp,
          aiTraceId: options.requestId,
          idempotencyKey: attemptKey(
            "turn",
            options.conversationId,
            `finish:${input.executionId}:${input.outcome}`,
          ),
        }),
        principal: base.principal,
      });
    },
    async complete(input) {
      await executeAction(base.pipeline, {
        action: checkpointAssistantTurn,
        input: {
          kind: "complete",
          conversationId: options.conversationId,
          messageId: input.messageId,
          body: input.body,
        },
        request: staffRequest({
          requestId: options.requestId,
          clientIp: options.clientIp,
          aiTraceId: options.requestId,
          idempotencyKey: attemptKey(
            "turn",
            options.conversationId,
            `complete:${input.messageId}`,
          ),
        }),
        principal: base.principal,
      });
    },
  };
}

async function loadHistory(options: {
  readonly pipeline: ActionPipelineDeps;
  readonly conversationId: string;
  readonly requestId: string;
  readonly clientIp: string;
  readonly principal: {
    readonly mode: "staff";
    readonly session: SessionPrincipal;
    readonly companySelector: string | null;
  };
  readonly includeTurnKeys?: readonly string[];
}) {
  return executeAction(options.pipeline, {
    action: getModelHistory,
    input: {
      conversationId: options.conversationId,
      ...(options.includeTurnKeys !== undefined &&
      options.includeTurnKeys.length > 0
        ? { includeTurnKeys: [...options.includeTurnKeys] }
        : {}),
    },
    request: staffRequest({
      requestId: options.requestId,
      clientIp: options.clientIp,
      aiTraceId: options.requestId,
    }),
    principal: options.principal,
  });
}

function resolveStagedExecutionId(options: {
  readonly record: PendingInteractionRecord;
  readonly history: Awaited<ReturnType<typeof loadHistory>>;
}): string {
  if (options.record.executionId !== undefined) {
    return options.record.executionId;
  }
  const started = options.history.messages
    .flatMap((message) => message.toolRuns)
    .find(
      (run) =>
        run.outcome === "started" && run.action === options.record.actionName,
    );
  if (started?.executionId !== undefined && started.executionId !== null) {
    return started.executionId;
  }
  const unfinished = options.history.unfinishedStartedRuns.find(
    (run) => run.action === options.record.actionName,
  );
  if (unfinished !== undefined) {
    return unfinished.executionId;
  }
  throw new CoreInvariantError("pending resume missing staged execution_id");
}

function toHostStartedRun(run: {
  readonly messageId: string;
  readonly executionId: string;
  readonly seq: number;
  readonly action: string;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly toolInput: unknown;
}): StaffAssistantHostStartedRun {
  return {
    messageId: run.messageId,
    executionId: run.executionId,
    seq: run.seq,
    actionName: run.action,
    toolName: run.toolName,
    toolCallId: run.toolCallId,
    toolInput: run.toolInput,
  };
}

function startedRunsMatchingTurnKey(
  history: Awaited<ReturnType<typeof loadHistory>>,
  allow: (turnKey: string | null) => boolean,
): StaffAssistantHostStartedRun[] {
  const started: StaffAssistantHostStartedRun[] = [];
  for (const run of history.unfinishedStartedRuns) {
    if (!allow(run.turnKey)) {
      continue;
    }
    if (isHostSeededHitlToolCallId(run.toolCallId)) {
      continue;
    }
    if (run.toolName === null) {
      continue;
    }
    started.push(toHostStartedRun({ ...run, toolName: run.toolName }));
  }
  return started;
}

function startedRunsForChatRecovery(
  history: Awaited<ReturnType<typeof loadHistory>>,
): StaffAssistantHostStartedRun[] {
  return startedRunsMatchingTurnKey(history, isChatTurnKey);
}

function startedRunsForResumeTurnRecovery(
  history: Awaited<ReturnType<typeof loadHistory>>,
  pending: PendingInteractionRecord,
): StaffAssistantHostStartedRun[] {
  const key = resumeTurnKey(pending.id);
  return startedRunsMatchingTurnKey(history, (turnKey) => turnKey === key);
}

function hostModelMessages(
  history: Awaited<ReturnType<typeof loadHistory>>,
  recoverStartedRuns: readonly StaffAssistantHostStartedRun[],
) {
  return staffAssistantModelMessagesFromPersisted(
    modelHistoryToPersisted(history.messages),
    undefined,
    {
      recoverStartedExecutionIds: new Set(
        recoverStartedRuns.map((run) => run.executionId),
      ),
    },
  );
}

function hasUnfinishedResumeTurn(
  history: Awaited<ReturnType<typeof loadHistory>>,
): boolean {
  if (
    history.unfinishedStartedRuns.some((run) => isResumeTurnKey(run.turnKey))
  ) {
    return true;
  }
  return history.checkpointTurns.some(
    (turn) => isResumeTurnKey(turn.turnKey) && !turn.hasSpeech,
  );
}

function phaseBState(
  history: Awaited<ReturnType<typeof loadHistory>>,
  pending: PendingInteractionRecord,
): "needed" | "continue" | "done" {
  const key = resumeTurnKey(pending.id);
  const turn = history.checkpointTurns.find((row) => row.turnKey === key);
  if (turn === undefined) {
    return "needed";
  }
  const hasStarted = history.unfinishedStartedRuns.some(
    (run) => run.turnKey === key,
  );
  if (hasStarted || !turn.hasSpeech) {
    return "continue";
  }
  return "done";
}

function lastAssistantSpeech(
  history: Awaited<ReturnType<typeof loadHistory>>,
  pinnedTurnKey?: string,
): string {
  if (pinnedTurnKey !== undefined) {
    const pinned = history.checkpointTurns.find(
      (turn) => turn.turnKey === pinnedTurnKey,
    );
    if (pinned !== undefined && pinned.speech !== "") {
      return pinned.speech;
    }
  }
  const last = history.messages.findLast(
    (message) => message.role === "assistant" && message.text !== "",
  );
  return last?.text ?? "";
}

type ResumeToolResult = {
  readonly toolName: string;
  readonly output: unknown;
};

function resumeToolResultFromStoredRun(run: {
  readonly toolName: string | null;
  readonly action: string;
  readonly modelTrace: unknown;
}): ResumeToolResult | null {
  if (run.modelTrace === null || run.modelTrace === undefined) {
    return null;
  }
  if (isStartedToolTrace(run.modelTrace)) {
    return null;
  }
  const toolName = run.toolName ?? run.action;
  if (toolName === "") {
    return null;
  }
  return { toolName, output: run.modelTrace };
}

function findPhaseAStoredRun(
  history: Awaited<ReturnType<typeof loadHistory>>,
  pending: PendingInteractionRecord,
) {
  const runs = history.messages.flatMap((message) => message.toolRuns);
  if (pending.executionId !== undefined) {
    const matched = runs.find((run) => run.executionId === pending.executionId);
    if (matched !== undefined) {
      return matched;
    }
  }
  const resumeKey = resumeTurnKey(pending.id);
  return (
    history.messages
      .filter((message) => message.turnKey !== resumeKey)
      .flatMap((message) => message.toolRuns)
      .findLast(
        (run) => run.action === pending.actionName && run.outcome === "success",
      ) ?? null
  );
}

function phaseAResumeToolResult(options: {
  readonly pending: PendingInteractionRecord;
  readonly history: Awaited<ReturnType<typeof loadHistory>>;
  readonly output?: unknown;
}): ResumeToolResult | null {
  const stored = findPhaseAStoredRun(options.history, options.pending);
  if (options.output !== undefined) {
    if (isStartedToolTrace(options.output)) {
      return null;
    }
    return {
      toolName: stored?.toolName ?? options.pending.actionName,
      output: options.output,
    };
  }
  if (stored === null || stored.outcome !== "success") {
    return null;
  }
  return resumeToolResultFromStoredRun(stored);
}

function phaseBResumeToolResultsFromHistory(
  history: Awaited<ReturnType<typeof loadHistory>>,
  pending: PendingInteractionRecord,
): ResumeToolResult[] {
  const resumeKey = resumeTurnKey(pending.id);
  const results: ResumeToolResult[] = [];
  for (const message of history.messages) {
    if (message.turnKey !== resumeKey) {
      continue;
    }
    for (const run of message.toolRuns) {
      const result = resumeToolResultFromStoredRun(run);
      if (result !== null) {
        results.push(result);
      }
    }
  }
  return results;
}

function phaseBResumeToolResultsFromTurn(
  toolRuns: ReadonlyArray<{
    readonly modelTrace?: unknown;
    readonly toolName?: string;
  }>,
): ResumeToolResult[] {
  return toolRuns.flatMap((run) => {
    if (run.modelTrace === undefined || run.toolName === undefined) {
      return [];
    }
    if (isStartedToolTrace(run.modelTrace)) {
      return [];
    }
    return [{ toolName: run.toolName, output: run.modelTrace }];
  });
}

function mergeResumeToolResults(
  phaseA: ResumeToolResult | null,
  phaseB: readonly ResumeToolResult[],
): ResumeToolResult[] {
  return phaseA === null ? [...phaseB] : [phaseA, ...phaseB];
}

function resumeToolResultsFromHistory(
  history: Awaited<ReturnType<typeof loadHistory>>,
  pending: PendingInteractionRecord,
): ResumeToolResult[] {
  return mergeResumeToolResults(
    phaseAResumeToolResult({ pending, history }),
    phaseBResumeToolResultsFromHistory(history, pending),
  );
}

function isStartedToolTrace(output: unknown): boolean {
  return (
    typeof output === "object" &&
    output !== null &&
    !Array.isArray(output) &&
    "status" in output &&
    output.status === "started"
  );
}

async function runPhaseB(options: {
  readonly runtime: StaffAssistantHostRuntime;
  readonly conversationId: string;
  readonly locale: StaffAssistantLocale;
  readonly bind: {
    readonly actorId: string;
    readonly companyId: string;
    readonly conversationId: string;
  };
  readonly staffPrincipal: {
    readonly mode: "staff";
    readonly session: SessionPrincipal;
    readonly companySelector: string | null;
  };
  readonly actor: StaffMembership;
  readonly pending: PendingInteractionRecord;
  readonly phaseAOutput?: unknown;
}): Promise<AssistantHostInteractionResult> {
  const history = await loadHistory({
    pipeline: options.runtime.pipeline,
    conversationId: options.conversationId,
    requestId: options.runtime.requestId,
    clientIp: options.runtime.clientIp,
    principal: options.staffPrincipal,
    includeTurnKeys: [resumeTurnKey(options.pending.id)],
  });
  const conversation = await executeAction(options.runtime.pipeline, {
    action: getConversation,
    input: { conversationId: options.conversationId },
    request: staffRequest({
      requestId: options.runtime.requestId,
      clientIp: options.runtime.clientIp,
      aiTraceId: options.runtime.requestId,
    }),
    principal: options.staffPrincipal,
  });
  const contracts = filterStaffAiTools(options.runtime.registry.contracts(), {
    role: options.actor.role,
    permissions: [...options.actor.permissions],
  });
  const open = await options.runtime.pendingStore.peekOpen({
    conversationId: options.conversationId,
    bind: options.bind,
  });
  const checkpoint = createHostCheckpoint({
    pipeline: options.runtime.pipeline,
    conversationId: options.conversationId,
    requestId: options.runtime.requestId,
    clientIp: options.runtime.clientIp,
    principal: options.staffPrincipal,
    beginKey: resumeTurnKey(options.pending.id),
  });
  const priorRuns = priorRunsFromHistory(history);
  const recoverStartedRuns = startedRunsForResumeTurnRecovery(
    history,
    options.pending,
  );
  const turn = await continueStaffAssistantHostTurn({
    model: requireHostModel(options.runtime.model),
    messages: hostModelMessages(history, recoverStartedRuns),
    contracts,
    execute: (actionName, input, toolOptions) => {
      const action = requireImplementation(
        options.runtime.registry,
        actionName,
      );
      const executionId = toolOptions.executionId;
      return executeAction(options.runtime.pipeline, {
        action,
        input,
        request: staffRequest({
          requestId: options.runtime.requestId,
          clientIp: options.runtime.clientIp,
          aiTraceId: options.runtime.requestId,
          toolCallId: toolOptions.toolCallId,
          ...(executionId !== undefined
            ? {
                idempotencyKey: executionAttemptKey(
                  options.conversationId,
                  executionId,
                ),
              }
            : {}),
        }),
        principal: options.staffPrincipal,
      });
    },
    locale: options.locale,
    turnContextAddendum: await hostTurnContextAddendum({
      pipeline: options.runtime.pipeline,
      requestId: options.runtime.requestId,
      clientIp: options.runtime.clientIp,
      staffPrincipal: options.staffPrincipal,
      toolRuns: conversation.toolRuns,
    }),
    ...(priorRuns.length > 0 ? { priorRuns } : {}),
    ...(recoverStartedRuns.length > 0 ? { recoverStartedRuns } : {}),
    choiceBind: options.bind,
    openPending: (record) => options.runtime.pendingStore.open(record),
    checkPending: async ({ actionName }) => {
      const current = await options.runtime.pendingStore.peekOpen({
        conversationId: options.conversationId,
        bind: options.bind,
      });
      if (current.kind !== "found") {
        return { allow: true };
      }
      const implementation =
        options.runtime.registry.getImplementation(actionName);
      if (implementation?.contract.risk === "read") {
        return { allow: true };
      }
      return refuseHostPendingOpen(options.locale);
    },
    checkpoint,
    ...(open.kind === "found" &&
    open.record.status === "open" &&
    isPendingReplaceActionName(open.record.actionName)
      ? {
          pendingReplace: {
            actionName: open.record.actionName,
            apply: (facade: unknown) =>
              applyHostPendingReplace({
                runtime: options.runtime,
                record: open.record,
                facade,
                bind: options.bind,
                staffPrincipal: options.staffPrincipal,
              }),
          },
        }
      : {}),
  });
  const after = await options.runtime.pendingStore.peekOpen({
    conversationId: options.conversationId,
    bind: options.bind,
  });
  const pending =
    after.kind === "found"
      ? (publicPendingFromRecord(after.record) ?? null)
      : null;
  const toolResults = mergeResumeToolResults(
    phaseAResumeToolResult({
      pending: options.pending,
      history,
      ...(options.phaseAOutput !== undefined
        ? { output: options.phaseAOutput }
        : {}),
    }),
    phaseBResumeToolResultsFromTurn(turn.toolRuns),
  );
  return okEnvelope({
    speech: turn.speech.text,
    toolResults,
    pending,
  });
}

async function stagePendingReplaceExecution(options: {
  readonly runtime: StaffAssistantHostRuntime;
  readonly record: PendingInteractionRecord;
  readonly facade: unknown;
  readonly bind: {
    readonly actorId: string;
    readonly companyId: string;
    readonly conversationId: string;
  };
  readonly staffPrincipal: {
    readonly mode: "staff";
    readonly session: SessionPrincipal;
    readonly companySelector: string | null;
  };
}): Promise<string> {
  const checkpoint = createHostCheckpoint({
    pipeline: options.runtime.pipeline,
    conversationId: options.bind.conversationId,
    requestId: options.runtime.requestId,
    clientIp: options.runtime.clientIp,
    principal: options.staffPrincipal,
    beginKey: `begin:replace:${options.record.id}:${String(options.record.version)}`,
  });
  const begun = await checkpoint.begin();
  const staged = await checkpoint.stageRun({
    messageId: begun.messageId,
    seq: 0,
    actionName: options.record.actionName,
    toolName: PENDING_REPLACE_TOOL_NAME,
    toolCallId: `replace:${options.record.id}`,
    toolInput: options.facade,
  });
  return staged.executionId;
}

async function harvestChoiceReplacePickerExtras(options: {
  readonly runtime: StaffAssistantHostRuntime;
  readonly canonical: ChoiceCanonicalCreateInput;
  readonly staffPrincipal: {
    readonly mode: "staff";
    readonly session: SessionPrincipal;
    readonly companySelector: string | null;
  };
}): Promise<CatalogPickerConflictExtras | undefined> {
  const request = staffRequest({
    requestId: options.runtime.requestId,
    clientIp: options.runtime.clientIp,
    aiTraceId: options.runtime.requestId,
  });
  try {
    await executeAction(options.runtime.pipeline, {
      action: requireImplementation(
        options.runtime.registry,
        RESOLVE_CUSTOMER_REFERENCE_ACTION,
      ),
      input: options.canonical.customer,
      request,
      principal: options.staffPrincipal,
    });
  } catch (error) {
    const extras = catalogPickerConflictExtrasFromError(error);
    if (extras !== undefined) {
      return extras;
    }
    throw error;
  }
  try {
    await executeAction(options.runtime.pipeline, {
      action: requireImplementation(
        options.runtime.registry,
        RESOLVE_LINE_REFERENCES_ACTION,
      ),
      input: {
        lines: options.canonical.items.map(catalogLineFromChoiceItem),
      },
      request,
      principal: options.staffPrincipal,
    });
  } catch (error) {
    const extras = catalogPickerConflictExtrasFromError(error);
    if (extras !== undefined) {
      return extras;
    }
    throw error;
  }
  return undefined;
}

async function applyHostPendingReplace(options: {
  readonly runtime: StaffAssistantHostRuntime;
  readonly record: PendingInteractionRecord;
  readonly facade: unknown;
  readonly bind: {
    readonly actorId: string;
    readonly companyId: string;
    readonly conversationId: string;
  };
  readonly staffPrincipal: {
    readonly mode: "staff";
    readonly session: SessionPrincipal;
    readonly companySelector: string | null;
  };
}): Promise<unknown> {
  const mapped = mapPendingReplaceFacadeInput(
    options.record.actionName,
    options.facade,
  );
  let next: PendingInteractionRecord;
  if (options.record.kind === "confirmation") {
    const stagedExecutionId = await stagePendingReplaceExecution(options);
    const action = requireImplementation(
      options.runtime.registry,
      options.record.actionName,
    );
    let required: ConfirmationRequiredError | undefined;
    try {
      await executeAction(options.runtime.pipeline, {
        action,
        input: mapped,
        request: staffRequest({
          requestId: options.runtime.requestId,
          clientIp: options.runtime.clientIp,
          aiTraceId: options.runtime.requestId,
          toolCallId: options.record.toolCallId,
          idempotencyKey: executionAttemptKey(
            options.bind.conversationId,
            stagedExecutionId,
          ),
        }),
        principal: options.staffPrincipal,
      });
    } catch (error) {
      if (error instanceof ConfirmationRequiredError) {
        required = error;
      } else {
        throw error;
      }
    }
    if (required === undefined) {
      throw new CoreInvariantError(
        "pending_replace confirmation probe must not execute the handler",
      );
    }
    next = confirmationPendingRecord({
      challengeId: required.challenge.challengeId,
      bind: options.bind,
      actionName: options.record.actionName,
      toolCallId: options.record.toolCallId,
      canonicalInput: mapped,
      summary: required.challenge.summary,
      challengeExpiresAt: required.challenge.expiresAt,
      executionId: stagedExecutionId,
      version: options.record.version + 1,
      ...(options.record.locale !== undefined
        ? { locale: options.record.locale }
        : {}),
    });
  } else {
    if (options.record.actionName !== ORDERS_CREATE_ACTION_NAME) {
      return CHOICE_PENDING_REPLACE_UNIQUE_REFUSE;
    }
    const canonical = choiceCanonicalCreateInputSchema.parse(mapped);
    const extras = await harvestChoiceReplacePickerExtras({
      runtime: options.runtime,
      canonical,
      staffPrincipal: options.staffPrincipal,
    });
    if (extras === undefined) {
      return CHOICE_PENDING_REPLACE_UNIQUE_REFUSE;
    }
    const nextId = randomUUID();
    const rebuilt = choiceRecordFromPickerConflict({
      choiceId: nextId,
      bind: options.bind,
      canonicalInput: canonical,
      extras,
      ...(options.record.locale !== undefined
        ? { locale: options.record.locale }
        : {}),
    });
    if (rebuilt === undefined) {
      throw new CoreInvariantError(
        "pending_replace choice probe produced no picker",
      );
    }
    const stagedExecutionId = await stagePendingReplaceExecution(options);
    next = pendingChoiceRecordFromChoiceRecord(rebuilt, {
      actionName: options.record.actionName,
      toolCallId: options.record.toolCallId,
      version: options.record.version + 1,
      executionId: stagedExecutionId,
    });
  }
  const replaced = await options.runtime.pendingStore.replace({
    id: options.record.id,
    bind: options.bind,
    expectedVersion: options.record.version,
    next,
  });
  if (replaced.kind !== "replaced") {
    return { status: "expired" as const };
  }
  return {
    status: "replaced" as const,
    pending: publicPendingFromRecord(replaced.record) ?? null,
  };
}

async function finishPhaseA(options: {
  readonly runtime: StaffAssistantHostRuntime;
  readonly conversationId: string;
  readonly staffPrincipal: {
    readonly mode: "staff";
    readonly session: SessionPrincipal;
    readonly companySelector: string | null;
  };
  readonly executionId: string;
  readonly outcome: "success" | "error" | "choice_required";
  readonly output: unknown;
  readonly challengeId?: string;
}): Promise<void> {
  await executeAction(options.runtime.pipeline, {
    action: checkpointAssistantTurn,
    input: {
      kind: "finishRun",
      conversationId: options.conversationId,
      executionId: options.executionId,
      outcome: options.outcome,
      resultIds: extractUuidResultIds(options.output),
      modelTrace: options.output,
      ...(options.challengeId !== undefined
        ? { challengeId: options.challengeId }
        : {}),
    },
    request: staffRequest({
      requestId: options.runtime.requestId,
      clientIp: options.runtime.clientIp,
      aiTraceId: options.runtime.requestId,
      idempotencyKey: attemptKey(
        "turn",
        options.conversationId,
        `finish:${options.executionId}:${options.outcome}`,
      ),
    }),
    principal: options.staffPrincipal,
  });
}

async function executePhaseA(options: {
  readonly runtime: StaffAssistantHostRuntime;
  readonly record: PendingInteractionRecord;
  readonly input: unknown;
  readonly confirmationChallengeId?: string;
  readonly staffPrincipal: {
    readonly mode: "staff";
    readonly session: SessionPrincipal;
    readonly companySelector: string | null;
  };
  readonly executionId: string;
  readonly idempotencyKey?: string;
}): Promise<unknown> {
  const action = requireImplementation(
    options.runtime.registry,
    options.record.actionName,
  );
  return executeAction(options.runtime.pipeline, {
    action,
    input: options.input,
    request: staffRequest({
      requestId: options.runtime.requestId,
      clientIp: options.runtime.clientIp,
      aiTraceId: options.runtime.requestId,
      toolCallId: options.record.toolCallId,
      idempotencyKey:
        options.idempotencyKey ??
        executionAttemptKey(options.record.conversationId, options.executionId),
      ...(options.confirmationChallengeId !== undefined
        ? { confirmationChallengeId: options.confirmationChallengeId }
        : {}),
    }),
    principal: options.staffPrincipal,
  });
}

async function authenticateHost(options: StaffAssistantHostRuntime): Promise<
  | { readonly ok: false; readonly response: Response }
  | {
      readonly ok: true;
      readonly session: SessionPrincipal;
      readonly companySelector: string;
      readonly staffPrincipal: {
        readonly mode: "staff";
        readonly session: SessionPrincipal;
        readonly companySelector: string | null;
      };
    }
> {
  const session = await options.getSession(options.request.headers);
  if (session === null) {
    return {
      ok: false,
      response: unauthenticatedResponse(options.requestId),
    };
  }
  const companySelector = requireCompanyId(
    headerOrNull(options.request.headers, COMPANY_SELECTOR_HEADER),
  );
  return {
    ok: true,
    session,
    companySelector,
    staffPrincipal: {
      mode: "staff",
      session,
      companySelector,
    },
  };
}

async function afterPhaseASuccess(options: {
  readonly runtime: StaffAssistantHostRuntime;
  readonly record: PendingInteractionRecord;
  readonly bind: {
    readonly actorId: string;
    readonly companyId: string;
    readonly conversationId: string;
  };
  readonly optionId?: string;
  readonly staffPrincipal: {
    readonly mode: "staff";
    readonly session: SessionPrincipal;
    readonly companySelector: string | null;
  };
  readonly actor: StaffMembership;
  readonly locale: StaffAssistantLocale;
  readonly output: unknown;
}): Promise<AssistantHostInteractionResult> {
  await options.runtime.pendingStore.complete({
    id: options.record.id,
    kind: options.record.kind,
    bind: options.bind,
    ...(options.optionId !== undefined ? { optionId: options.optionId } : {}),
  });
  // SHO-544: pass the committed Phase A write so resume cards include
  // the existing surface even when Phase B is speech-only or fails.
  return runPhaseB({
    runtime: options.runtime,
    conversationId: options.record.conversationId,
    locale: options.locale,
    bind: options.bind,
    staffPrincipal: options.staffPrincipal,
    actor: options.actor,
    pending: options.record,
    phaseAOutput: options.output,
  });
}

async function replayCompletedPending(options: {
  readonly runtime: StaffAssistantHostRuntime;
  readonly conversationId: string;
  readonly locale: StaffAssistantLocale;
  readonly bind: {
    readonly actorId: string;
    readonly companyId: string;
    readonly conversationId: string;
  };
  readonly staffPrincipal: {
    readonly mode: "staff";
    readonly session: SessionPrincipal;
    readonly companySelector: string | null;
  };
  readonly actor: StaffMembership;
  readonly record: PendingInteractionRecord;
}): Promise<AssistantHostInteractionResult> {
  const open = await options.runtime.pendingStore.peekOpen({
    conversationId: options.conversationId,
    bind: options.bind,
  });
  const resumeKey = resumeTurnKey(options.record.id);
  const history = await loadHistory({
    pipeline: options.runtime.pipeline,
    conversationId: options.conversationId,
    requestId: options.runtime.requestId,
    clientIp: options.runtime.clientIp,
    principal: options.staffPrincipal,
    includeTurnKeys: [resumeKey],
  });
  if (open.kind === "found" && open.record.id !== options.record.id) {
    return okEnvelope({
      speech: lastAssistantSpeech(history, resumeKey),
      toolResults: resumeToolResultsFromHistory(history, options.record),
      pending: publicPendingFromRecord(open.record) ?? null,
    });
  }
  const state = phaseBState(history, options.record);
  if (state === "done") {
    return okEnvelope({
      speech: lastAssistantSpeech(history, resumeKey),
      toolResults: resumeToolResultsFromHistory(history, options.record),
      pending: null,
    });
  }
  return runPhaseB({
    runtime: options.runtime,
    conversationId: options.conversationId,
    locale: options.locale,
    bind: options.bind,
    staffPrincipal: options.staffPrincipal,
    actor: options.actor,
    pending: options.record,
  });
}

export async function executeStaffAssistantHostChoiceResume(
  options: StaffAssistantHostRuntime,
): Promise<Response> {
  const auth = await authenticateHost(options);
  if (!auth.ok) {
    return auth.response;
  }
  try {
    const parsed = assistantChoiceBodySchema.safeParse(
      await parseJson(options.request),
    );
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues);
    }
    const conversation = await resolveStaffConversation({
      pipeline: options.pipeline,
      requestId: options.requestId,
      clientIp: options.clientIp,
      conversationId: parsed.data.conversationId,
      staffPrincipal: auth.staffPrincipal,
    });
    const bind = {
      actorId: auth.session.userId,
      companyId: auth.companySelector,
      conversationId: conversation.id,
    };
    return await options.conversationLock.withLock(
      conversation.id,
      async () => {
        const claimed = await options.pendingStore.claim({
          id: parsed.data.choiceId,
          kind: "choice",
          bind,
          optionId: parsed.data.optionId,
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
            errorResult(
              "CHOICE_INVALID_OPTION",
              "That option is not available.",
            ),
            options.requestId,
          );
        }
        const record = claimed.record;
        if (record.kind !== "choice") {
          return interactionResponse(expiredResult(), options.requestId);
        }
        const actor = await executeAction(options.pipeline, {
          action: getStaffActor,
          input: {},
          request: staffRequest({
            requestId: options.requestId,
            clientIp: options.clientIp,
            aiTraceId: options.requestId,
          }),
          principal: auth.staffPrincipal,
        });
        const locale = record.locale ?? STAFF_ASSISTANT_DEFAULT_LOCALE;
        if (claimed.kind === "replay" && record.status === "completed") {
          return interactionResponse(
            await replayCompletedPending({
              runtime: options,
              conversationId: conversation.id,
              locale,
              bind,
              staffPrincipal: auth.staffPrincipal,
              actor,
              record,
            }),
            options.requestId,
          );
        }
        const mappedId = resolveMappedVariantId(
          record.optionMap,
          parsed.data.optionId,
        );
        if (mappedId === undefined) {
          return interactionResponse(
            errorResult(
              "CHOICE_INVALID_OPTION",
              "That option is not available.",
            ),
            options.requestId,
          );
        }
        const patched = applyChoiceOptionToCanonicalInput(
          record.canonicalInput,
          record.target,
          mappedId,
        );
        const history = await loadHistory({
          pipeline: options.pipeline,
          conversationId: conversation.id,
          requestId: options.requestId,
          clientIp: options.clientIp,
          principal: auth.staffPrincipal,
        });
        // SHO-543: finish the paused (or replace-staged) execution_id.
        // Do not begin a Phase A replica. Canonical patched input stays
        // on the pending record / executeAction input, not tool_input.
        // Domain execute cannot reuse tool:${executionId}: the pause
        // already bound that key to unpatched input (live picker).
        const executionId = resolveStagedExecutionId({ record, history });
        try {
          const output = await executePhaseA({
            runtime: options,
            record,
            input: patched,
            staffPrincipal: auth.staffPrincipal,
            executionId,
            idempotencyKey: attemptKey("choice", conversation.id, record.id),
          });
          await finishPhaseA({
            runtime: options,
            conversationId: conversation.id,
            staffPrincipal: auth.staffPrincipal,
            executionId,
            outcome: "success",
            output,
          });
          return interactionResponse(
            await afterPhaseASuccess({
              runtime: options,
              record,
              bind,
              optionId: parsed.data.optionId,
              staffPrincipal: auth.staffPrincipal,
              actor,
              locale,
              output,
            }),
            options.requestId,
          );
        } catch (error) {
          if (error instanceof ConfirmationRequiredError) {
            return interactionResponse(
              errorResult(error.code, error.clientMessage),
              options.requestId,
            );
          }
          const extras = catalogPickerConflictExtrasFromError(error);
          if (extras !== undefined) {
            const nextId = successorPendingChoiceId(record.id);
            const nextChoice = choiceRecordFromPickerConflict({
              choiceId: nextId,
              bind,
              canonicalInput: patched,
              extras,
              ...(record.locale !== undefined ? { locale: record.locale } : {}),
            });
            if (nextChoice !== undefined) {
              const successorExecutionId = await stageSuccessorExecutionId({
                runtime: options,
                conversationId: conversation.id,
                staffPrincipal: auth.staffPrincipal,
                actionName: record.actionName,
                nextId,
                toolInput: patched,
              });
              const next = pendingChoiceRecordFromChoiceRecord(nextChoice, {
                actionName: record.actionName,
                toolCallId: `${HOST_CHOICE_SEED_TOOL_CALL_ID_PREFIX}${nextId}`,
                executionId: successorExecutionId,
              });
              await options.pendingStore.complete({
                id: record.id,
                kind: "choice",
                bind,
                optionId: parsed.data.optionId,
              });
              await options.pendingStore.open(next);
              const publicPending = publicPendingFromRecord(next) ?? null;
              const needs = presentChoiceStaffAssistantNeedsChoice({
                locale,
                record: choiceRecordFromPendingChoice(next),
              });
              return interactionResponse(
                okEnvelope({
                  speech: needs.text,
                  pending: publicPending,
                }),
                options.requestId,
              );
            }
          }
          if (error instanceof CoreError) {
            return interactionResponse(
              errorResult(error.code, error.clientMessage),
              options.requestId,
            );
          }
          throw error;
        }
      },
    );
  } catch (error) {
    if (error instanceof CoreError) {
      options.pipeline.logger.error(
        { request_id: options.requestId, code: error.code },
        "staff assistant host choice resume failed",
      );
    }
    return wireResponse(error, options.requestId);
  }
}

async function stageBoundExecutionId(options: {
  readonly runtime: StaffAssistantHostRuntime;
  readonly conversationId: string;
  readonly staffPrincipal: {
    readonly mode: "staff";
    readonly session: SessionPrincipal;
    readonly companySelector: string | null;
  };
  readonly actionName: string;
  readonly beginKey: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly toolInput: unknown;
}): Promise<string> {
  const checkpoint = createHostCheckpoint({
    pipeline: options.runtime.pipeline,
    conversationId: options.conversationId,
    requestId: options.runtime.requestId,
    clientIp: options.runtime.clientIp,
    principal: options.staffPrincipal,
    beginKey: options.beginKey,
  });
  const begun = await checkpoint.begin();
  const staged = await checkpoint.stageRun({
    messageId: begun.messageId,
    seq: 0,
    actionName: options.actionName,
    toolName: options.toolName,
    toolCallId: options.toolCallId,
    toolInput: options.toolInput,
  });
  return staged.executionId;
}

async function stageSuccessorExecutionId(options: {
  readonly runtime: StaffAssistantHostRuntime;
  readonly conversationId: string;
  readonly staffPrincipal: {
    readonly mode: "staff";
    readonly session: SessionPrincipal;
    readonly companySelector: string | null;
  };
  readonly actionName: string;
  readonly nextId: string;
  readonly toolInput: unknown;
}): Promise<string> {
  return stageBoundExecutionId({
    runtime: options.runtime,
    conversationId: options.conversationId,
    staffPrincipal: options.staffPrincipal,
    actionName: options.actionName,
    beginKey: `begin:successor:${options.nextId}`,
    toolCallId: `${HOST_CHOICE_SEED_TOOL_CALL_ID_PREFIX}${options.nextId}`,
    toolName: `${HOST_CHOICE_SEED_TOOL_CALL_ID_PREFIX}${options.nextId}`,
    toolInput: options.toolInput,
  });
}

export async function executeStaffAssistantHostConfirm(
  options: StaffAssistantHostRuntime,
): Promise<Response> {
  const auth = await authenticateHost(options);
  if (!auth.ok) {
    return auth.response;
  }
  try {
    const parsed = assistantConfirmBodySchema.safeParse(
      await parseJson(options.request),
    );
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues);
    }
    const conversation = await resolveStaffConversation({
      pipeline: options.pipeline,
      requestId: options.requestId,
      clientIp: options.clientIp,
      conversationId: parsed.data.conversationId,
      staffPrincipal: auth.staffPrincipal,
    });
    const bind = {
      actorId: auth.session.userId,
      companyId: auth.companySelector,
      conversationId: conversation.id,
    };
    return await options.conversationLock.withLock(
      conversation.id,
      async () => {
        const peeked = await options.pendingStore.peek({
          id: parsed.data.challengeId,
          kind: "confirmation",
          bind,
        });
        if (peeked.kind === "expired" || peeked.kind === "forbidden") {
          return interactionResponse(expiredResult(), options.requestId);
        }
        const claimed = await options.pendingStore.claim({
          id: parsed.data.challengeId,
          kind: "confirmation",
          bind,
        });
        if (claimed.kind === "expired" || claimed.kind === "forbidden") {
          return interactionResponse(expiredResult(), options.requestId);
        }
        if (claimed.kind === "conflict" || claimed.kind === "invalid_option") {
          return interactionResponse(expiredResult(), options.requestId);
        }
        const record = claimed.record;
        if (record.kind !== "confirmation") {
          return interactionResponse(expiredResult(), options.requestId);
        }
        const actor = await executeAction(options.pipeline, {
          action: getStaffActor,
          input: {},
          request: staffRequest({
            requestId: options.requestId,
            clientIp: options.clientIp,
            aiTraceId: options.requestId,
          }),
          principal: auth.staffPrincipal,
        });
        const locale = record.locale ?? STAFF_ASSISTANT_DEFAULT_LOCALE;
        if (claimed.kind === "replay" && record.status === "completed") {
          return interactionResponse(
            await replayCompletedPending({
              runtime: options,
              conversationId: conversation.id,
              locale,
              bind,
              staffPrincipal: auth.staffPrincipal,
              actor,
              record,
            }),
            options.requestId,
          );
        }
        const history = await loadHistory({
          pipeline: options.pipeline,
          conversationId: conversation.id,
          requestId: options.requestId,
          clientIp: options.clientIp,
          principal: auth.staffPrincipal,
        });
        const executionId = resolveStagedExecutionId({ record, history });
        try {
          const output = await executePhaseA({
            runtime: options,
            record,
            input: record.canonicalInput,
            confirmationChallengeId: record.id,
            staffPrincipal: auth.staffPrincipal,
            executionId,
          });
          await finishPhaseA({
            runtime: options,
            conversationId: conversation.id,
            staffPrincipal: auth.staffPrincipal,
            executionId,
            outcome: "success",
            output,
          });
          return interactionResponse(
            await afterPhaseASuccess({
              runtime: options,
              record,
              bind,
              staffPrincipal: auth.staffPrincipal,
              actor,
              locale,
              output,
            }),
            options.requestId,
          );
        } catch (error) {
          if (error instanceof ConfirmationRequiredError) {
            return interactionResponse(
              errorResult(error.code, error.clientMessage),
              options.requestId,
            );
          }
          if (error instanceof CoreError) {
            return interactionResponse(
              errorResult(error.code, error.clientMessage),
              options.requestId,
            );
          }
          throw error;
        }
      },
    );
  } catch (error) {
    if (error instanceof CoreError) {
      options.pipeline.logger.error(
        { request_id: options.requestId, code: error.code },
        "staff assistant host confirm failed",
      );
    }
    return wireResponse(error, options.requestId);
  }
}

export async function executeStaffAssistantPendingAbandon(
  options: StaffAssistantHostRuntime,
): Promise<Response> {
  const auth = await authenticateHost(options);
  if (!auth.ok) {
    return auth.response;
  }
  try {
    const parsed = assistantAbandonBodySchema.safeParse(
      await parseJson(options.request),
    );
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues);
    }
    const conversation = await resolveStaffConversation({
      pipeline: options.pipeline,
      requestId: options.requestId,
      clientIp: options.clientIp,
      conversationId: parsed.data.conversationId,
      staffPrincipal: auth.staffPrincipal,
    });
    const bind = {
      actorId: auth.session.userId,
      companyId: auth.companySelector,
      conversationId: conversation.id,
    };
    return await options.conversationLock.withLock(
      conversation.id,
      async () => {
        const abandoned = await options.pendingStore.abandon({
          id: parsed.data.pendingId,
          bind,
          expectedVersion: parsed.data.expectedVersion,
        });
        if (abandoned.kind === "expired" || abandoned.kind === "forbidden") {
          return interactionResponse(expiredResult(), options.requestId);
        }
        return interactionResponse(
          okEnvelope({ speech: "", pending: null }),
          options.requestId,
        );
      },
    );
  } catch (error) {
    if (error instanceof CoreError) {
      options.pipeline.logger.error(
        { request_id: options.requestId, code: error.code },
        "staff assistant pending abandon failed",
      );
    }
    return wireResponse(error, options.requestId);
  }
}

export async function executeStaffAssistantPendingPeek(
  options: StaffAssistantHostRuntime,
): Promise<Response> {
  const auth = await authenticateHost(options);
  if (!auth.ok) {
    return auth.response;
  }
  try {
    const url = new URL(options.request.url);
    const parsed = assistantPendingPeekQuerySchema.safeParse({
      conversationId: url.searchParams.get("conversationId"),
    });
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues);
    }
    const conversation = await resolveStaffConversation({
      pipeline: options.pipeline,
      requestId: options.requestId,
      clientIp: options.clientIp,
      conversationId: parsed.data.conversationId,
      staffPrincipal: auth.staffPrincipal,
    });
    const bind = {
      actorId: auth.session.userId,
      companyId: auth.companySelector,
      conversationId: conversation.id,
    };
    const peeked = await options.pendingStore.peekOpen({
      conversationId: conversation.id,
      bind,
    });
    const pending =
      peeked.kind === "found"
        ? (publicPendingFromRecord(peeked.record) ?? null)
        : null;
    return jsonResponse(200, { pending }, options.requestId);
  } catch (error) {
    if (error instanceof CoreError) {
      options.pipeline.logger.error(
        { request_id: options.requestId, code: error.code },
        "staff assistant pending peek failed",
      );
    }
    return wireResponse(error, options.requestId);
  }
}

export async function executeStaffAssistantHostChat(
  options: StaffAssistantHostRuntime,
): Promise<Response> {
  const auth = await authenticateHost(options);
  if (!auth.ok) {
    return auth.response;
  }
  try {
    const parsed = assistantHostChatBodySchema.safeParse(
      await parseJson(options.request),
    );
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues);
    }
    const conversation = await resolveStaffConversation({
      pipeline: options.pipeline,
      requestId: options.requestId,
      clientIp: options.clientIp,
      conversationId: parsed.data.conversationId,
      staffPrincipal: auth.staffPrincipal,
    });
    const bind = {
      actorId: auth.session.userId,
      companyId: auth.companySelector,
      conversationId: conversation.id,
    };
    const locale = parsed.data.locale ?? STAFF_ASSISTANT_DEFAULT_LOCALE;
    return await options.conversationLock.withLock(
      conversation.id,
      async () => {
        const actor = await executeAction(options.pipeline, {
          action: getStaffActor,
          input: {},
          request: staffRequest({
            requestId: options.requestId,
            clientIp: options.clientIp,
            aiTraceId: options.requestId,
          }),
          principal: auth.staffPrincipal,
        });
        const appended = await executeAction(options.pipeline, {
          action: appendUserMessage,
          input: {
            conversationId: conversation.id,
            body: parsed.data.text,
          },
          request: staffRequest({
            requestId: options.requestId,
            clientIp: options.clientIp,
            aiTraceId: options.requestId,
            idempotencyKey: attemptKey(
              "message",
              conversation.id,
              options.requestId,
            ),
          }),
          principal: auth.staffPrincipal,
        });
        const history = await loadHistory({
          pipeline: options.pipeline,
          conversationId: conversation.id,
          requestId: options.requestId,
          clientIp: options.clientIp,
          principal: auth.staffPrincipal,
        });
        const contracts = filterStaffAiTools(options.registry.contracts(), {
          role: actor.role,
          permissions: [...actor.permissions],
        });
        const open = await options.pendingStore.peekOpen({
          conversationId: conversation.id,
          bind,
        });
        const checkpoint = createHostCheckpoint({
          pipeline: options.pipeline,
          conversationId: conversation.id,
          requestId: options.requestId,
          clientIp: options.clientIp,
          principal: auth.staffPrincipal,
          beginKey: chatTurnKey(appended.id),
        });
        const recoverStartedRuns = startedRunsForChatRecovery(history);
        const unfinishedResume = hasUnfinishedResumeTurn(history);
        const turn = await runStaffAssistantHostTurn({
          model: requireHostModel(options.model),
          messages: hostModelMessages(history, recoverStartedRuns),
          contracts,
          execute: (actionName, input, toolOptions) => {
            const action = requireImplementation(options.registry, actionName);
            const executionId = toolOptions.executionId;
            return executeAction(options.pipeline, {
              action,
              input,
              request: staffRequest({
                requestId: options.requestId,
                clientIp: options.clientIp,
                aiTraceId: options.requestId,
                toolCallId: toolOptions.toolCallId,
                ...(executionId !== undefined
                  ? {
                      idempotencyKey: executionAttemptKey(
                        conversation.id,
                        executionId,
                      ),
                    }
                  : {}),
              }),
              principal: auth.staffPrincipal,
            });
          },
          locale,
          turnContextAddendum: await hostTurnContextAddendum({
            pipeline: options.pipeline,
            requestId: options.requestId,
            clientIp: options.clientIp,
            staffPrincipal: auth.staffPrincipal,
            toolRuns: conversation.toolRuns,
          }),
          choiceBind: bind,
          openPending: (record) => options.pendingStore.open(record),
          checkPending: async ({ actionName }) => {
            const implementation =
              options.registry.getImplementation(actionName);
            if (implementation?.contract.risk === "read") {
              return { allow: true };
            }
            const current = await options.pendingStore.peekOpen({
              conversationId: conversation.id,
              bind,
            });
            if (current.kind === "found" || unfinishedResume) {
              return refuseHostPendingOpen(locale);
            }
            return { allow: true };
          },
          checkpoint,
          ...(recoverStartedRuns.length > 0 ? { recoverStartedRuns } : {}),
          ...(open.kind === "found" &&
          open.record.status === "open" &&
          isPendingReplaceActionName(open.record.actionName)
            ? {
                pendingReplace: {
                  actionName: open.record.actionName,
                  apply: (facade: unknown) =>
                    applyHostPendingReplace({
                      runtime: options,
                      record: open.record,
                      facade,
                      bind,
                      staffPrincipal: auth.staffPrincipal,
                    }),
                },
              }
            : {}),
        });
        const after = await options.pendingStore.peekOpen({
          conversationId: conversation.id,
          bind,
        });
        const pending =
          after.kind === "found"
            ? (publicPendingFromRecord(after.record) ?? null)
            : null;
        const toolResults = turn.toolRuns.flatMap((run) => {
          if (run.modelTrace === undefined || run.toolName === undefined) {
            return [];
          }
          return [{ toolName: run.toolName, output: run.modelTrace }];
        });
        return interactionResponse(
          okEnvelope({
            speech: turn.speech.text,
            toolResults,
            pending,
          }),
          options.requestId,
        );
      },
    );
  } catch (error) {
    if (error instanceof CoreError) {
      options.pipeline.logger.error(
        { request_id: options.requestId, code: error.code },
        "staff assistant host chat failed",
      );
    }
    return wireResponse(error, options.requestId);
  }
}

export interface CreateStaffAssistantHostAppOptions {
  readonly auth: {
    readonly api: {
      readonly getSession: (args: {
        headers: Headers;
      }) => Promise<{ user: { id: string } } | null>;
    };
  };
  readonly registry: ActionRegistry;
  readonly pipeline: ActionPipelineDeps;
  readonly pendingStore: StaffAssistantPendingStore;
  readonly conversationLock: ConversationLock;
  readonly model: LanguageModel;
  readonly getPeerAddress?: (c: Context<AppEnv>) => string;
}

export function createStaffAssistantHostApp(
  options: CreateStaffAssistantHostAppOptions,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use(async (c, next) => {
    c.set("requestId", resolveRequestId(c.req.header(REQUEST_ID_HEADER)));
    c.set(
      "clientIp",
      options.getPeerAddress === undefined
        ? "127.0.0.1"
        : options.getPeerAddress(c),
    );
    await next();
  });
  const runtime = (
    c: Context<AppEnv>,
  ): Omit<StaffAssistantHostRuntime, "request"> => ({
    requestId: c.get("requestId"),
    clientIp: c.get("clientIp"),
    registry: options.registry,
    pipeline: options.pipeline,
    getSession: async (headers) => {
      const session = await options.auth.api.getSession({ headers });
      if (session === null) {
        return null;
      }
      return { userId: session.user.id };
    },
    pendingStore: options.pendingStore,
    conversationLock: options.conversationLock,
    model: options.model,
  });
  app.post(ASSISTANT_HOST_CHAT_PATH, async (c) => {
    return executeStaffAssistantHostChat({
      ...runtime(c),
      request: c.req.raw,
    });
  });
  app.post(ASSISTANT_HOST_CHOICE_PATH, async (c) => {
    return executeStaffAssistantHostChoiceResume({
      ...runtime(c),
      request: c.req.raw,
    });
  });
  app.post(ASSISTANT_CONFIRM_PATH, async (c) => {
    return executeStaffAssistantHostConfirm({
      ...runtime(c),
      request: c.req.raw,
    });
  });
  app.post(ASSISTANT_PENDING_ABANDON_PATH, async (c) => {
    return executeStaffAssistantPendingAbandon({
      ...runtime(c),
      request: c.req.raw,
    });
  });
  app.get(ASSISTANT_PENDING_PATH, async (c) => {
    return executeStaffAssistantPendingPeek({
      ...runtime(c),
      request: c.req.raw,
    });
  });
  return app;
}
