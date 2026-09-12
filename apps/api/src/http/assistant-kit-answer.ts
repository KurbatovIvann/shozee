/**
 * The two ways an open question closes.
 *
 * `POST /assistant/kit/answer` — a person answered it.
 * `POST /assistant/kit/abandon` — a person dropped it.
 *
 * One answer route, not one per kind. The body carries an `interactionId` and
 * an opaque `answer`; which kind that is, and what a valid answer to it looks
 * like, is read from the stored pause and checked by that kind's own schema. A
 * second kind therefore needs no second endpoint, and a client needs no
 * per-kind URL.
 *
 * What these handlers own, and nothing more: who is asking, which tenant they
 * are in, and dispatching what the interaction resolved to a domain action.
 * Claim once, refuse a stale revision, replay the continuation — all of that
 * belongs to `@showzy/assistant-kit`, and which kinds exist belongs to
 * `assistant-interactions.ts`.
 *
 * **An answer keeps its synchronous half (ADR-0039, SHO-563).** The pause is
 * claimed and the resolved action runs inside the request, exactly as before,
 * so `stale`, `unresolvable`, `action_failed` and a second question are still
 * immediate. What the action earned — its card — is stored on the placeholder
 * by the accept, before any generation is attempted, so a provider failure
 * cannot take a committed write down with the explanation (SHO-546). Only the
 * reply runs off the request.
 *
 * The order is the protocol, and it is the reverse of what ADR-0039 first
 * wrote: **claim, run the action, accept, then save the history.** Saving
 * history before the accept has claimed the lease could overwrite a
 * still-running turn's history, and a `busy` accept must mean nothing was
 * written. An accept refused as `busy` gives the claim back, so the card stays
 * answerable.
 */
import { interactionResponseSchema } from "@showzy/assistant-kit";
import {
  acceptProvedRollback,
  assistantTurnEarnedCard,
} from "@showzy/assistant-runtime";
import type { Context } from "hono";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  canonicalCommandIds,
  enqueueAcceptedTurn,
  goneResponse,
  json,
  readJson,
  requireBudgetTicket,
  requireCaller,
  takeCommand,
  toolContext,
  type AssistantKitAppEnv,
  type AssistantKitRuntime,
} from "./assistant-kit-http.js";

export const ASSISTANT_KIT_ANSWER_PATH = "/assistant/kit/answer";
export const ASSISTANT_KIT_ABANDON_PATH = "/assistant/kit/abandon";

export const assistantKitAbandonBodySchema = z.strictObject({
  conversationId: z.uuid(),
  interactionId: z.uuid(),
});

/**
 * Drop an open question without answering it.
 *
 * Not decoration: one open question blocks the next job, so without a way to
 * drop one a conversation whose question no longer makes sense is stuck until
 * the pause expires. That is the shape of the defect this path was built to
 * remove, so the way out is a route rather than a client-side hide.
 *
 * No revision is sent. Abandoning is not an answer to a particular version of
 * the question — whichever version is open, the person is done with it.
 *
 * The `interaction` part stays in its message. The record of having been asked
 * is part of the conversation; only the ability to answer goes away.
 */
export async function handleAssistantKitAbandon(
  c: Context<AssistantKitAppEnv>,
  runtime: AssistantKitRuntime,
): Promise<Response> {
  const requestId = c.get("requestId");
  const caller = await requireCaller(c, runtime);
  if (!caller.ok) {
    return caller.response;
  }

  const raw = await readJson(c);
  if (!raw.ok) {
    return json(400, { error: { code: "VALIDATION" } }, requestId);
  }
  const parsed = assistantKitAbandonBodySchema.safeParse(raw.body);
  if (!parsed.success) {
    return json(400, { error: { code: "VALIDATION" } }, requestId);
  }
  const conversationId = parsed.data.conversationId.toLowerCase();

  const { kit } = runtime.forCaller({
    userId: caller.userId,
    companySelector: caller.companySelector,
    requestId,
    clientIp: c.get("clientIp"),
  });
  const dropped = await kit.abandon({
    conversationId,
    bind: caller.bind,
    interactionId: parsed.data.interactionId,
  });

  // Already gone answers the same as just cancelled: the caller wanted no open
  // question, and there is none. A second tap is not an error.
  void dropped;

  // With the window, like every other answer. Without it the card kept
  // rendering on a client that had just cancelled it, and the conversation
  // locked: the next tap hit a pause the server had dropped, and the next
  // message was refused because the client was still posting against it.
  return json(
    200,
    {
      status: "abandoned",
      window: await kit.messages.read({
        conversationId,
        bind: caller.bind,
      }),
    },
    requestId,
  );
}

