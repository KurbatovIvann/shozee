import { defineJob, jobField, jobPayload } from "@showzy/core";

import { ASSISTANT_TURN_ATTEMPT_TIMEOUT_MS } from "./actions/turn-record.contract.js";

export const assistantTurnJob = defineJob({
  name: "assistant.turn",
  scope: "tenant",
  payload: jobPayload({
    kind: jobField.enum(["chat", "answer"]),
    conversationId: jobField.uuid(),
    commandId: jobField.uuid(),
  }),
  discriminator: ["kind", "conversationId", "commandId"],
  lifecycle: "expires",
  onExhausted: "assistant.interruptTurn",
  retries: 0,
  attemptTimeoutMs: ASSISTANT_TURN_ATTEMPT_TIMEOUT_MS,
  concurrency: 4,
});

export const assistantSweepOverdueTurnsJob = defineJob({
  name: "assistant.sweepOverdueTurns",
  scope: "global",
  payload: jobPayload({}),
  discriminator: [],
  lifecycle: "periodic",
  cron: "* * * * *",
  retries: 0,
  attemptTimeoutMs: 60_000,
  concurrency: 1,
});

export const assistantJobs = [
  assistantTurnJob,
  assistantSweepOverdueTurnsJob,
] as const;
