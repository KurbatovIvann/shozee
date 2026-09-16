import { defineJob, jobField, jobPayload } from "@showzy/core";
import { describe, expect, it } from "vitest";

import {
  attemptExpiryMarginSeconds,
  queueDeclarations,
  runnerRetentionSeconds,
} from "./queue-provisioning.js";

const payload = jobPayload({ turnId: jobField.uuid() });

const runTurn = defineJob({
  name: "assistant.runTurn",
  scope: "tenant",
  payload,
  discriminator: [],
  lifecycle: "expires",
  onExhausted: "assistant.interruptTurn",
  retries: 1,
  attemptTimeoutMs: 90_500,
  concurrency: 2,
});

const cleanup = defineJob({
  name: "files.sweepUploads",
  scope: "global",
  payload: jobPayload({}),
  discriminator: [],
  lifecycle: "periodic",
  cron: "*/5 * * * *",
  retries: 0,
  attemptTimeoutMs: 60_000,
  concurrency: 1,
});

const unchanging = {
  policy: "standard",
  partition: false,
  notify: false,
  retryDelay: 0,
  retryBackoff: false,
  retryDelayMax: null,
  retentionSeconds: runnerRetentionSeconds,
  deleteAfterSeconds: runnerRetentionSeconds,
  heartbeatSeconds: null,
};

describe("queueDeclarations", () => {
  it("gives an expires job its own queue and a dead letter provisioned first", () => {
    expect(queueDeclarations([runTurn])).toEqual([
      {
        name: "assistant.runTurn.exhausted",
        settings: {
          ...unchanging,
          retryLimit: 0,
          expireInSeconds: 96,
          deadLetter: null,
        },
      },
      {
        name: "assistant.runTurn",
        settings: {
          ...unchanging,
          retryLimit: 1,
          expireInSeconds: 96,
          deadLetter: "assistant.runTurn.exhausted",
        },
      },
    ]);
  });

  it("gives a periodic job one queue without a dead letter", () => {
    expect(queueDeclarations([cleanup])).toEqual([
      {
        name: "files.sweepUploads",
        settings: {
          ...unchanging,
          retryLimit: 0,
          expireInSeconds: 65,
          deadLetter: null,
        },
      },
    ]);
  });

  it("expires a whole-second attempt a fixed margin after its in-process timeout", () => {
    const [queue] = queueDeclarations([cleanup]);
    expect(attemptExpiryMarginSeconds).toBeGreaterThan(0);
    expect(queue?.settings.expireInSeconds).toBe(
      cleanup.attemptTimeoutMs / 1000 + attemptExpiryMarginSeconds,
    );
  });
});
