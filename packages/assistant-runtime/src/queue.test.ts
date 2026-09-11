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
  conversationId: "4f8a2c7e-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
  commandId: "9e8d7c6b-5a49-4382-b716-a5f4e3d2c1b0",
};

const mixedCase = {
  ...job,
  conversationId: "4F8A2C7E-1b3d-4E5F-8a9b-0C1D2E3F4A5B",
  commandId: "9E8D7C6B-5A49-4382-B716-A5F4E3D2C1B0",
};

describe("assistant queue contract", () => {
  it("names the queue and shares the job host's prefix", () => {
    expect(ASSISTANT_QUEUE_NAME).toBe("assistant");
    expect(ASSISTANT_QUEUE_PREFIX).toBe("showzy");
  });

  it("derives one job id per turn, so a repeated enqueue is the same job", () => {
    expect(assistantTurnJobId(job)).toBe(assistantTurnJobId({ ...job }));
    expect(assistantTurnJobId(job)).toBe(
      "turn.chat.4f8a2c7e-1b3d-4e5f-8a9b-0c1d2e3f4a5b.9e8d7c6b-5a49-4382-b716-a5f4e3d2c1b0",
    );
  });

  it("derives the same job id from a mixed-case uuid as from the lowercase one Postgres returns", () => {
    expect(assistantTurnJobId(mixedCase)).toBe(assistantTurnJobId(job));
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

  it("accepts the turn's identity", () => {
    expect(assistantTurnJobSchema.parse(job)).toEqual(job);
  });

  it("lowercases ids on parse, so a producer and the reconciler hold one payload", () => {
    expect(assistantTurnJobSchema.parse(mixedCase)).toEqual(job);
  });

  it("carries only the turn's identity: no person, session, company, request or client IP", () => {
    for (const field of [
      "userId",
      "sessionId",
      "companySelector",
      "companyId",
      "requestId",
      "clientIp",
    ]) {
      expect(
        assistantTurnJobSchema.safeParse({ ...job, [field]: "x" }).success,
        field,
      ).toBe(false);
    }
  });

  it("refuses a missing id, a non-uuid command, or an unknown version", () => {
    const { commandId, ...withoutCommand } = job;
    void commandId;
    expect(assistantTurnJobSchema.safeParse(withoutCommand).success).toBe(
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
