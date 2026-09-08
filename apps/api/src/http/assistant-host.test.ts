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

describe("unpublished staff-assistant host (SHO-522)", () => {
  it("is not mounted on production createApp", () => {
    const appSrc = readFileSync(join(here, "app.ts"), "utf8");
    expect(appSrc).not.toContain("ASSISTANT_CONFIRM_PATH");
    expect(appSrc).not.toContain("ASSISTANT_HOST_CHAT_PATH");
    expect(appSrc).not.toContain("ASSISTANT_PENDING_ABANDON_PATH");
    expect(appSrc).not.toContain('"/assistant/confirm"');
    expect(appSrc).not.toContain('"/assistant/pending/abandon"');
    expect(appSrc).not.toContain('"/assistant/host/chat"');
    expect(appSrc).toContain("ASSISTANT_CHAT_PATH");
    expect(appSrc).toContain("ASSISTANT_CHOICE_PATH");
  });

  it("exposes confirm, abandon, pending GET, and host chat as HTTP paths", () => {
    expect(ASSISTANT_CONFIRM_PATH).toBe("/assistant/confirm");
    expect(ASSISTANT_PENDING_ABANDON_PATH).toBe("/assistant/pending/abandon");
    expect(ASSISTANT_PENDING_PATH).toBe("/assistant/pending");
    expect(ASSISTANT_HOST_CHAT_PATH).toBe("/assistant/host/chat");
    expect(ASSISTANT_HOST_CHOICE_PATH).toBe("/assistant/choice");
    const hostSrc = readFileSync(join(here, "assistant-host.ts"), "utf8");
    expect(hostSrc).toContain("createStaffAssistantHostApp");
    expect(hostSrc).not.toMatch(/implementAction\s*\(/);
    expect(hostSrc).not.toMatch(/defineActionContract\s*\(/);
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
  });
});
