/**
 * `POST /assistant/kit/chat` — a fresh turn.
 * `GET  /assistant/kit/messages` — what to render after a reload, or the page
 * before a cursor an earlier answer returned.
 *
 * Three things are worth reading here.
 *
 * The request body is `{ conversationId, text }`. A client never sends the
 * model transcript: history is loaded on the server, so a client cannot rewrite
 * what the model was told it did.
 *
 * **The route accepts a turn; it does not run one (ADR-0039, SHO-563).** In one
 * Postgres transaction the accept claims the conversation, stores the person's
 * message and stores an assistant placeholder; the job goes on the queue and
 * the answer is `202` with the window those two messages are already in. A turn
 * therefore outlives the request that asked for it — locking the screen or
 * closing the app is not a cancel — and nothing here reads the request signal.
 *
 * The reload handler does almost nothing. That is the point — each message is
 * read back as stored, not recomposed from prompt state, so there is no second
 * derivation that can disagree with the live one.
 */
import { chatCursorSchema, type PublicPause } from "@showzy/assistant-kit";
import {
  assistantRejectedTrace,
  assistantSupersededTrace,
  assistantTurnMessageId,
  matchAssistantPauseAnswer,
  readAssistantChatWindow,
  shoEscalatedAskedMessage,
  shoMayReadCard,
  type AssistantChatWindowWithTurn,
} from "@showzy/assistant-runtime";
import type { Context } from "hono";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  appendChatText,
  dropOpenPause,
  handleAssistantKitAnswer,
  type PauseWriteOutcome,
} from "./assistant-kit-answer.js";
import {
  canonicalAssistantId,
  canonicalCommandIds,
  goneResponse,
  json,
  readJson,
  requireBudgetTicket,
  requireCaller,
  requireVerifiedCompany,
  requireOpenCardRead,
  takeCommand,
  type AssistantKitAppEnv,
  type AssistantKitCardVerdict,
  type AssistantKitOpenCard,
  type AssistantKitRuntime,
  type Caller,
} from "./assistant-kit-http.js";
import { shoCardAnswerTurn, shoChatTurn } from "./assistant-kit-sho.js";

export async function readChatOpenCard(
  c: Context<AssistantKitAppEnv>,
  runtime: AssistantKitRuntime,
  caller: Extract<Caller, { readonly ok: true }>,
): Promise<boolean> {
  const raw = await readJson(c);
  const parsed = assistantKitChatBodySchema.safeParse(raw.ok ? raw.body : null);
  if (!parsed.success) {
    c.set("assistantOpenCard", null);
    return false;
  }
  const body = canonicalCommandIds(parsed.data);
  const { kit } = runtime.forCaller({
    userId: caller.userId,
    companySelector: caller.companySelector,
    requestId: c.get("requestId"),
    clientIp: c.get("clientIp"),
  });
  const pause = await kit.peek({
    conversationId: body.conversationId,
    bind: caller.bind,
  });
  const card: AssistantKitOpenCard | null =
    pause === null
      ? body.answering === undefined
        ? null
        : { pause: null, verdict: { kind: "stale" } }
      : { pause, verdict: verdictFor(pause, body.answering, body.text) };
  c.set("assistantOpenCard", card);
  return (
    card !== null &&
    (card.verdict.kind === "answer" || card.verdict.kind === "decline")
  );
}

function verdictFor(
  pause: PublicPause,
  answering:
    { readonly interactionId: string; readonly revision: number } | undefined,
  text: string,
): AssistantKitCardVerdict {
  if (answering === undefined) {
    return { kind: "supersede" };
  }
  return answering.interactionId !== pause.interactionId ||
    answering.revision !== pause.revision
    ? { kind: "stale" }
    : matchAssistantPauseAnswer(pause, text);
}

export const ASSISTANT_KIT_CHAT_PATH = "/assistant/kit/chat";
export const ASSISTANT_KIT_MESSAGES_PATH = "/assistant/kit/messages";

/** No `messages[]`. The server owns what the model is told. */
export const assistantKitChatBodySchema = z.strictObject({
  commandId: z.uuid(),
  conversationId: z.uuid(),
  text: z.string().min(1).max(4000),
  answering: z
    .strictObject({
      interactionId: z.uuid(),
      revision: z.number().int().positive(),
    })
    .optional(),
});

/**
 * Every route answers with the conversation as it now stands — its latest
 * window — never with just the parts one request produced.
 *
 * A response that carries only the new parts makes the client splice them into
 * what it already has, and a splice is a second derivation of the conversation —
 * the one that used to disagree with what a reload showed. A window is not that:
 * it is the same bytes a reload of the latest page returns, and everything
 * before it is immutable, so a copy a client already holds cannot go stale. A
 * year of messages is not carried on every answer (SHO-555).
 *
 * `openPause` inside it is the open question, so there is no separate `pause`
 * field to keep consistent with it either.
 */
