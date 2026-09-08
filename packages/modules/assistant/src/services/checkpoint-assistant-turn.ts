import { randomUUID } from "node:crypto";

import type { ActionCtx } from "@showzy/core";
import { CoreInvariantError, NotFoundError } from "@showzy/core/errors";
import {
  assistantMessages,
  assistantToolRuns,
} from "@showzy/db/schema/assistant";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";

import type {
  checkpointAssistantTurnInputSchema,
  checkpointAssistantTurnOutputSchema,
  checkpointPersistedOutcomeSchema,
} from "../actions/checkpoint-assistant-turn.contract.js";
import { loadOwnConversation } from "./load-conversation.js";
import { touchConversation } from "./touch-conversation.js";
import { requireWritable, type WritableStaffDb } from "./writable.js";

type StaffCtx = Extract<ActionCtx, { principal: "staff" }>;
type CheckpointInput = z.output<typeof checkpointAssistantTurnInputSchema>;
type CheckpointOutput = z.output<typeof checkpointAssistantTurnOutputSchema>;
type PersistedOutcome = z.output<typeof checkpointPersistedOutcomeSchema>;

const assistantMessageColumns = {
  id: assistantMessages.id,
  conversationId: assistantMessages.conversationId,
  role: assistantMessages.role,
  body: assistantMessages.body,
};

const checkpointToolRunColumns = {
  id: assistantToolRuns.id,
  messageId: assistantToolRuns.messageId,
  executionId: assistantToolRuns.executionId,
  seq: assistantToolRuns.seq,
  outcome: assistantToolRuns.outcome,
};

type AssistantMessageRow = {
  readonly id: string;
  readonly conversationId: string;
  readonly role: string;
  readonly body: string;
};

type CheckpointToolRunRow = {
  readonly id: string;
  readonly messageId: string;
  readonly executionId: string | null;
  readonly seq: number | null;
  readonly outcome: string;
};

function emptyCheckpoint(
  conversationId: string,
  messageId: string,
): CheckpointOutput {
  return {
    conversationId,
    messageId,
    executionId: null,
    toolRunId: null,
    seq: null,
    outcome: null,
  };
}

function toPersistedOutcome(outcome: string): PersistedOutcome {
  if (
    outcome === "started" ||
    outcome === "success" ||
    outcome === "error" ||
    outcome === "confirmation_required" ||
    outcome === "choice_required"
  ) {
    return outcome;
  }
  throw new CoreInvariantError(
    `assistant.checkpointAssistantTurn stored illegal outcome "${outcome}"`,
  );
}

function toolRunOutput(
  conversationId: string,
  row: CheckpointToolRunRow,
): CheckpointOutput {
  if (row.executionId === null || row.seq === null) {
    throw new CoreInvariantError(
      "assistant.checkpointAssistantTurn tool-run is missing executionId or seq",
    );
  }
  return {
    conversationId,
    messageId: row.messageId,
    executionId: row.executionId,
    toolRunId: row.id,
    seq: row.seq,
    outcome: toPersistedOutcome(row.outcome),
  };
}

async function loadOwnAssistantMessage(env: {
  readonly db: StaffCtx["db"] | WritableStaffDb;
  readonly companyId: string;
  readonly conversationId: string;
  readonly messageId: string;
}): Promise<AssistantMessageRow> {
  const row = (
    await env.db
      .select(assistantMessageColumns)
      .from(assistantMessages)
      .where(
        and(
          eq(assistantMessages.companyId, env.companyId),
          eq(assistantMessages.conversationId, env.conversationId),
          eq(assistantMessages.id, env.messageId),
          eq(assistantMessages.role, "assistant"),
        ),
      )
      .limit(1)
  )[0];
  if (row === undefined) {
    throw new NotFoundError();
  }
  return row;
}

async function beginTurn(env: {
  readonly ctx: StaffCtx;
  readonly db: WritableStaffDb;
  readonly conversationId: string;
}): Promise<CheckpointOutput> {
  const messageId = randomUUID();
  const inserted = (
    await env.db
      .insert(assistantMessages)
      .values({
        id: messageId,
        companyId: env.ctx.companyId,
        conversationId: env.conversationId,
        role: "assistant",
        body: "",
      })
      .returning(assistantMessageColumns)
  )[0];
  if (inserted === undefined) {
    throw new CoreInvariantError(
      "assistant.checkpointAssistantTurn begin insert returned no row",
    );
  }
  await touchConversation({
    db: env.db,
    companyId: env.ctx.companyId,
    conversationId: env.conversationId,
  });
  env.ctx.log.info(
    {
      conversation_id: env.conversationId,
      message_id: inserted.id,
      checkpoint_kind: "begin",
    },
    "assistant.checkpointAssistantTurn began assistant turn",
  );
  return emptyCheckpoint(env.conversationId, inserted.id);
}

