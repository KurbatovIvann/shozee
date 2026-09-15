import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { defineJob } from "../../jobs/define-job.js";
import { jobField, jobPayload } from "../../jobs/job-payload.js";
import { deriveJobId, type JobOrigin } from "./job-identity.js";

const sendReminder = defineJob({
  name: "jobKit.sendReminder",
  scope: "tenant",
  payload: jobPayload({
    reminderId: jobField.uuid(),
    attempt: jobField.integer({ min: 0 }),
  }),
  discriminator: ["reminderId"],
  lifecycle: "expires",
  onExhausted: "jobKit.dropReminder",
  retries: 0,
  attemptTimeoutMs: 1_000,
});

const companyId = randomUUID();
const reminderId = randomUUID();
const origin: JobOrigin = {
  kind: "idempotency",
  principalKey: "system:jobs-test",
  scopeKey: `company:${companyId}`,
  action: "jobKit.note",
  idempotencyKey: "key-1",
};

function idFor(
  overrides: {
    readonly companyId?: string | null;
    readonly origin?: JobOrigin;
    readonly payload?: Readonly<Record<string, unknown>>;
  } = {},
): string {
  return deriveJobId({
    job: sendReminder,
    companyId:
      overrides.companyId === undefined ? companyId : overrides.companyId,
    origin: overrides.origin ?? origin,
    payload: overrides.payload ?? { reminderId, attempt: 0 },
  });
}

describe("deriveJobId", () => {
  it("is a deterministic version-8 UUID of its parts", () => {
    expect(idFor()).toBe(idFor());
    expect(idFor()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("changes with the scope, the origin and the discriminator", () => {
    const ids = new Set([
      idFor(),
      idFor({ companyId: randomUUID() }),
      idFor({ companyId: null }),
      idFor({ origin: { ...origin, idempotencyKey: "key-2" } }),
      idFor({ origin: { kind: "execution", executionId: randomUUID() } }),
      idFor({ payload: { reminderId: randomUUID(), attempt: 0 } }),
    ]);

    expect(ids.size).toBe(6);
  });

  it("ignores payload fields outside the discriminator", () => {
    expect(idFor({ payload: { reminderId, attempt: 3 } })).toBe(idFor());
  });
});
