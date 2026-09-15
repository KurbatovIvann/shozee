import { defineJob, jobField, jobPayload } from "@showzy/core";
import { describe, expect, it } from "vitest";

import {
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
          expireInSeconds: 91,
          deadLetter: null,
        },
      },
      {
        name: "assistant.runTurn",
        settings: {
          ...unchanging,
          retryLimit: 1,
          expireInSeconds: 91,
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
          expireInSeconds: 60,
          deadLetter: null,
        },
      },
    ]);
  });
});
