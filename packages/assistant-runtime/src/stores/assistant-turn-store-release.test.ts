/**
 * When a failed accept gives its budget reservation back (SHO-560).
 *
 * A refusal rolls the accept's transaction back, so the reservation is on no
 * row and is released; the database suite in `apps/api` proves busy, replayed,
 * wrong owner, conflict and gone. What it cannot show is the other side: an
 * error that may have followed COMMIT must release nothing.
 */
import { randomUUID } from "node:crypto";

import {
  ConcurrentRetryError,
  ConfirmationRequiredError,
  ConflictError,
  CoreInvariantError,
  IdempotencyConflictError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  TimeoutError,
  ValidationError,
} from "@showzy/core/errors";
import { pino } from "pino";
import { describe, expect, it } from "vitest";

import {
  acceptProvedRollback,
  createPostgresAssistantTurnStore,
} from "./assistant-turn-store.js";
import { AssistantKitConversationGoneError } from "./caller.js";

const caller = {
  userId: "user-1",
  companySelector: "11111111-1111-4111-8111-111111111111",
  requestId: randomUUID(),
  clientIp: "127.0.0.1",
};

/**
 * A pipeline whose database fails the way a lost connection does. Core turns
 * the failure into `INTERNAL`, exactly as it would after a commit whose
 * acknowledgement never arrived.
 */
function failingPipeline() {
  return {
    db: {
      transaction: () => Promise.reject(new Error("connection terminated")),
    },
    logger: pino({ enabled: false }),
  } as never;
}

describe("a failed accept", () => {
  it("releases nothing when core reports an internal error", async () => {
    let released = 0;
    const store = createPostgresAssistantTurnStore(
      { pipeline: failingPipeline() },
      caller,
    );

    const failure = await store
      .accept({
        kind: "chat",
        conversationId: randomUUID(),
        commandId: randomUUID(),
        bind: "owner",
        text: "привіт",
        sessionId: "session-1",
        budgetHold: {
          companyReservedUsd: 0.1,
          globalReservedUsd: 0.1,
          kyivDate: "2026-09-11",
        },
        releaseUnusedHold: () => {
          released += 1;
          return Promise.resolve();
        },
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).toMatchObject({ code: "INTERNAL" });
    expect(released).toBe(0);
  });

  /**
   * The rule the store releases by. Every core code but INTERNAL is raised
   * before the transaction opens or inside one that rolls back — including the
   * deadline and the rate limit, the common failures under load. Only INTERNAL
   * or an unknown error may have followed COMMIT.
   */
  it("proves a rollback for every core refusal except INTERNAL", () => {
    for (const refusal of [
      new NotFoundError(),
      new ConflictError("taken"),
      new ValidationError([]),
      new PermissionDeniedError("no"),
      new TimeoutError(),
      new RateLimitError(60),
      new ConcurrentRetryError(1),
      new IdempotencyConflictError(),
      new ConfirmationRequiredError({
        challengeId: "challenge-1",
        summary: "delete",
        expiresAt: "2026-09-11T10:05:00.000Z",
      }),
      new AssistantKitConversationGoneError(),
    ]) {
      expect(acceptProvedRollback(refusal), refusal.name).toBe(true);
    }

    for (const unknown of [
      new CoreInvariantError("span end failed"),
      new Error("connection terminated"),
      "not even an error",
      undefined,
    ]) {
      expect(acceptProvedRollback(unknown)).toBe(false);
    }
  });
});
