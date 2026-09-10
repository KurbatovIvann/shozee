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
 * Ordering is the part worth reading. The write runs before the loop, and its
 * card is stored before generation is attempted, so a provider failure or a
 * disconnect cannot take a committed result down with the explanation.
 */
import { randomUUID } from "node:crypto";

import { continueHostTurn } from "@showzy/assistant-kit";
import { interactionResponseSchema } from "@showzy/assistant-kit";
import type { Context } from "hono";
import { z } from "zod";

import type { AssistantKitTurnOk } from "./assistant-kit-chat.js";
import {
  goneResponse,
  json,
  logInterruptedTurn,
  readJson,
  requireCaller,
  takeCommand,
  toolContext,
  withConversationTurn,
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
 * The `interaction` part stays in the document. The record of having been asked
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

  const { kit } = runtime.forCaller({
    userId: caller.userId,
    companySelector: caller.companySelector,
    requestId,
    clientIp: c.get("clientIp"),
  });
  const dropped = await kit.abandon({
    conversationId: parsed.data.conversationId,
    bind: caller.bind,
    interactionId: parsed.data.interactionId,
  });

  // Already gone answers the same as just cancelled: the caller wanted no open
  // question, and there is none. A second tap is not an error.
  void dropped;

  // With the document, like every other answer. Without it the card kept
  // rendering on a client that had just cancelled it, and the conversation
  // locked: the next tap hit a pause the server had dropped, and the next
  // message was refused because the client was still posting against it.
  return json(
    200,
    {
      status: "abandoned",
      document: await kit.document.read({
        conversationId: parsed.data.conversationId,
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
  const body = parsed.data;
  const { kit, history } = runtime.forCaller({
    userId: caller.userId,
    companySelector: caller.companySelector,
    requestId,
    clientIp: c.get("clientIp"),
  });
  const scope = { conversationId: body.conversationId, bind: caller.bind };

  // The claim, the write it authorises and the turn that follows all touch
  // the document. One turn at a time per conversation (SHO-548).
  return await withConversationTurn(
    runtime,
    kit,
    scope,
    requestId,
    async () => {
      // Before the claim, not after. The claim is exactly-once by design, so a
      // retry that reached it would be told `gone` — the answer *did* take, and the
      // person would be looking at a card that can never be answered (SHO-547).
      const command = {
        route: "answer" as const,
        bind: caller.bind,
        conversationId: body.conversationId,
        commandId: body.commandId,
      };
      // Read through a call, not a property: the signal can flip during the awaits
      // between the two checks, and a direct read lets the compiler narrow the
      // second one to `false` and call it dead.
      const clientGone = (): boolean => c.req.raw.signal.aborted;
      if (clientGone()) {
        // Checked here as well as below, so an already-gone client does not spend a
        // command before anything has been claimed.
        return json(499, { status: "aborted" }, requestId);
      }
      if (!(await takeCommand(c, runtime, command))) {
        return json(
          200,
          { status: "ok", document: await kit.document.read(scope) },
          requestId,
        );
      }

      const claimed = await kit.claim({
        ...scope,
        interactionId: body.interactionId,
        revision: body.revision,
        answer: body.answer,
      });

      switch (claimed.kind) {
        case "gone":
        case "expired":
        case "unknown_kind":
          return goneResponse(requestId);
        case "stale":
          // The subject of the decision changed under the card. The document
          // carries the current question, so the picker re-renders as it now is.
          return json(
            409,
            {
              status: "stale",
              document: await kit.document.read(scope),
            },
            requestId,
          );
        case "invalid_answer":
          return json(
            400,
            { error: { code: "VALIDATION" }, reason: claimed.reason },
            requestId,
          );
        case "unresolvable":
          // The interaction refused the answer before spending the claim, so the
          // card is still on screen and still answerable.
          return json(
            409,
            {
              status: "unresolvable",
              reason: claimed.reason,
              document: await kit.document.read(scope),
            },
            requestId,
          );
        default:
          break;
      }

      const release = () =>
        kit.release({ ...scope, interactionId: body.interactionId });

      if (clientGone()) {
        // The client is already gone. Do not perform the write on its behalf; give
        // the answer back so the card is still there when they return. 499 is the
        // client-closed-request convention.
        //
        // The command goes back with it. A phone whose request timed out in the
        // network sees a transport failure and keeps its `commandId` for the retry;
        // if the receipt stayed taken, that retry would replay a turn that never
        // happened and the tap would be dead for the receipt's whole lifetime.
        await Promise.all([release(), runtime.commands.release(command)]);
        return json(499, { status: "aborted" }, requestId);
      }

      const context = toolContext(c, caller, {
        conversationId: body.conversationId,
        commandId: body.commandId,
      });
      // One tool set for the whole request: the resolved call and the turn that
      // follows it compose their cards together.
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
        const nextKind = resolvedOutcome.interaction;
        if (!kit.interactions.has(nextKind)) {
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
          return json(
            500,
            { status: "pause_rejected", reason: opened.kind },
            requestId,
          );
        }
        // The transcript has to carry the second question too. Live it is in
        // `openPause`, but a reload reads the document — and a document that shows
        // the first question and not the second is a record of a conversation that
        // did not happen.
        const asked = {
          kind: "interaction" as const,
          interactionId: opened.pause.interactionId,
          revision: opened.pause.revision,
          pause: opened.pause,
        };
        await kit.document.write(scope, {
          kind: "append",
          messageId: randomUUID(),
          role: "assistant",
          parts: [asked],
        });

        const payload: AssistantKitTurnOk = {
          status: "ok",
          document: await kit.document.read(scope),
        };
        return json(200, payload, requestId);
      }

      if (resolvedOutcome.kind === "error") {
        // The action refused. No effect, so the answer did not take: the card stays
        // on screen instead of vanishing with the failure.
        await release();
        return json(
          409,
          {
            status: "action_failed",
            code: resolvedOutcome.code,
            message: resolvedOutcome.message,
            document: await kit.document.read(scope),
          },
          requestId,
        );
      }

      const prompt = runtime.prompt();
      const turn = await continueHostTurn({
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
        claimed,
        resolved: resolvedOutcome,
        abortSignal: c.req.raw.signal,
      });

      logInterruptedTurn(runtime, {
        requestId,
        turn,
        // The replayed continuation, which `continueHostTurn` built from the claim.
        priorMessages: claimed.record.continuation.messages.length,
      });
      await history.save(scope, turn.messages);

      const payload: AssistantKitTurnOk = {
        status: "ok",
        document: await kit.document.read(scope),
      };
      return json(200, payload, requestId);
    },
  );
}
