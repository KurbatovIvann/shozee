import { describe, expect, it } from "vitest";

import {
  ASSISTANT_QUEUE_NAME,
  ASSISTANT_QUEUE_PREFIX,
  assistantTurnJobId,
  assistantTurnJobSchema,
  type AssistantTurnJob,
} from "./queue.js";

const job: AssistantTurnJob = {
  version: 1,
  kind: "chat",
  userId: "user-1",
  sessionId: "session-1",
  companySelector: "0b6f3f1e-4a4f-4c61-9d2e-7c0f1b7d5a10",
  conversationId: "4f8a2c7e-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
  commandId: "9e8d7c6b-5a49-4382-b716-a5f4e3d2c1b0",
  requestId: "req-1",
  clientIp: "203.0.113.7",
};

describe("assistant queue contract", () => {
  it("names the queue and shares the job host's prefix", () => {
    expect(ASSISTANT_QUEUE_NAME).toBe("assistant");
    expect(ASSISTANT_QUEUE_PREFIX).toBe("showzy");
  });

  it("derives one job id per command, so a repeated enqueue is the same job", () => {
    expect(assistantTurnJobId(job)).toBe(assistantTurnJobId({ ...job }));
    expect(assistantTurnJobId(job)).toBe(
      "turn.chat.4f8a2c7e-1b3d-4e5f-8a9b-0c1d2e3f4a5b.9e8d7c6b-5a49-4382-b716-a5f4e3d2c1b0",
    );
  });

  it("keeps a send and an answer under one token as different jobs", () => {
    expect(assistantTurnJobId(job)).not.toBe(
      assistantTurnJobId({ ...job, kind: "answer" }),
    );
  });

  it("keeps one token in two conversations as different jobs", () => {
    expect(assistantTurnJobId(job)).not.toBe(
      assistantTurnJobId({
        ...job,
        conversationId: "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d",
      }),
    );
  });

  it("derives an id BullMQ accepts as custom: no colon, not an integer", () => {
    const id = assistantTurnJobId(job);
    expect(id).not.toContain(":");
    expect(id).not.toMatch(/^\d+$/);
  });

  it("accepts a complete payload", () => {
    expect(assistantTurnJobSchema.parse(job)).toEqual(job);
  });

  it("refuses a payload with an unknown field, a missing field, or a non-uuid command", () => {
    expect(
      assistantTurnJobSchema.safeParse({ ...job, companyId: "x" }).success,
    ).toBe(false);
    const { sessionId, ...withoutSession } = job;
    void sessionId;
    expect(assistantTurnJobSchema.safeParse(withoutSession).success).toBe(
      false,
    );
    expect(
      assistantTurnJobSchema.safeParse({ ...job, commandId: "not-a-uuid" })
        .success,
    ).toBe(false);
    expect(
      assistantTurnJobSchema.safeParse({ ...job, version: 2 }).success,
    ).toBe(false);
  });
});