export async function handleAssistantKitAnswer(
  c: Context<AssistantKitAppEnv>,
  runtime: AssistantKitRuntime,
): Promise<Response> {
  const requestId = c.get("requestId");
  const caller = await requireCaller(c, runtime);
  if (!caller.ok) {
    return caller.response;
  }

  const raw = await readJson(c);
  if (!raw.ok) {
    return json(400, { error: { code: "VALIDATION" } }, requestId);
  }
  const parsed = interactionResponseSchema.safeParse(raw.body);
  if (!parsed.success) {
    return json(400, { error: { code: "VALIDATION" } }, requestId);
  }
  // Before the receipt, the idempotency key, the turn row and its message ids.
  const body = canonicalCommandIds(parsed.data);
  const { kit, history, turns } = runtime.forCaller({
    userId: caller.userId,
    companySelector: caller.companySelector,
    requestId,
    clientIp: c.get("clientIp"),
  });
  const scope = { conversationId: body.conversationId, bind: caller.bind };
  const windowNow = () => kit.messages.read(scope);

  // Before the claim, not after. The claim is exactly-once by design, so a
  // retry that reached it would be told `gone` — the answer *did* take, and the
  // person would be looking at a card that can never be answered (SHO-547).
  const command = {
    route: "answer" as const,
    bind: caller.bind,
    conversationId: body.conversationId,
    commandId: body.commandId,
  };
  /** Nothing durable happened under this command: let the person retry it. */
  const giveBackCommand = () => runtime.commands.release(command);

  // Every outcome below that stores nothing gives the command back, so reaching
  // here means an earlier attempt under this command did something durable —
  // it accepted a turn, or it opened the next question. Answered `ok` with the
  // conversation as it stands, never `accepted`: that would claim a turn is
  // queued, and a client waiting for this turn's `turn.finished` would wait for
  // an event that is never coming (ADR-0039: `202` means stored and queued).
  if (!(await takeCommand(runtime, command))) {
    return json(200, { status: "ok", window: await windowNow() }, requestId);
  }

  const claimed = await kit.claim({
    ...scope,
    interactionId: body.interactionId,
    revision: body.revision,
    answer: body.answer,
  });

  // None of these refusals stored anything, so each gives the command back.
  // Kept, the next attempt under the same command would be answered as a
  // replay of work that never happened.
  switch (claimed.kind) {
    case "gone":
    case "expired":
    case "unknown_kind":
      await giveBackCommand();
      return goneResponse(requestId);
    case "stale":
      // The subject of the decision changed under the card. The window
      // carries the current question, so the picker re-renders as it now is.
      await giveBackCommand();
      return json(
        409,
        { status: "stale", window: await windowNow() },
        requestId,
      );
    case "invalid_answer":
      await giveBackCommand();
      return json(
        400,
        { error: { code: "VALIDATION" }, reason: claimed.reason },
        requestId,
      );
    case "unresolvable":
      // The interaction refused the answer before spending the claim, so the
      // card is still on screen and still answerable.
      await giveBackCommand();
      return json(
        409,
        {
          status: "unresolvable",
          reason: claimed.reason,
          window: await windowNow(),
        },
        requestId,
      );
    default:
      break;
  }

  const release = () =>
    kit.release({ ...scope, interactionId: body.interactionId });

  const context = toolContext(c, caller, {
    conversationId: body.conversationId,
    commandId: body.commandId,
  });
  // One tool set for the request: the resolved call composes its card here, and
  // the reply the worker generates composes into the same message.
  const tools = await runtime.tools(context);

  const resolvedOutcome = await runtime.resolveAnswer({
    toolName: claimed.record.continuation.pausedToolCall.name,
    kind: claimed.record.kind,
    value: claimed.value,
    tools,
    context,
  });

  if (resolvedOutcome.kind === "pause") {
    // The answer settled one ambiguity and uncovered the next — a picker for
    // the customer, then one for the product. A new question, not a failure:
    // the claimed record no longer holds the slot, so this simply takes it.
    // Nothing runs off the request, so no turn is accepted.
    const nextKind = resolvedOutcome.interaction;
    if (!kit.interactions.has(nextKind)) {
      // No second question was opened, so nothing durable came of this command.
      await giveBackCommand();
      return json(
        500,
        { status: "pause_rejected", reason: `unknown kind ${nextKind}` },
        requestId,
      );
    }
    const opened = await kit.open({
      conversationId: body.conversationId,
      bind: caller.bind,
      kind: nextKind,
      prompt: resolvedOutcome.prompt,
      secret: resolvedOutcome.secret,
      continuation: claimed.record.continuation,
    });
    if (opened.kind !== "opened") {
      await giveBackCommand();
      return json(
        500,
        { status: "pause_rejected", reason: opened.kind },
        requestId,
      );
    }
    // From here the second question is open — durable — so the command stays
    // spent whatever follows: a retry must not claim a pause this attempt has
    // already replaced.
    // The transcript has to carry the second question too. Live it is in
    // `openPause`, but a reload reads the messages — and a transcript that shows
    // the first question and not the second is a record of a conversation that
    // did not happen.
    const asked = {
      kind: "interaction" as const,
      interactionId: opened.pause.interactionId,
      revision: opened.pause.revision,
      pause: opened.pause,
    };
    const stored = await kit.messages.write(scope, {
      kind: "append",
      messageId: randomUUID(),
      role: "assistant",
      parts: [asked],
    });
    if (stored.kind === "wrong_owner") {
      return goneResponse(requestId);
    }
    if (stored.kind !== "written") {
      // The second question is open but no message holds it: a reload would
      // show a conversation that did not happen. Fail rather than answer ok
      // (SHO-570).
      return json(500, { error: { code: "INTERNAL" } }, requestId);
    }

    return json(200, { status: "ok", window: await windowNow() }, requestId);
  }

  if (resolvedOutcome.kind === "error") {
    // The action refused. No effect, so the answer did not take: the card stays
    // on screen instead of vanishing with the failure, and the command goes
    // back so the person can answer it again.
    await Promise.all([release(), giveBackCommand()]);
    return json(
      409,
      {
        status: "action_failed",
        code: resolvedOutcome.code,
        message: resolvedOutcome.message,
        window: await windowNow(),
      },
      requestId,
    );
  }

  // The action committed. Its card is stored by the accept, on the placeholder,
  // as the part already earned — before any generation is attempted.
  const budget = requireBudgetTicket(c);
  let result: Awaited<ReturnType<typeof turns.accept>>;
  try {
    result = await turns.accept({
      kind: "answer",
      conversationId: body.conversationId,
      commandId: body.commandId,
      earned: assistantTurnEarnedCard(resolvedOutcome.card),
      bind: caller.bind,
      sessionId: caller.sessionId,
      budgetHold: budget.handOverToAccept(),
      releaseUnusedHold: () => budget.release(),
    });
  } catch (error) {
    // The accept threw with the claim already spent and the action already
    // committed, so the card it earned is stored nowhere. Both the claim and
    // the command go back, or the pause could never be answered again and a
    // committed write would have no explanation anywhere — the silent SHO-546
    // this route exists to prevent, reached through the throw instead of
    // through `busy`.
    //
    // `acceptProvedRollback` is the same predicate the store uses for the
    // budget hold, so claim, command and reservation are all given back on one
    // piece of evidence: nothing was stored. The retry re-runs the action under
    // the same idempotency key, so the write replays rather than repeats
    // (SHO-547).
    //
    // An `INTERNAL` may have committed, so this route keeps both — and that is
    // where it deliberately differs from `/kit/chat`, which gives its command
    // back on any failure. Do not make the two symmetric. A chat accept is its
    // own receipt and a retry of a committed accept is merely `replayed`; this
    // route's guard sits in front of a claim that is exactly-once, so a retry
    // that got past the receipt would be told `gone` and the person would hold
    // a card that can never be answered (SHO-547).
    if (acceptProvedRollback(error)) {
      // Settled, not `all`: a failed give-back must not replace the accept's
      // own error, which is the one worth surfacing. Both still run.
      const released = await Promise.allSettled([release(), giveBackCommand()]);
      for (const outcome of released) {
        if (outcome.status === "rejected") {
          runtime.logger.warn(
            { request_id: requestId, err: outcome.reason },
            "assistant answer could not give back what its accept never used",
          );
        }
      }
    }
    throw error;
  }

  if (result.outcome === "busy") {
    // Another turn took the conversation between the claim and the accept, and
    // nothing was written — including the card this action just earned.
    //
    // The claim **and** the command go back, so the person can answer again.
    // Without the command the retry would replay into a window that holds no
    // card, and a committed write would have no explanation anywhere
    // (SHO-546). With it, the retry runs the same action under the same
    // idempotency key, so the write is replayed rather than repeated and its
    // card is stored by the accept that finally succeeds (SHO-547).
    await Promise.all([release(), giveBackCommand()]);
    return json(
      409,
      { status: "turn_open", window: await windowNow() },
      requestId,
    );
  }
  if (result.outcome === "wrong_owner") {
    await Promise.all([release(), giveBackCommand()]);
    return goneResponse(requestId);
  }

  if (result.outcome === "accepted") {
    budget.keep();
    // The worker runs an answer turn exactly as it runs a chat turn: from
    // history, with no answer-specific seed on the turn row. `resume` replaces
    // the paused call's output with the resolved one — the same payload
    // `continueHostTurn` used to hand the model inside the request. Saved only
    // after the accept claimed the lease, and **before the job exists**, the
    // same order `/kit/chat` keeps: a worker that started between the enqueue
    // and this save would load a transcript still ending in the unanswered
    // paused call, and answer without knowing the action had been performed —
    // re-issuing its tool call, and charged for it.
    await history.save(
      scope,
      kit.resume(claimed, resolvedOutcome.result).messages,
    );
  }

  await enqueueAcceptedTurn(runtime, result.job, requestId);

  return json(
    202,
    { status: "accepted", window: await windowNow() },
    requestId,
  );
}
