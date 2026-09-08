import { describe, expect, it } from "vitest";

import {
  chatTurnKey,
  isChatTurnKey,
  isResumeTurnKey,
  phaseATurnKey,
  resumeTurnKey,
} from "./turn-key.js";

const userMessageId = "11111111-1111-4111-8111-111111111111";
const pendingId = "22222222-2222-4222-8222-222222222222";

describe("assistant turnKey identity", () => {
  it("classifies chat, resume, and unknown origins without neighbor heuristics", () => {
    expect(chatTurnKey(userMessageId)).toBe(`begin:${userMessageId}`);
    expect(resumeTurnKey(pendingId)).toBe(`begin:resume:${pendingId}`);
    expect(phaseATurnKey(pendingId)).toBe(`begin:phase-a:${pendingId}`);
    expect(isChatTurnKey(chatTurnKey(userMessageId))).toBe(true);
    expect(isChatTurnKey(resumeTurnKey(pendingId))).toBe(false);
    expect(isChatTurnKey(phaseATurnKey(pendingId))).toBe(false);
    expect(isChatTurnKey(`begin:replace:${pendingId}:1`)).toBe(false);
    expect(isChatTurnKey(`begin:successor:${pendingId}`)).toBe(false);
    expect(isChatTurnKey(`begin:seed:${pendingId}`)).toBe(false);
    expect(isChatTurnKey(null)).toBe(false);
    expect(isChatTurnKey(undefined)).toBe(false);
    expect(isResumeTurnKey(resumeTurnKey(pendingId))).toBe(true);
    expect(isResumeTurnKey(chatTurnKey(userMessageId))).toBe(false);
    expect(isResumeTurnKey(null)).toBe(false);
  });
});