async function stageRun(env: {
  readonly ctx: StaffCtx;
  readonly db: WritableStaffDb;
  readonly input: Extract<CheckpointInput, { kind: "stageRun" }>;
}): Promise<CheckpointOutput> {
  await loadOwnAssistantMessage({
    db: env.db,
    companyId: env.ctx.companyId,
    conversationId: env.input.conversationId,
    messageId: env.input.messageId,
  });
  const existing = (
    await env.db
      .select(checkpointToolRunColumns)
      .from(assistantToolRuns)
      .where(
        and(
          eq(assistantToolRuns.companyId, env.ctx.companyId),
          eq(assistantToolRuns.conversationId, env.input.conversationId),
          eq(assistantToolRuns.messageId, env.input.messageId),
          eq(assistantToolRuns.seq, env.input.seq),
        ),
      )
      .limit(1)
  )[0];
  if (existing !== undefined) {
    env.ctx.log.info(
      {
        conversation_id: env.input.conversationId,
        message_id: env.input.messageId,
        execution_id: existing.executionId,
        seq: env.input.seq,
        checkpoint_kind: "stageRun",
      },
      "assistant.checkpointAssistantTurn loaded staged tool run",
    );
    return toolRunOutput(env.input.conversationId, existing);
  }
  const executionId = randomUUID();
  const inserted = (
    await env.db
      .insert(assistantToolRuns)
      .values({
        companyId: env.ctx.companyId,
        conversationId: env.input.conversationId,
        messageId: env.input.messageId,
        actionName: env.input.actionName,
        toolCallId: env.input.toolCallId,
        toolName: env.input.toolName,
        toolInput: env.input.toolInput,
        executionId,
        seq: env.input.seq,
        outcome: "started",
        resultIds: [],
      })
      .returning(checkpointToolRunColumns)
  )[0];
  if (inserted === undefined) {
    throw new CoreInvariantError(
      "assistant.checkpointAssistantTurn stageRun insert returned no row",
    );
  }
  await touchConversation({
    db: env.db,
    companyId: env.ctx.companyId,
    conversationId: env.input.conversationId,
  });
  env.ctx.log.info(
    {
      conversation_id: env.input.conversationId,
      message_id: env.input.messageId,
      execution_id: executionId,
      seq: env.input.seq,
      checkpoint_kind: "stageRun",
    },
    "assistant.checkpointAssistantTurn staged tool run",
  );
  return toolRunOutput(env.input.conversationId, inserted);
}

async function finishRun(env: {
  readonly ctx: StaffCtx;
  readonly db: WritableStaffDb;
  readonly input: Extract<CheckpointInput, { kind: "finishRun" }>;
}): Promise<CheckpointOutput> {
  const updated = (
    await env.db
      .update(assistantToolRuns)
      .set({
        outcome: env.input.outcome,
        resultIds: env.input.resultIds,
        challengeId: env.input.challengeId,
        modelTrace:
          env.input.modelTrace !== undefined ? env.input.modelTrace : null,
      })
      .where(
        and(
          eq(assistantToolRuns.companyId, env.ctx.companyId),
          eq(assistantToolRuns.conversationId, env.input.conversationId),
          eq(assistantToolRuns.executionId, env.input.executionId),
        ),
      )
      .returning(checkpointToolRunColumns)
  )[0];
  if (updated === undefined) {
    throw new NotFoundError();
  }
  await touchConversation({
    db: env.db,
    companyId: env.ctx.companyId,
    conversationId: env.input.conversationId,
  });
  env.ctx.log.info(
    {
      conversation_id: env.input.conversationId,
      message_id: updated.messageId,
      execution_id: env.input.executionId,
      outcome: env.input.outcome,
      checkpoint_kind: "finishRun",
    },
    "assistant.checkpointAssistantTurn finished tool run",
  );
  return toolRunOutput(env.input.conversationId, updated);
}

async function completeTurn(env: {
  readonly ctx: StaffCtx;
  readonly db: WritableStaffDb;
  readonly input: Extract<CheckpointInput, { kind: "complete" }>;
}): Promise<CheckpointOutput> {
  await loadOwnAssistantMessage({
    db: env.db,
    companyId: env.ctx.companyId,
    conversationId: env.input.conversationId,
    messageId: env.input.messageId,
  });
  const updated = (
    await env.db
      .update(assistantMessages)
      .set({ body: env.input.body })
      .where(
        and(
          eq(assistantMessages.companyId, env.ctx.companyId),
          eq(assistantMessages.conversationId, env.input.conversationId),
          eq(assistantMessages.id, env.input.messageId),
          eq(assistantMessages.role, "assistant"),
        ),
      )
      .returning(assistantMessageColumns)
  )[0];
  if (updated === undefined) {
    throw new NotFoundError();
  }
  await touchConversation({
    db: env.db,
    companyId: env.ctx.companyId,
    conversationId: env.input.conversationId,
  });
  env.ctx.log.info(
    {
      conversation_id: env.input.conversationId,
      message_id: updated.id,
      checkpoint_kind: "complete",
    },
    "assistant.checkpointAssistantTurn completed assistant turn",
  );
  return emptyCheckpoint(env.input.conversationId, updated.id);
}

export async function checkpointStaffAssistantTurn(env: {
  readonly ctx: StaffCtx;
  readonly input: CheckpointInput;
}): Promise<CheckpointOutput> {
  const { ctx, input } = env;
  const db = requireWritable(ctx.db);

  await loadOwnConversation({
    db,
    companyId: ctx.companyId,
    userId: ctx.userId,
    conversationId: input.conversationId,
  });

  switch (input.kind) {
    case "begin":
      return beginTurn({
        ctx,
        db,
        conversationId: input.conversationId,
      });
    case "stageRun":
      return stageRun({ ctx, db, input });
    case "finishRun":
      return finishRun({ ctx, db, input });
    case "complete":
      return completeTurn({ ctx, db, input });
  }
}
