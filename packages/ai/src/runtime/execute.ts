/**
 * Sequential tool execute for the new host (ADR-0037 / SHO-520).
 *
 * Tools in one model step run one after another. Pending is checked before
 * each domain execute (T1 stub always allows). After HITL, further
 * executes this turn are skipped. Do not import the gate.
 */
import { ConfirmationRequiredError, CoreError } from "@showzy/core/errors";

import type { ActionToolExecute } from "../action-tool.js";
import {
  STAFF_ASSISTANT_NEEDS_CHOICE_STATUS,
  isStaffAssistantNeedsChoiceOutput,
  needsChoiceFromOrdersCreateConflict,
  staffAssistantTypedDomainErrorOutput,
  type ChoiceBind,
  type ChoiceRecord,
} from "../choice.js";
import {
  isStaffAssistantConfirmationOutput,
  type StaffAssistantConfirmationOutput,
} from "../confirmation.js";
import {
  confirmationPendingRecord,
  pendingChoiceRecordFromChoiceRecord,
  pendingOpenRefuseOutput,
  type PendingInteractionRecord,
} from "../pending.js";
import {
  STAFF_ASSISTANT_DEFAULT_LOCALE,
  type StaffAssistantLocale,
} from "../locale.js";
import {
  extractUuidResultIds,
  STAFF_ASSISTANT_TOOL_CALL_ID_MAX,
  STAFF_ASSISTANT_TOOL_RUNS_MAX,
  type StaffAssistantToolRun,
  type StaffAssistantToolRunOutcome,
} from "../staff-assistant-stream.js";
import { STAFF_ASSISTANT_TOOL_ERROR_FALLBACK } from "../turn-speech.js";

export type StaffAssistantHostPendingDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly output?: unknown };

export type StaffAssistantHostPendingCheck = (input: {
  readonly actionName: string;
}) => Promise<StaffAssistantHostPendingDecision>;

export const HOST_HITL_PAUSED_STATUS = "hitl_paused" as const;

export const HOST_HITL_PAUSED_OUTPUT = {
  status: HOST_HITL_PAUSED_STATUS,
} as const;

export type HostHitlPausedOutput = typeof HOST_HITL_PAUSED_OUTPUT;

export function isHostHitlPausedOutput(
  value: unknown,
): value is HostHitlPausedOutput {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "status" in value &&
    value.status === HOST_HITL_PAUSED_STATUS
  );
}

export function allowHostPendingAlways(): Promise<StaffAssistantHostPendingDecision> {
  return Promise.resolve({ allow: true });
}

export function refuseHostPendingOpen(
  locale?: "uk" | "en",
): StaffAssistantHostPendingDecision {
  return { allow: false, output: pendingOpenRefuseOutput(locale) };
}

export interface StaffAssistantHostCheckpointStageInput {
  readonly messageId: string;
  readonly seq: number;
  readonly actionName: string;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly toolInput: unknown;
}

export interface StaffAssistantHostCheckpointFinishInput {
  readonly executionId: string;
  readonly outcome: StaffAssistantToolRunOutcome;
  readonly modelTrace?: unknown;
  readonly resultIds: readonly string[];
  readonly challengeId?: string;
}

export interface StaffAssistantHostCheckpoint {
  begin(): Promise<{ readonly messageId: string }>;
  stageRun(
    input: StaffAssistantHostCheckpointStageInput,
  ): Promise<{ readonly executionId: string }>;
  finishRun(input: StaffAssistantHostCheckpointFinishInput): Promise<void>;
  complete(input: {
    readonly messageId: string;
    readonly body: string;
  }): Promise<void>;
}

export interface StaffAssistantHostExecuteState {
  paused: boolean;
  readonly runs: StaffAssistantToolRun[];
  messageId?: string;
  seq: number;
  readonly facadeByToolCallId: Map<
    string,
    { readonly toolName: string; readonly toolInput: unknown }
  >;
  readonly executionIdByToolCallId: Map<string, string>;
  readonly toolQueue: {
    enqueue: <T>(work: () => Promise<T>) => Promise<T>;
  };
}

export function emptyHostExecuteState(): StaffAssistantHostExecuteState {
  return {
    paused: false,
    runs: [],
    seq: 0,
    facadeByToolCallId: new Map(),
    executionIdByToolCallId: new Map(),
    toolQueue: createSerialQueue(),
  };
}

function clipToolCallId(toolCallId: string): string {
  return toolCallId.slice(0, STAFF_ASSISTANT_TOOL_CALL_ID_MAX);
}

function hostInternalToolErrorMessage(locale: StaffAssistantLocale): string {
  return STAFF_ASSISTANT_TOOL_ERROR_FALLBACK[locale];
}