export interface AssistantKitTurnOk {
  readonly status: "ok";
  readonly window: AssistantChatWindowWithTurn;
}

/**
 * The turn is stored and queued. The window already ends in the placeholder the
 * worker writes into, so a client renders the thread correctly without knowing
 * anything about the queue.
 */
export interface AssistantKitTurnAccepted {
  readonly status: "accepted";
  readonly window: AssistantChatWindowWithTurn;
}

export async function handleAssistantKitChat(
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
  const parsed = assistantKitChatBodySchema.safeParse(raw.body);
  if (!parsed.success) {
    return json(400, { error: { code: "VALIDATION" } }, requestId);
  }
  // Before the receipt, the idempotency key, the turn row and its message ids.
  const body = canonicalCommandIds(parsed.data);
  const { kit, turns, history } = runtime.forCaller({
    userId: caller.userId,
    companySelector: caller.companySelector,
    requestId,
    clientIp: c.get("clientIp"),
  });
  const scope = { conversationId: body.conversationId, bind: caller.bind };
  const accepted = async (): Promise<Response> =>
    json(
      202,
      {
        status: "accepted",
        window: await readAssistantChatWindow(kit, turns, scope),
      },
      requestId,
    );

  const command = {
    route: "chat" as const,
    bind: caller.bind,
    conversationId: body.conversationId,
    commandId: body.commandId,
  };

  const finishing = { ...command, route: "answer" as const };
  const settled = async (): Promise<Response> =>
    json(
      200,
      {
        status: "ok",
        window: await readAssistantChatWindow(kit, turns, scope),
      },
      requestId,
    );
  const writeFailed = async (outcome: PauseWriteOutcome): Promise<Response> => {
    await runtime.commands.release(finishing);
    return outcome === "wrong_owner"
      ? goneResponse(requestId)
      : json(500, { error: { code: "INTERNAL" } }, requestId);
  };

  if (await runtime.commands.spent(command)) {
    return await accepted();
  }

  const card = requireOpenCardRead(c);
  const open = card === null ? null : card.pause;
  const read = card === null ? null : card.verdict;
  if (read !== null && read.kind === "stale") {
    if (await runtime.commands.spent(finishing)) {
      return await settled();
    }
    return json(
      409,
      {
        status: "stale",
        window: await readAssistantChatWindow(kit, turns, scope),
      },
      requestId,
    );
  }
  const bySho =
    open === null ||
    body.answering === undefined ||
    read === null ||
    !shoMayReadCard(read)
      ? null
      : await shoCardAnswerTurn({
          runtime,
          caller,
          verifiedCompanyId: requireVerifiedCompany(c),
          history,
          scope,
          pause: open,
          requestId,
          clientIp: c.get("clientIp"),
          text: body.text,
        });
  const matched = bySho ?? read;
  if (open !== null && matched !== null && matched.kind !== "supersede") {
    if (matched.kind === "answer") {
      return await handleAssistantKitAnswer(c, runtime, {
        caller,
        askedText: body.text,
        body: {
          commandId: body.commandId,
          conversationId: body.conversationId,
          interactionId: open.interactionId,
          revision: open.revision,
          answer: matched.answer,
        },
      });
    }
    if (!(await takeCommand(runtime, finishing))) {
      return await settled();
    }
    const asked = await appendChatText(kit, scope, {
      role: "user",
      messageId: assistantTurnMessageId(
        { kind: "answer", commandId: body.commandId },
        "user",
      ),
      text: body.text,
    });
    if (asked !== "ok") {
      return await writeFailed(asked);
    }
    if (matched.kind === "decline") {
      const declined = await dropOpenPause(
        kit,
        scope,
        open.interactionId,
        assistantRejectedTrace,
      );
      if (declined === "answer_in_flight") {
        await runtime.commands.release(finishing);
        return await settled();
      }
      if (declined !== "ok") {
        return await writeFailed(declined);
      }
      return json(
        200,
        {
          status: "abandoned",
          window: await readAssistantChatWindow(kit, turns, scope),
        },
        requestId,
      );
    }
    const hinted = await appendChatText(kit, scope, {
      role: "assistant",
      messageId: randomUUID(),
      text: matched.hint,
    });
    return hinted === "ok" ? await settled() : await writeFailed(hinted);
  }

  if (await runtime.commands.spent(finishing)) {
    return await settled();
  }
  if (!(await takeCommand(runtime, command))) {
    return await accepted();
  }

  const byShoChat =
    open === null
      ? await shoChatTurn({
          runtime,
          caller,
          verifiedCompanyId: requireVerifiedCompany(c),
          kit,
          turns,
          history,
          scope,
          command,
          requestId,
          clientIp: c.get("clientIp"),
          text: body.text,
        })
      : null;
  if (byShoChat?.kind === "answered") {
    return byShoChat.response;
  }
  const escalation =
    byShoChat?.kind === "escalate" ? byShoChat.escalation : undefined;

  const budget = requireBudgetTicket(c);

  let result: Awaited<ReturnType<typeof turns.accept>>;
  try {
    result = await turns.accept({
      kind: "chat",
      conversationId: body.conversationId,
      commandId: body.commandId,
      text: body.text,
      ...(open === null ? {} : { earned: [assistantSupersededTrace(open)] }),
      ...(escalation === undefined
        ? {}
        : {
            askedMessage: shoEscalatedAskedMessage(body.text, escalation),
          }),
      bind: caller.bind,
      sessionId: caller.sessionId,
      budgetHold: budget.handOverToAccept(),
      releaseUnusedHold: () => budget.release(),
    });
  } catch (error) {
    // The command goes back on **any** failure here, including one that may
    // have committed.
    //
    // This is deliberately not what `/kit/answer` does, and the asymmetry is
    // the point — do not "fix" the two routes into agreement. A chat accept is
    // its own receipt: it is keyed by (kind, conversation, command), so a retry
    // of a first attempt that did commit comes back `replayed`, writes nothing
    // twice and simply re-enqueues the job. There is no double-run to protect
    // against, so keeping the receipt buys nothing and costs everything — the
    // retry never reaches the accept at all, because `takeCommand` above turns
    // it into `202 accepted` with a window the person's own message is not in,
    // for the receipt's full lifetime. An `INTERNAL` raised *before* COMMIT is
    // at least as likely as one after it, and that one silently drops the
    // message.
    //
    // The budget hold is the opposite case and is handled in the wrapper: a
    // reservation a committed row may hold must not be given back, or the
    // counter drops below real spend and the day's cap lifts.
    const released = await Promise.allSettled([
      runtime.commands.release(command),
    ]);
    for (const outcome of released) {
      if (outcome.status === "rejected") {
        // Logged, never rethrown: the accept's own error is the one worth
        // surfacing, and a lost receipt heals on its own TTL.
        runtime.logger.warn(
          { request_id: requestId, err: outcome.reason },
          "assistant command could not be given back after a failed accept",
        );
      }
    }
    throw error;
  }

  if (result.outcome === "busy") {
    // Another turn holds the conversation and nothing was written. One turn at
    // a time, or two of them interleave their messages (SHO-548).
    //
    // The command goes back: this request stored nothing, and a receipt kept
    // for a send that never happened would answer the person's retry with a
    // window their message is not in — a tap that does nothing, silently, for
    // the receipt's whole lifetime.
    await runtime.commands.release(command);
    return json(
      409,
      {
        status: "turn_open",
        window: await readAssistantChatWindow(kit, turns, scope),
      },
      requestId,
    );
  }
  if (result.outcome === "wrong_owner") {
    // The conversation id exists and belongs to someone else. Same answer as a
    // conversation that does not exist — and nothing was stored, so the command
    // goes back rather than answering a retry `202` with an empty window.
    await runtime.commands.release(command);
    return goneResponse(requestId);
  }

  if (result.outcome === "accepted") {
    budget.keep();
  }

  if (open !== null) {
    await kit.abandon({ ...scope, interactionId: open.interactionId });
  }

  return await accepted();
}

