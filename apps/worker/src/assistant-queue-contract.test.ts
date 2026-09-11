/**
 * The assistant queue contract lives in `@showzy/assistant-runtime` because the
 * API produces into it and the worker consumes it (ADR-0039). The prefix is a
 * fact both that package and this job host state; this pins them together so
 * the assistant queue cannot drift out of the namespace every other queue of
 * this host uses.
 */
import {
  ASSISTANT_QUEUE_NAME,
  ASSISTANT_QUEUE_PREFIX,
} from "@showzy/assistant-runtime";
import { describe, expect, it } from "vitest";

import {
  BULLMQ_PREFIX,
  MAINTENANCE_QUEUE_NAME,
  PDF_QUEUE_NAME,
} from "./policy.js";

describe("assistant queue contract against the job host", () => {
  it("puts the assistant queue under the job host's BullMQ prefix", () => {
    expect(ASSISTANT_QUEUE_PREFIX).toBe(BULLMQ_PREFIX);
  });

  it("does not reuse a queue name the job host already owns", () => {
    expect([MAINTENANCE_QUEUE_NAME, PDF_QUEUE_NAME]).not.toContain(
      ASSISTANT_QUEUE_NAME,
    );
  });
});
