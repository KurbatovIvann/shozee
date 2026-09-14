import { assert, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineJob,
  JobDefinitionError,
  type JobDefinition,
} from "./define-job.js";

function expiringJob(): JobDefinition {
  return {
    ...expiringJobWithoutOnExhausted(),
    onExhausted: "assistant.interruptTurn",
  };
}

function expiringJobWithoutOnExhausted(): JobDefinition {
  return {
    name: "assistant.runTurn",
    scope: "tenant",
    payload: z.object({
      turnId: z.uuid(),
      step: z.int(),
      kind: z.enum(["reply", "retry"]),
      version: z.literal(1),
    }),
    discriminator: ["turnId"],
    lifecycle: "expires",
    retries: 0,
    attemptTimeoutMs: 120_000,
  };
}

function periodicJob(): JobDefinition {
  return { ...periodicJobWithoutCron(), cron: "*/15 * * * *" };
}

function periodicJobWithoutCron(): JobDefinition {
  return {
    name: "files.sweepAbandonedUploads",
    scope: "global",
    payload: z.object({}),
    discriminator: [],
    lifecycle: "periodic",
    retries: 2,
    attemptTimeoutMs: 60_000,
  };
}

function problemsOf(definition: JobDefinition): readonly string[] {
  try {
    defineJob(definition);
  } catch (error) {
    if (error instanceof JobDefinitionError) {
      return error.problems;
    }
    throw error;
  }
  return assert.fail("expected the job definition to be rejected");
}

describe("defineJob — valid declarations", () => {
  it("accepts an expiring job with an identity-only payload and freezes it", () => {
    const job = defineJob(expiringJob());
    expect(job.name).toBe("assistant.runTurn");
    expect(job.onExhausted).toBe("assistant.interruptTurn");
    expect(Object.isFrozen(job)).toBe(true);
  });

  it("accepts a periodic job with a cron schedule", () => {
    const job = defineJob(periodicJob());
    expect(job.lifecycle).toBe("periodic");
    expect(job.cron).toBe("*/15 * * * *");
  });
});

describe("defineJob — define-time refusals", () => {
  it("refuses a name that is not <module>.<name>", () => {
    expect(problemsOf({ ...expiringJob(), name: "run-turn" })).toEqual([
      'name "run-turn" must be "<module>.<name>" with camelCase segments (e.g. "assistant.runTurn")',
    ]);
  });

  it.each([
    ["free text", z.string()],
    ["an email", z.email()],
    ["a fractional number", z.number()],
    ["a boolean", z.boolean()],
    ["a nested object", z.object({ id: z.uuid() })],
    ["an optional id", z.uuid().optional()],
  ])("refuses a payload field holding %s (J6)", (_label, schema) => {
    expect(
      problemsOf({
        ...expiringJob(),
        payload: z.object({ turnId: z.uuid(), note: schema }),
      }),
    ).toEqual([
      'payload field "note" must be an id (uuid, guid, ulid, cuid, cuid2, nanoid), an enum or literal, or an integer — payloads are identity only (ADR-0041 J6)',
    ]);
  });

  it("refuses a discriminator that is not a payload field", () => {
    expect(
      problemsOf({
        ...expiringJob(),
        payload: z.object({}),
        discriminator: ["turnId"],
      }),
    ).toEqual(['discriminator "turnId" is not a payload field']);
  });

  it("refuses duplicate discriminator fields", () => {
    expect(
      problemsOf({ ...expiringJob(), discriminator: ["turnId", "turnId"] }),
    ).toEqual(["discriminator must not contain duplicates"]);
  });

  it("refuses a periodic job with an on-exhausted action", () => {
    expect(
      problemsOf({ ...periodicJob(), onExhausted: "files.markAbandoned" }),
    ).toEqual([
      'onExhausted is allowed only on lifecycle "expires" — a periodic run has no owning row',
    ]);
  });

  it("refuses a periodic job without a well-formed cron", () => {
    const expected = [
      'lifecycle "periodic" requires cron, a 5- or 6-field cron expression',
    ];
    expect(problemsOf(periodicJobWithoutCron())).toEqual(expected);
    expect(problemsOf({ ...periodicJob(), cron: "every hour" })).toEqual(
      expected,
    );
  });

  it("refuses an expiring job without an on-exhausted action, or with a cron", () => {
    expect(
      problemsOf({ ...expiringJobWithoutOnExhausted(), cron: "0 * * * *" }),
    ).toEqual([
      'lifecycle "expires" requires onExhausted, the system action that ends the owning row',
      'cron is allowed only on lifecycle "periodic"',
    ]);
  });

  it("refuses an on-exhausted action of another module, or a malformed one", () => {
    expect(
      problemsOf({ ...expiringJob(), onExhausted: "chat.interruptTurn" }),
    ).toEqual([
      'onExhausted "chat.interruptTurn" must belong to this job\'s module "assistant"',
    ]);
    expect(problemsOf({ ...expiringJob(), onExhausted: "interrupt" })).toEqual([
      'onExhausted "interrupt" must be an action name "<module>.<verb>"',
    ]);
  });

  it("refuses negative or fractional retries and a non-positive attempt timeout", () => {
    expect(
      problemsOf({ ...expiringJob(), retries: -1, attemptTimeoutMs: 0 }),
    ).toEqual([
      "retries must be a non-negative integer",
      "attemptTimeoutMs must be a positive integer of milliseconds",
    ]);
    expect(
      problemsOf({ ...expiringJob(), retries: 1.5, attemptTimeoutMs: 10.5 }),
    ).toEqual([
      "retries must be a non-negative integer",
      "attemptTimeoutMs must be a positive integer of milliseconds",
    ]);
  });
});