export async function handleAssistantKitMessages(
  c: Context<AssistantKitAppEnv>,
  runtime: AssistantKitRuntime,
): Promise<Response> {
  const requestId = c.get("requestId");
  const caller = await requireCaller(c, runtime);
  if (!caller.ok) {
    return caller.response;
  }

  const conversationId = z
    .uuid()
    .safeParse(c.req.query("conversationId") ?? "");
  if (!conversationId.success) {
    return json(400, { error: { code: "VALIDATION" } }, requestId);
  }
  // Only a cursor this path could have issued. The kit would throw on anything
  // else, and a client gets a 400 for a malformed query, not a 500.
  const before = c.req.query("before");
  if (before !== undefined && !chatCursorSchema.safeParse(before).success) {
    return json(400, { error: { code: "VALIDATION" } }, requestId);
  }

  // Ownership is enforced inside the package: messages belonging to someone
  // else comes back empty, indistinguishable from a conversation that does not
  // exist. No check is needed here, and adding one would only create a way to
  // tell the two apart.
  const { kit, turns } = runtime.forCaller({
    userId: caller.userId,
    companySelector: caller.companySelector,
    requestId,
    clientIp: c.get("clientIp"),
  });
  const window = await readAssistantChatWindow(
    kit,
    turns,
    {
      conversationId: canonicalAssistantId(conversationId.data),
      bind: caller.bind,
    },
    before === undefined ? {} : { before },
  );

  return json(200, { status: "ok", window }, requestId);
}
