import { ConfirmationRequiredError } from "@showzy/core/errors";
import { describe, expect, it, vi } from "vitest";

import { STAFF_ASSISTANT_TOOL_ERROR_FALLBACK } from "../turn-speech.js";
import {
  emptyHostExecuteState,
  HOST_HITL_PAUSED_OUTPUT,
  wrapHostSequentialExecute,
  type StaffAssistantHostCheckpoint,
  type StaffAssistantHostExecuteState,
} from "./execute.js";

const customerId = "11111111-1111-4111-8111-111111111111";
const challengeId = "22222222-2222-4222-8222-222222222222";

function emptyHostState(): StaffAssistantHostExecuteState {
  return emptyHostExecuteState();
}

describe("wrapHostSequentialExecute", () => {
  it("returns a hitl_paused sentinel for siblings, not INTERNAL", async () => {
    const execute = vi.fn((actionName: string) => {
      if (actionName === "customers.deleteCustomer") {
        return Promise.reject(
          new ConfirmationRequiredError({
            challengeId,
            summary: "Delete this archived customer.",
            expiresAt: "2026-09-01T12:00:00.000Z",
          }),
        );
      }
      return Promise.resolve({ items: [], nextCursor: null });
    });
    const state = emptyHostState();
    const wrapped = wrapHostSequentialExecute(execute, state, {});
    await wrapped(
      "customers.deleteCustomer",
      { id: customerId },
      {
        toolCallId: "call-delete",
      },
    );
    const sibling = await wrapped(
      "orders.list",
      {},
      { toolCallId: "call-list" },
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(sibling).toEqual(HOST_HITL_PAUSED_OUTPUT);
    expect(sibling).not.toMatchObject({
      status: "error",
      code: "INTERNAL",
    });
    expect(JSON.stringify(sibling)).not.toContain(
      STAFF_ASSISTANT_TOOL_ERROR_FALLBACK.en,
    );
    expect(JSON.stringify(sibling)).not.toContain(
      STAFF_ASSISTANT_TOOL_ERROR_FALLBACK.uk,
    );
  });

  it("records a returned confirmation_required payload as that outcome, not success", async () => {
    const execute = vi.fn(() =>
      Promise.resolve({
        status: "confirmation_required" as const,
        challengeId,
        summary: "Delete this archived customer.",
        expiresAt: "2026-09-01T12:00:00.000Z",
        actionName: "customers.deleteCustomer",
        toolCallId: "call-delete",
      }),
    );
    const state = emptyHostState();
    const wrapped = wrapHostSequentialExecute(execute, state, {});
    const output = await wrapped(
      "customers.deleteCustomer",
      { id: customerId },
      { toolCallId: "call-delete" },
    );
    expect(output).toMatchObject({
      status: "confirmation_required",
      challengeId,
    });
    expect(state.runs).toEqual([
      {
        actionName: "customers.deleteCustomer",
        toolCallId: "call-delete",
        challengeId,
        resultIds: [],
        outcome: "confirmation_required",
      },
    ]);
    expect(state.paused).toBe(true);
    expect(state.runs[0]?.outcome).not.toBe("success");
  });

  it("records a returned needs_choice payload as choice_required, not success", async () => {
    const execute = vi.fn(() =>
      Promise.resolve({
        status: "needs_choice" as const,
        challengeId,
        reason: "variant_required" as const,
        productName: "Macarons",
        options: [{ id: customerId, label: "Lemon" }],
        optionsTruncated: false,
      }),
    );
    const state = emptyHostState();
    const wrapped = wrapHostSequentialExecute(execute, state, {});
    await wrapped("orders.create", {}, { toolCallId: "call-create" });
    expect(state.runs[0]?.outcome).toBe("choice_required");
    expect(state.runs[0]?.challengeId).toBe(challengeId);
    expect(state.runs[0]?.outcome).not.toBe("success");
    expect(state.paused).toBe(true);
  });

  it("recovers executionId from staged storage after execute and before finishRun", async () => {
    const rows: Array<{
      readonly seq: number;
      readonly executionId: string;
      readonly toolInput: unknown;
    }> = [];
    const checkpoint: StaffAssistantHostCheckpoint = {
      begin: async () => ({ messageId: "msg-1" }),
      stageRun: async (input) => {
        const existing = rows.find((row) => row.seq === input.seq);
        if (existing !== undefined) {
          return { executionId: existing.executionId };
        }
        const executionId = `stored-${String(rows.length)}`;
        rows.push({
          seq: input.seq,
          executionId,
          toolInput: input.toolInput,
        });
        return { executionId };
      },
      finishRun: async () => {
        throw new Error("finishRun must be skipped in this crash window");
      },
      complete: async () => {
        throw new Error("complete is not part of the execute crash window");
      },
    };
    let writes = 0;
    const committed = new Map<string, string>();
    const execute = vi.fn(
      async (_actionName: string, _input: unknown, options) => {
        const executionId = options.executionId;
        if (executionId === undefined) {
          throw new Error("execute must receive a persisted executionId");
        }
        const existing = committed.get(executionId);
        if (existing !== undefined) {
          return { id: existing };
        }
        writes += 1;
        const id = `write-${String(writes)}`;
        committed.set(executionId, id);
        return { id };
      },
    );

    const firstState = emptyHostState();
    firstState.messageId = "msg-1";
    const firstWrapped = wrapHostSequentialExecute(execute, firstState, {
      checkpoint,
    });
    const first = await firstWrapped(
      "assistant.createConversation",
      { title: "from staged tool" },
      { toolCallId: "call-create" },
    );
    expect(first).toEqual({ id: "write-1" });
    expect(writes).toBe(1);
    expect(rows).toHaveLength(1);

    const recovered = rows[0];
    if (recovered === undefined) {
      throw new Error("expected execution_id in the staged store");
    }
    expect(recovered.executionId).toBe("stored-0");
    expect(recovered.toolInput).toEqual({ title: "from staged tool" });

    const replayState = emptyHostState();
    replayState.messageId = "msg-1";
    const replayWrapped = wrapHostSequentialExecute(execute, replayState, {
      checkpoint,
    });
    const replay = await replayWrapped(
      "assistant.createConversation",
      { title: "from staged tool" },
      { toolCallId: "call-create" },
    );
    expect(replay).toEqual({ id: "write-1" });
    expect(writes).toBe(1);
    expect(rows).toHaveLength(1);
    expect(execute).toHaveBeenNthCalledWith(
      2,
      "assistant.createConversation",
      { title: "from staged tool" },
      { toolCallId: "call-create", executionId: recovered.executionId },
    );
  });
});
