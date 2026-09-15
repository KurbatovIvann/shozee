import { assert, describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import type { SystemScope } from "../contract/types.js";
import {
  defineJob,
  JobDefinitionError,
  type JobDefinition,
  type JobScope,
} from "./define-job.js";
import { type JobField, jobField, jobPayload } from "./job-payload.js";

function smuggled(schema: z.ZodType): JobField {
  return schema as JobField;
}

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
    payload: jobPayload({
      turnId: jobField.uuid(),
      step: jobField.integer(),
      kind: jobField.enum(["reply", "retry"]),
      version: jobField.literal("v1"),
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
    payload: jobPayload({}),
    discriminator: [],
    lifecycle: "periodic",
    retries: 2,
    attemptTimeoutMs: 60_000,
  };
}

const anyTextPattern = { abort: false, pattern: /^[\s\S]*$/ };

const neverChecks = { abort: false, when: () => false };

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

  it("accepts bounded integers and a payload that parses only JSON-safe identity", () => {
    const payload = jobPayload({
      turnId: jobField.uuid(),
      attempt: jobField.integer({ min: 0, max: 10 }),
      kind: jobField.enum(["reply", "retry"]),
    });
    const job = defineJob({ ...expiringJob(), payload });
    expect(job.payload).toBe(payload);
    const turnId = "0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b";
    expect(payload.parse({ turnId, attempt: 3, kind: "reply" })).toEqual({
      turnId,
      attempt: 3,
      kind: "reply",
    });
    expect(
      payload.safeParse({ turnId, attempt: 3, kind: "reply", note: "x" })
        .success,
    ).toBe(false);
    expect(
      payload.safeParse({ turnId, attempt: 1.5, kind: "reply" }).success,
    ).toBe(false);
    expect(
      payload.safeParse({ turnId, attempt: 11, kind: "reply" }).success,
    ).toBe(false);
    expect(
      payload.safeParse({
        turnId: "Ivan Petrenko +380501234567",
        attempt: 1,
        kind: "reply",
      }).success,
    ).toBe(false);
  });

  it.each([
    ["a loose object", z.looseObject({ turnId: z.uuid() })],
    ["a catchall object", z.object({ turnId: z.uuid() }).catchall(z.string())],
    [
      "an overwritten object",
      z
        .object({ turnId: z.uuid() })
        .overwrite((payload) => ({ ...payload, turnId: "Ivan +380 secret" })),
    ],
    [
      "a strict object of stock fields",
      z.strictObject({ turnId: z.uuid(), step: z.int() }),
    ],
    [
      "a custom string format",
      z.object({ turnId: z.stringFormat("uuid", () => true) }),
    ],
    [
      "a uuid with a custom pattern",
      z.object({ turnId: z.uuid(anyTextPattern) }),
    ],
    ["a refined uuid", z.object({ turnId: z.uuid().refine(() => true) })],
    ["a uuid that never checks", z.object({ turnId: z.uuid(neverChecks) })],
    ["an int that never checks", z.object({ step: z.int(neverChecks) })],
    [
      "a number int that never checks",
      z.object({ step: z.number().int(neverChecks) }),
    ],
    [
      "a core payload rewritten by overwrite",
      jobPayload({ turnId: jobField.uuid() }).overwrite((payload) => payload),
    ],
    [
      "a core payload rebuilt by extend",
      jobPayload({ turnId: jobField.uuid() }).extend({ note: z.string() }),
    ],
  ])(
    "refuses a payload object that jobPayload did not build: %s (J6)",
    (_label, payload) => {
      expect(
        problemsOf({ ...expiringJob(), payload, discriminator: [] }),
      ).toEqual([
        "payload must be built by jobPayload from jobField constructors — payloads are identity only (ADR-0041 J6)",
      ]);
    },
  );

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
    ["free text", smuggled(z.string())],
    ["a boolean", smuggled(z.boolean())],
    ["a stock uuid", smuggled(z.uuid())],
    ["a uuid that never checks", smuggled(z.uuid(neverChecks))],
    ["an int that never checks", smuggled(z.int(neverChecks))],
    ["a custom string format", smuggled(z.stringFormat("uuid", () => true))],
    ["a uuid with a custom pattern", smuggled(z.uuid(anyTextPattern))],
    ["a nested core payload", smuggled(jobPayload({ id: jobField.uuid() }))],
    ["an optional core uuid", smuggled(jobField.uuid().optional())],
    ["a refined core uuid", jobField.uuid().refine(() => true)],
    [
      "an overwritten core uuid",
      jobField.uuid().overwrite(() => "Ivan +380 secret"),
    ],
    [
      "an overwritten core integer",
      jobField.integer().overwrite((value) => value + 1),
    ],
    [
      "an overwritten core enum",
      jobField.enum(["a", "b"]).overwrite(() => "a"),
    ],
    ["an integer with a fractional bound", jobField.integer({ min: 0.5 })],
    [
      "an integer with an unsafe bound",
      jobField.integer({ max: Number.MAX_VALUE }),
    ],
  ])("refuses a payload field holding %s (J6)", (_label, schema) => {
    expect(
      problemsOf({
        ...expiringJob(),
        payload: jobPayload({ turnId: jobField.uuid(), note: schema }),
      }),
    ).toEqual([
      'payload field "note" must be a jobField (uuid, enum, literal, integer) used as built — payloads are identity only (ADR-0041 J6)',
    ]);
  });

  it("refuses a discriminator that is not a payload field", () => {
    expect(
      problemsOf({
        ...expiringJob(),
        payload: jobPayload({}),
        discriminator: ["turnId"],
      }),
    ).toEqual(['discriminator "turnId" is not a payload field']);
  });

  it("refuses a discriminator naming an inherited property of the shape", () => {
    expect(
      problemsOf({
        ...expiringJob(),
        discriminator: ["turnId", "toString"],
      }),
    ).toEqual(['discriminator "toString" is not a payload field']);
  });

  it("refuses an enum field whose values array lies about its contents", () => {
    const values: [string, ...string[]] = ["reply"];
    values.push(7 as never);
    Object.defineProperty(values, "every", { value: () => true });
    expect(
      problemsOf({
        ...expiringJob(),
        payload: jobPayload({
          turnId: jobField.uuid(),
          kind: jobField.enum(values),
        }),
      }),
    ).toEqual([
      'payload field "kind" must be a jobField (uuid, enum, literal, integer) used as built — payloads are identity only (ADR-0041 J6)',
    ]);
  });

  it("names the job scope by the system scope type", () => {
    expectTypeOf<JobScope>().toEqualTypeOf<SystemScope>();
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

  it.each([
    "a b c d e",
    "60 * * * *",
    "* 24 * * *",
    "* * 0 * *",
    "* * * 13 *",
    "* * * * 8",
    "*/0 * * * *",
    "10-5 * * * *",
    "1,,2 * * * *",
    "* * * FOO *",
    "60 * * * * *",
  ])("refuses the malformed cron %s", (cron) => {
    expect(problemsOf({ ...periodicJob(), cron })).toEqual([
      'lifecycle "periodic" requires cron, a 5- or 6-field cron expression',
    ]);
  });

  it.each([
    "0 3 * * *",
    "*/15 0-6,18-23 1 jan-DEC MON-FRI",
    "0 0 1,15 * 0/2",
    "30 */5 * * * *",
  ])("accepts the cron %s", (cron) => {
    expect(defineJob({ ...periodicJob(), cron }).cron).toBe(cron);
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
