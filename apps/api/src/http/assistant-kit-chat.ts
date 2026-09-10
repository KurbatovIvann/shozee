/**
 * `POST /assistant/kit/chat` — a fresh turn.
 * `GET  /assistant/kit/messages` — what to render after a reload.
 *
 * Two things are worth reading here.
 *
 * The request body is `{ conversationId, text }`. A client never sends the
 * model transcript: history is loaded on the server, so a client cannot rewrite
 * what the model was told it did.
 *
 * The reload handler is four lines of work. That is the point — the document is
 * read back as stored, not recomposed from prompt state, so there is no second
 * derivation that can disagree with the live one.
 */
import { randomUUID } from "node:crypto";

import { runHostTurn, type ChatDocument } from "@showzy/assistant-kit";
import type { Context } from "hono";
import { z } from "zod";

import {
  goneResponse,
  json,
  logInterruptedTurn,
  readJson,
  requireCaller,
  takeCommand,
  toolContext,
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
 * Every route answers with the whole stored document, never with just the parts
 * one request produced.
 *
 * A response that carries only the new parts makes the client splice them into
 * what it already has, and a splice is a second derivation of the conversation —
 * the one that used to disagree with what a reload showed. Sending the document
 * costs one Redis read and removes the disagreement by construction: live and
 * reload are literally the same bytes.
 *
 * `openPause` inside it is the open question, so there is no separate `pause`
 * field to keep consistent with it either.
 */
export interface AssistantKitTurnOk {
  readonly status: "ok";
  readonly document: ChatDocument;
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
  const body = parsed.data;
  const { kit, history } = runtime.forCaller({
    userId: caller.userId,
    companySelector: caller.companySelector,
    requestId,
    clientIp: c.get("clientIp"),
  });
  const scope = { conversationId: body.conversationId, bind: caller.bind };

  // An unanswered question blocks a new job rather than being superseded by it.
  // A visible limitation is better than a draft that silently disappears.
  const open = await kit.peek(scope);
  if (open !== null) {
    return json(
      409,
      {
        status: "interaction_open",
        document: await kit.document.read(scope),
      },
      requestId,
    );
  }

  if (c.req.raw.signal.aborted) {
    return json(499, { status: "aborted" }, requestId);
  }

  // Past every refusal and past the abort check, so a command is only spent by
  // a request that is about to do something. A retry of a send whose reply was
  // lost lands here and is answered with the conversation as it now stands —
  // including the order the first attempt created (SHO-547).
  const command = {
    route: "chat" as const,
    bind: caller.bind,
    conversationId: body.conversationId,
    commandId: body.commandId,
  };
  if (!(await takeCommand(c, runtime, command))) {
    return json(
      200,
      { status: "ok", document: await kit.document.read(scope) },
      requestId,
    );
  }

  const priorMessages = await history.load(scope);
  const messages = [
    ...priorMessages,
    { role: "user" as const, content: body.text },
  ];

  // The person's own words go into the document before the model runs, so a
  // failed turn still shows what was asked.
  const userMessageId = randomUUID();
  const stamped = await kit.document.write(scope, {
    kind: "append",
    messageId: userMessageId,
    role: "user",
    parts: [{ kind: "text", text: body.text, status: "complete" }],
  });
  if (stamped.kind === "wrong_owner") {
    // The conversation id exists and belongs to someone else. Same answer as a
    // conversation that does not exist.
    return goneResponse(requestId);
  }

  const tools = await runtime.tools(
    toolContext(c, caller, {
      conversationId: body.conversationId,
      commandId: body.commandId,
    }),
  );

  const prompt = runtime.prompt();
  const turn = await runHostTurn({
    system: prompt.system,
    ...(prompt.providerOptions === undefined
      ? {}
      : { providerOptions: prompt.providerOptions }),
    kit,
    conversationId: body.conversationId,
    bind: caller.bind,
    messageId: randomUUID(),
    model: runtime.model,
    tools,
    messages,
    abortSignal: c.req.raw.signal,
  });

  if (turn.kind === "pause_rejected") {
    // A tool asked for a kind or a payload the registry refused. That is a bug
    // in the tool, not something to hide behind a generic failure.
    return json(
      500,
      { status: "pause_rejected", reason: turn.rejection ?? "unknown" },
      requestId,
    );
  }

  logInterruptedTurn(runtime, {
    requestId,
    turn,
    priorMessages: messages.length,
  });
  await history.save(scope, turn.messages);

  const payload: AssistantKitTurnOk = {
    status: "ok",
    document: await kit.document.read(scope),
  };
  return json(200, payload, requestId);
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

  // Ownership is enforced inside the package: a document belonging to someone
  // else comes back empty, indistinguishable from a conversation that does not
  // exist. No check is needed here, and adding one would only create a way to
  // tell the two apart.
  const { kit } = runtime.forCaller({
    userId: caller.userId,
    companySelector: caller.companySelector,
    requestId,
    clientIp: c.get("clientIp"),
  });
  const document = await kit.document.read({
    conversationId: conversationId.data,
    bind: caller.bind,
  });

  return json(200, { status: "ok", document }, requestId);
}