function confirmationFromError(
  error: ConfirmationRequiredError,
  actionName: string,
  toolCallId: string,
): StaffAssistantConfirmationOutput {
  return {
    status: "confirmation_required",
    challengeId: error.challenge.challengeId,
    summary: error.challenge.summary,
    expiresAt: error.challenge.expiresAt,
    actionName,
    toolCallId,
  };
}

function createSerialQueue(): {
  enqueue: <T>(work: () => Promise<T>) => Promise<T>;
} {
  let tail: Promise<void> = Promise.resolve();
  return {
    enqueue<T>(work: () => Promise<T>): Promise<T> {
      const run = tail.then(work);
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}

function hitlFromReturnedOutput(output: unknown):
  | {
      readonly outcome: "confirmation_required" | "choice_required";
      readonly challengeId?: string;
    }
  | undefined {
  if (isStaffAssistantConfirmationOutput(output)) {
    return {
      outcome: "confirmation_required",
      challengeId: output.challengeId,
    };
  }
  if (isStaffAssistantNeedsChoiceOutput(output)) {
    return {
      outcome: "choice_required",
      challengeId: output.challengeId,
    };
  }
  if (
    typeof output === "object" &&
    output !== null &&
    "status" in output &&
    output.status === STAFF_ASSISTANT_NEEDS_CHOICE_STATUS
  ) {
    const challengeId =
      "challengeId" in output && typeof output.challengeId === "string"
        ? output.challengeId
        : undefined;
    if (challengeId === undefined) {
      return { outcome: "choice_required" };
    }
    return { outcome: "choice_required", challengeId };
  }
  return undefined;
}

function wrapDomainExecute(
  execute: ActionToolExecute,
  state: StaffAssistantHostExecuteState,
  hooks: {
    readonly locale: StaffAssistantLocale;
    readonly choiceBind?: ChoiceBind;
    readonly openChoice?: (record: ChoiceRecord) => Promise<boolean>;
    readonly openPending?: (
      record: PendingInteractionRecord,
    ) => Promise<boolean>;
    readonly mintChoiceId?: () => string;
  },
): ActionToolExecute {
  return async (actionName, input, options) => {
    const toolCallId = clipToolCallId(options.toolCallId);
    if (state.runs.length >= STAFF_ASSISTANT_TOOL_RUNS_MAX) {
      return {
        status: "error",
        code: "INTERNAL",
        message: hostInternalToolErrorMessage(hooks.locale),
      };
    }
    try {
      const executionId = state.executionIdByToolCallId.get(toolCallId);
      const output: unknown = await execute(
        actionName,
        input,
        executionId === undefined
          ? { toolCallId }
          : { toolCallId, executionId },
      );
      const hitl = hitlFromReturnedOutput(output);
      if (hitl !== undefined) {
        state.runs.push({
          actionName,
          toolCallId,
          resultIds: [],
          outcome: hitl.outcome,
          ...(hitl.challengeId !== undefined
            ? { challengeId: hitl.challengeId }
            : {}),
        });
        state.paused = true;
        return output;
      }
      state.runs.push({
        actionName,
        toolCallId,
        resultIds: extractUuidResultIds(output),
        outcome: "success",
      });
      return output;
    } catch (error) {
      if (error instanceof ConfirmationRequiredError) {
        const confirmation = confirmationFromError(
          error,
          actionName,
          toolCallId,
        );
        if (hooks.openPending !== undefined && hooks.choiceBind !== undefined) {
          const stagedId = state.executionIdByToolCallId.get(toolCallId);
          const opened = await hooks.openPending(
            confirmationPendingRecord({
              challengeId: confirmation.challengeId,
              bind: hooks.choiceBind,
              actionName,
              toolCallId,
              canonicalInput: input,
              summary: confirmation.summary,
              challengeExpiresAt: confirmation.expiresAt,
              locale: hooks.locale,
              ...(stagedId !== undefined ? { executionId: stagedId } : {}),
            }),
          );
          if (!opened) {
            state.runs.push({
              actionName,
              toolCallId,
              resultIds: [],
              outcome: "error",
            });
            return {
              status: "error",
              code: "INTERNAL",
              message: hostInternalToolErrorMessage(hooks.locale),
            };
          }
        }
        state.runs.push({
          actionName,
          toolCallId,
          challengeId: confirmation.challengeId,
          resultIds: [],
          outcome: "confirmation_required",
        });
        state.paused = true;
        return confirmation;
      }
      const openPending = hooks.openPending;
      const openChoiceForPending =
        openPending !== undefined && hooks.choiceBind !== undefined
          ? async (record: ChoiceRecord) => {
              const stagedId = state.executionIdByToolCallId.get(toolCallId);
              return openPending(
                pendingChoiceRecordFromChoiceRecord(record, {
                  actionName,
                  toolCallId,
                  ...(stagedId !== undefined ? { executionId: stagedId } : {}),
                }),
              );
            }
          : hooks.openChoice;
      const needsChoice = await needsChoiceFromOrdersCreateConflict({
        actionName,
        input,
        error,
        locale: hooks.locale,
        ...(hooks.choiceBind !== undefined ? { bind: hooks.choiceBind } : {}),
        ...(openChoiceForPending !== undefined
          ? { openChoice: openChoiceForPending }
          : {}),
        ...(hooks.mintChoiceId !== undefined
          ? { mintChoiceId: hooks.mintChoiceId }
          : {}),
      });
      if (needsChoice !== undefined) {
        state.runs.push({
          actionName,
          toolCallId,
          challengeId: needsChoice.challengeId,
          resultIds: [],
          outcome: "choice_required",
        });
        state.paused = true;
        return needsChoice;
      }
      if (error instanceof CoreError) {
        state.runs.push({
          actionName,
          toolCallId,
          resultIds: [],
          outcome: "error",
        });
        const domainError = staffAssistantTypedDomainErrorOutput(error);
        if (domainError !== undefined) {
          return domainError;
        }
        return {
          status: "error",
          code: error.code,
          message: error.clientMessage,
        };
      }
      state.runs.push({
        actionName,
        toolCallId,
        resultIds: [],
        outcome: "error",
      });
      return {
        status: "error",
        code: "INTERNAL",
        message: hostInternalToolErrorMessage(hooks.locale),
      };
    }
  };
}

export function wrapHostSequentialExecute(
  execute: ActionToolExecute,
  state: StaffAssistantHostExecuteState,
  hooks: {
    readonly locale?: StaffAssistantLocale;
    readonly choiceBind?: ChoiceBind;
    readonly openChoice?: (record: ChoiceRecord) => Promise<boolean>;
    readonly openPending?: (
      record: PendingInteractionRecord,
    ) => Promise<boolean>;
    readonly mintChoiceId?: () => string;
    readonly checkPending?: StaffAssistantHostPendingCheck;
    readonly checkpoint?: Pick<StaffAssistantHostCheckpoint, "stageRun">;
    /**
     * When false, the caller (clip wrapper) already owns `state.toolQueue`.
     * Nested enqueue would deadlock. Default true for execute-only tests.
     */
    readonly enqueue?: boolean;
  },
): ActionToolExecute {
  const locale = hooks.locale ?? STAFF_ASSISTANT_DEFAULT_LOCALE;
  const checkPending = hooks.checkPending ?? allowHostPendingAlways;
  const domain = wrapDomainExecute(execute, state, {
    locale,
    ...(hooks.choiceBind !== undefined ? { choiceBind: hooks.choiceBind } : {}),
    ...(hooks.openChoice !== undefined ? { openChoice: hooks.openChoice } : {}),
    ...(hooks.openPending !== undefined
      ? { openPending: hooks.openPending }
      : {}),
    ...(hooks.mintChoiceId !== undefined
      ? { mintChoiceId: hooks.mintChoiceId }
      : {}),
  });
  const run = async (
    actionName: string,
    input: unknown,
    options: { readonly toolCallId: string; readonly executionId?: string },
  ): Promise<unknown> => {
    if (state.paused) {
      return HOST_HITL_PAUSED_OUTPUT;
    }
    const pending = await checkPending({ actionName });
    if (!pending.allow) {
      if (pending.output !== undefined) {
        return pending.output;
      }
      return {
        status: "error",
        code: "INTERNAL",
        message: hostInternalToolErrorMessage(locale),
      };
    }
    if (state.runs.length >= STAFF_ASSISTANT_TOOL_RUNS_MAX) {
      return {
        status: "error",
        code: "INTERNAL",
        message: hostInternalToolErrorMessage(locale),
      };
    }
    const toolCallId = clipToolCallId(options.toolCallId);
    if (hooks.checkpoint !== undefined && state.messageId !== undefined) {
      const facade = state.facadeByToolCallId.get(toolCallId);
      const staged = await hooks.checkpoint.stageRun({
        messageId: state.messageId,
        seq: state.seq,
        actionName,
        toolName: facade?.toolName ?? actionName,
        toolCallId,
        toolInput: facade?.toolInput ?? input,
      });
      state.seq += 1;
      state.executionIdByToolCallId.set(toolCallId, staged.executionId);
    }
    return domain(actionName, input, options);
  };
  const enqueue = hooks.enqueue ?? true;
  return (actionName, input, options) =>
    enqueue
      ? state.toolQueue.enqueue(() => run(actionName, input, options))
      : run(actionName, input, options);
}
