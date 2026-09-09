/**
 * `POST /assistant/kit/choice` — answering an open interaction.
 *
 * What this handler owns, and nothing more: who is asking, which tenant they
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

import type { AssistantKitTurnOk } from "./assistant-kit-chat.js";
import {
  goneResponse,
  json,
  readJson,
  requireCaller,
  toolContext,
  type AssistantKitAppEnv,
  type AssistantKitRuntime,
} from "./assistant-kit-http.js";

export const ASSISTANT_KIT_CHOICE_PATH = "/assistant/kit/choice";

export async function handleAssistantKitChoice(
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
  const scope = { conversationId: body.conversationId, bind: caller.bind };

  const claimed = await runtime.kit.claim({
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
      return json(409, { status: "stale", pause: claimed.current }, requestId);
    case "invalid_answer":
      return json(
        400,
        { error: { code: "VALIDATION" }, reason: claimed.reason },
        requestId,
      );
    case "unresolvable": {
      // The interaction refused the answer before spending the claim, so the
      // card is still on screen and still answerable.
      const current = await runtime.kit.peek(scope);
      return json(
        409,
        { status: "unresolvable", reason: claimed.reason, pause: current },
        requestId,
      );
    }
    default:
      break;
  }

  const release = () =>
    runtime.kit.release({ ...scope, interactionId: body.interactionId });

  if (c.req.raw.signal.aborted) {
    // The client is already gone. Do not perform the write on its behalf; give
    // the answer back so the card is still there when they return. 499 is the
    // client-closed-request convention.
    await release();
    return json(499, { status: "aborted" }, requestId);
  }

  // One tool set for the whole request: the resolved call and the turn that
  // follows it compose their cards together.
  const tools = await runtime.tools(toolContext(c, caller));

  const resolvedOutcome = await runtime.resolveAnswer({
    toolName: claimed.record.continuation.pausedToolCall.name,
    kind: claimed.record.kind,
    value: claimed.value,
    tools,
    session: { userId: caller.userId },
    companySelector: caller.companySelector,
  });

  if (resolvedOutcome.kind === "pause") {
    // The answer settled one ambiguity and uncovered the next — a picker for
    // the customer, then one for the product. A new question, not a failure:
    // the claimed record no longer holds the slot, so this simply takes it.
    const nextKind = resolvedOutcome.interaction;
    if (!runtime.kit.interactions.has(nextKind)) {
      return json(
        500,
        { status: "pause_rejected", reason: `unknown kind ${nextKind}` },
        requestId,
      );
    }
    const opened = await runtime.kit.open({
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
    const payload: AssistantKitTurnOk = {
      status: "ok",
      parts: [],
      pause: opened.pause,
    };
    return json(200, payload, requestId);
  }

  if (resolvedOutcome.kind === "error") {
    // The action refused. No effect, so the answer did not take: the card stays
    // on screen instead of vanishing with the failure.
    await release();
    const current = await runtime.kit.peek(scope);
    return json(
      409,
      {
        status: "action_failed",
        code: resolvedOutcome.code,
        message: resolvedOutcome.message,
        pause: current,
      },
      requestId,
    );
  }

  const turn = await continueHostTurn({
    kit: runtime.kit,
    conversationId: body.conversationId,
    bind: caller.bind,
    messageId: randomUUID(),
    model: runtime.model,
    tools,
    claimed,
    resolved: resolvedOutcome,
    abortSignal: c.req.raw.signal,
  });

  await runtime.history.save(scope, turn.messages);

  const payload: AssistantKitTurnOk = {
    status: "ok",
    parts: turn.parts,
    pause: turn.pause,
  };
  return json(200, payload, requestId);
}
