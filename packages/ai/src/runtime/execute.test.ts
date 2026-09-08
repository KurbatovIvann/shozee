import { ConfirmationRequiredError } from "@showzy/core/errors";
import { describe, expect, it, vi } from "vitest";

import type { ActionToolExecute } from "../action-tool.js";
import { STAFF_ASSISTANT_TOOL_ERROR_FALLBACK } from "../turn-speech.js";
import {
  PENDING_OPEN_CODE,
  type PendingInteractionRecord,
} from "../pending.js";
import {
  emptyHostExecuteState,
  HOST_HITL_PAUSED_OUTPUT,
  refuseHostPendingOpen,
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
      begin: () => Promise.resolve({ messageId: "msg-1" }),
      stageRun: (input) => {
        const existing = rows.find((row) => row.seq === input.seq);
        if (existing !== undefined) {
          return Promise.resolve({ executionId: existing.executionId });
        }
        const executionId = `stored-${String(rows.length)}`;
        rows.push({
          seq: input.seq,
          executionId,
          toolInput: input.toolInput,
        });
        return Promise.resolve({ executionId });
      },
      finishRun: () => {
        throw new Error("finishRun must be skipped in this crash window");
      },
      complete: () => {
        throw new Error("complete is not part of the execute crash window");
      },
    };
    let writes = 0;
    const committed = new Map<string, string>();
    const execute: ActionToolExecute = (_actionName, _input, options) => {
      const executionId = options.executionId;
      if (executionId === undefined) {
        throw new Error("execute must receive a persisted executionId");
      }
      const existing = committed.get(executionId);
      if (existing !== undefined) {
        return Promise.resolve({ id: existing });
      }
      writes += 1;
      const id = `write-${String(writes)}`;
      committed.set(executionId, id);
      return Promise.resolve({ id });
    };
    const executeSpy = vi.fn(execute);

    const firstState = emptyHostState();
    firstState.messageId = "msg-1";
    const firstWrapped = wrapHostSequentialExecute(executeSpy, firstState, {
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
    const replayWrapped = wrapHostSequentialExecute(executeSpy, replayState, {
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
    expect(executeSpy).toHaveBeenNthCalledWith(
      2,
      "assistant.createConversation",
      { title: "from staged tool" },
      { toolCallId: "call-create", executionId: recovered.executionId },
    );
  });

  it("refuses an independent write, including the same actionName, while pending is open", async () => {
    const execute = vi.fn(() => Promise.resolve({ orderId: customerId }));
    const state = emptyHostState();
    const wrapped = wrapHostSequentialExecute(execute, state, {
      checkPending: async ({ actionName }) => {
        expect(actionName).toBe("orders.create");
        return refuseHostPendingOpen("en");
      },
    });
    const output = await wrapped(
      "orders.create",
      { customer: { by: "id", id: customerId } },
      { toolCallId: "call-create" },
    );
    expect(execute).not.toHaveBeenCalled();
    expect(output).toMatchObject({
      status: "error",
      code: PENDING_OPEN_CODE,
    });
  });

  it("allows reads while pending is open", async () => {
    const execute = vi.fn(() =>
      Promise.resolve({ items: [], nextCursor: null }),
    );
    const state = emptyHostState();
    const wrapped = wrapHostSequentialExecute(execute, state, {
      checkPending: () => Promise.resolve({ allow: true }),
    });
    await wrapped("orders.list", {}, { toolCallId: "call-list" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("writes a confirmation pending record from wrapExecute via openPending", async () => {
    const opened: PendingInteractionRecord[] = [];
    const execute = vi.fn(() =>
      Promise.reject(
        new ConfirmationRequiredError({
          challengeId,
          summary: "Delete this archived customer.",
          expiresAt: "2026-09-01T12:00:00.000Z",
        }),
      ),
    );
    const state = emptyHostState();
    state.executionIdByToolCallId.set("call-delete", "exec-staged");
    const wrapped = wrapHostSequentialExecute(execute, state, {
      choiceBind: {
        actorId: "anna",
        companyId: "22222222-2222-4222-8222-222222222222",
        conversationId: "11111111-1111-4111-8111-111111111111",
      },
      openPending: (record) => {
        opened.push(record);
        return Promise.resolve(true);
      },
    });
    await wrapped(
      "customers.deleteCustomer",
      { id: customerId },
      { toolCallId: "call-delete" },
    );
    expect(opened).toEqual([
      expect.objectContaining({
        kind: "confirmation",
        id: challengeId,
        actionName: "customers.deleteCustomer",
        executionId: "exec-staged",
        canonicalInput: { id: customerId },
      }),
    ]);
  });
});
