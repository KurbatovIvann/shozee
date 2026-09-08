import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PENDING_REPLACE_TOOL_NAME } from "@showzy/ai";

import {
  ASSISTANT_CONFIRM_PATH,
  ASSISTANT_HOST_CHAT_PATH,
  ASSISTANT_HOST_CHOICE_PATH,
  ASSISTANT_PENDING_ABANDON_PATH,
  ASSISTANT_PENDING_PATH,
} from "./assistant-host.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("live staff-assistant host (SHO-524)", () => {
  it("does not mount unpublished /assistant/host/chat on production createApp", () => {
    const appSrc = readFileSync(join(here, "app.ts"), "utf8");
    expect(appSrc).not.toContain("ASSISTANT_HOST_CHAT_PATH");
    expect(appSrc).not.toContain('"/assistant/host/chat"');
    expect(appSrc).toContain("ASSISTANT_CHAT_PATH");
    expect(appSrc).toContain("ASSISTANT_CONFIRM_PATH");
    expect(appSrc).toContain("ASSISTANT_PENDING_ABANDON_PATH");
    expect(appSrc).toContain("ASSISTANT_PENDING_PATH");
    expect(appSrc).toContain("ASSISTANT_HOST_CHOICE_PATH");
    expect(appSrc).not.toContain("createMemoryChoiceStore");
    expect(appSrc).not.toContain("choiceStore");
    const bootSrc = readFileSync(join(here, "../boot.ts"), "utf8");
    expect(bootSrc).toContain("createRedisPendingStore");
    expect(bootSrc).toContain("createRedisConversationLock");
    expect(bootSrc).not.toContain("createRedisChoiceStore");
  });

  it("exposes confirm, abandon, pending GET, and host chat as HTTP paths", () => {
    expect(ASSISTANT_CONFIRM_PATH).toBe("/assistant/confirm");
    expect(ASSISTANT_PENDING_ABANDON_PATH).toBe("/assistant/pending/abandon");
    expect(ASSISTANT_PENDING_PATH).toBe("/assistant/pending");
    expect(ASSISTANT_HOST_CHAT_PATH).toBe("/assistant/host/chat");
    expect(ASSISTANT_HOST_CHOICE_PATH).toBe("/assistant/choice");
    const hostSrc = readFileSync(join(here, "assistant-host.ts"), "utf8");
    expect(hostSrc).toContain("createStaffAssistantHostApp");
    expect(hostSrc).toContain("`finish:${input.executionId}:${input.outcome}`");
    expect(hostSrc).toContain("assistant-invocation.js");
    expect(hostSrc).not.toContain("assistant-chat.js");
    expect(hostSrc).not.toMatch(/implementAction\s*\(/);
    expect(hostSrc).not.toMatch(/defineActionContract\s*\(/);
    expect(hostSrc).toContain("catalog.resolveLineReferences");
    expect(hostSrc).toContain("customers.resolveCustomerReference");
    expect(hostSrc).not.toContain(
      "pending_replace choice probe must not execute the handler",
    );
    expect(hostSrc).not.toContain("classifyStaffAssistantTurn");
    expect(hostSrc).not.toContain("staffAssistantShouldSkipIntentGate");
    expect(hostSrc).not.toContain("gateLanguageModel");
    expect(hostSrc).not.toContain("resolveGateLanguageModel");
    expect(hostSrc).not.toContain("staffAssistantGateToolPolicy");
    expect(hostSrc).not.toContain('run.action.replace(".", "_")');
    expect(hostSrc).toContain("run.toolName === null");
    expect(hostSrc).toContain("startedRunsForResumeTurnRecovery");
    expect(hostSrc).toContain("startedRunsForChatRecovery");
    expect(hostSrc).toContain("isChatTurnKey");
    expect(hostSrc).toContain("isResumeTurnKey");
    expect(hostSrc).toContain("hasUnfinishedResumeTurn");
    expect(hostSrc).toContain("pinned.speech");
    expect(hostSrc).toContain("hostModelMessages");
    expect(hostSrc).toContain("recoverStartedExecutionIds");
    expect(hostSrc).toContain("unfinishedStartedRuns");
    expect(hostSrc).toContain("includeTurnKeys");
    expect(hostSrc).not.toContain("isChatTurnAssistantMessage");
  });

  it("does not GETDEL in the pending Redis scripts (core owns confirmation consume)", () => {
    const redisSrc = readFileSync(join(here, "../stores/redis.ts"), "utf8");
    const pendingOpen = redisSrc.slice(
      redisSrc.indexOf("const PENDING_OPEN_LUA"),
      redisSrc.indexOf("const CONVERSATION_LOCK_RELEASE_LUA"),
    );
    expect(pendingOpen).toContain("PENDING_CLAIM_LUA");
    expect(pendingOpen).toContain("PENDING_ABANDON_LUA");
    expect(pendingOpen).not.toContain("GETDEL");
    expect(PENDING_REPLACE_TOOL_NAME).toBe("pending_replace");
    expect(redisSrc).toContain("CONVERSATION_LOCK_RENEW_LUA");
    expect(redisSrc).toContain("redisSetNxSucceeded");
  });
});
