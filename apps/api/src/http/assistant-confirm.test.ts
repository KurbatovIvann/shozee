import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as ShowzyAi from "@showzy/ai";
import { ActionRegistry } from "@showzy/core";
import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";

import { executeStaffAssistantConfirmResume } from "./assistant-confirm.js";

const UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const here = dirname(fileURLToPath(import.meta.url));

describe("POST /assistant/confirm unit", () => {
  it("does not import the gate, reply models, or confirmation GETDEL", () => {
    const src = readFileSync(join(here, "assistant-confirm.ts"), "utf8");
    expect(src).not.toContain("classifyStaffAssistantTurn");
    expect(src).not.toContain("generateText");
    expect(src).not.toContain("streamText");
    expect(src).not.toContain("createStaffLanguageModel");
    expect(src).not.toMatch(/redis\.call\(\s*"GETDEL"/);
    expect(src).toContain("commitTurnSpeech");
    expect(src).toContain("runPendingConfirmationResume");
    const chat = readFileSync(join(here, "assistant-chat.ts"), "utf8");
    expect(chat).not.toContain("runPendingConfirmationResume");
    expect(chat).not.toContain("createModellessAssistantTextStreamResponse");
    expect(chat).not.toContain("assistant.legacy_confirmation_header");
    expect(chat).not.toContain("CONFIRMATION_CHALLENGE_HEADER");
    expect(chat).not.toContain("PausedToolAttempt");
    expect(chat).not.toContain("resolvePausedToolAttempt");
    const redis = readFileSync(join(here, "../stores/redis.ts"), "utf8");
    expect(redis).toContain('redis.call("GETDEL"');
    expect(redis).toContain("PENDING_CLAIM_LUA");
    const claimLua = redis.slice(
      redis.indexOf("const PENDING_CLAIM_LUA"),
      redis.indexOf("const PENDING_COMPLETE_LUA"),
    );
    expect(claimLua).not.toContain("GETDEL");
  });

  it("returns 401 before claiming Redis or constructing models", async () => {
    const classify = vi.spyOn(ShowzyAi, "classifyStaffAssistantTurn");
    const stream = vi.spyOn(ShowzyAi, "streamStaffAssistantChat");
    const pendingStore = {
      open: vi.fn(),
      claim: vi.fn(),
      peek: vi.fn(),
      complete: vi.fn(),
      get: vi.fn(),
    };
    const response = await executeStaffAssistantConfirmResume({
      request: new Request("http://localhost:3000/assistant/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId: UUID,
          challengeId: UUID,
        }),
      }),
      requestId: UUID,
      clientIp: "127.0.0.1",
      registry: new ActionRegistry(),
      pipeline: { logger: pino({ enabled: false }) } as never,
      getSession: () => Promise.resolve(null),
      pendingStore,
    });
    expect(response.status).toBe(401);
    expect(pendingStore.claim).not.toHaveBeenCalled();
    expect(pendingStore.get).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    classify.mockRestore();
    stream.mockRestore();
  });

  it("is an HTTP mount, not a registry action", () => {
    const contractCheck = readFileSync(
      join(here, "../composition.contract-check.test.ts"),
      "utf8",
    );
    expect(contractCheck).not.toContain("assistant.confirm");
    const app = readFileSync(join(here, "app.ts"), "utf8");
    expect(app).toContain("ASSISTANT_CONFIRM_PATH");
    expect(app).toContain("executeStaffAssistantConfirmResume");
  });
});
