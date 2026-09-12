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
import { chatCursorSchema, type ChatWindow } from "@showzy/assistant-kit";
import type { Context } from "hono";
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
  type AssistantKitAppEnv,
  type AssistantKitRuntime,
} from "./assistant-kit-http.js";

export const ASSISTANT_KIT_CHAT_PATH = "/assistant/kit/chat";
export const ASSISTANT_KIT_MESSAGES_PATH = "/assistant/kit/messages";

/** No `messages[]`. The server owns what the model is told. */
export const assistantKitChatBodySchema = z.strictObject({
  commandId: z.uuid(),
  conversationId: z.uuid(),
  text: z.string().min(1).max(4000),
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
  readonly window: ChatWindow;
}

/**
 * The turn is stored and queued. The window already ends in the placeholder the
 * worker writes into, so a client renders the thread correctly without knowing
 * anything about the queue.
 */
export interface AssistantKitTurnAccepted {
  readonly status: "accepted";
  readonly window: ChatWindow;
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
  const { kit, history, turns } = runtime.forCaller({
    userId: caller.userId,
    companySelector: caller.companySelector,
    requestId,
    clientIp: c.get("clientIp"),
  });
  const scope = { conversationId: body.conversationId, bind: caller.bind };
  const accepted = async (): Promise<Response> =>
    json(
      202,
      { status: "accepted", window: await kit.messages.read(scope) },
      requestId,
    );

  // An unanswered question blocks a new job rather than being superseded by it.
  // A visible limitation is better than a draft that silently disappears.
  const open = await kit.peek(scope);
  if (open !== null) {
    return json(
      409,
      {
        status: "interaction_open",
        window: await kit.messages.read(scope),
      },
      requestId,
    );
  }

  // Past every refusal, so a command is only spent by a request that is about
  // to do something. A retry of a send whose reply was lost lands here and is
  // answered with the conversation as it now stands — including the order the
  // first attempt's turn created (SHO-547).
  const command = {
    route: "chat" as const,
    bind: caller.bind,
    conversationId: body.conversationId,
    commandId: body.commandId,
  };
  if (!(await takeCommand(runtime, command))) {
    return await accepted();
  }

  // Read before the accept and saved after it: the worker runs the turn from
  // this history, and it must not be written until the lease is claimed.
  const priorMessages = await history.load(scope);
  const budget = requireBudgetTicket(c);

  const result = await turns.accept({
    kind: "chat",
    conversationId: body.conversationId,
    commandId: body.commandId,
    text: body.text,
    bind: caller.bind,
    sessionId: caller.sessionId,
    budgetHold: budget.hold,
    releaseUnusedHold: () => budget.release(),
  });

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
      { status: "turn_open", window: await kit.messages.read(scope) },
      requestId,
    );
  }
  if (result.outcome === "wrong_owner") {
    // The conversation id exists and belongs to someone else. Same answer as a
    // conversation that does not exist.
    return goneResponse(requestId);
  }

  if (result.outcome === "accepted") {
    // The row holds the reservation from here; the worker or the reconciler
    // settles it.
    budget.keep();
    await enqueueAcceptedTurn(runtime, result.job, requestId);
    // Only now. Saving before the accept claimed the lease could overwrite a
    // still-running turn's history, and a `busy` accept must mean nothing was
    // written (ADR-0039, amended by the SHO-569 decision).
    await history.save(scope, [
      ...priorMessages,
      { role: "user" as const, content: body.text },
    ]);
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
  const { kit } = runtime.forCaller({
    userId: caller.userId,
    companySelector: caller.companySelector,
    requestId,
    clientIp: c.get("clientIp"),
  });
  const window = await kit.messages.read(
    {
      conversationId: conversationId.data.toLowerCase(),
      bind: caller.bind,
    },
    before === undefined ? {} : { before },
  );

  return json(200, { status: "ok", window }, requestId);
}
