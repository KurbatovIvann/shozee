/**
 * `POST /assistant/kit/choice` — answering an open interaction, on
 * `@showzy/assistant-kit`.
 *
 * Parallel to the live `/assistant/choice`, mounted on its own path and its
 * own app factory. Nothing here is reachable from `createApp` yet, so the
 * running assistant is untouched while this path is proven.
 *
 * What the route owns, and nothing more: who is asking, which tenant they are
 * in, and dispatching what the interaction resolved to a domain action. Claim
 * once, refuse a stale revision, replay the continuation — all of that is the
 * package's, and which kinds exist is `assistant-interactions.ts`.
 *
 * Ordering is the part worth reading. The write runs before the loop, and its
 * card is stored before generation is attempted, so a provider failure or a
 * disconnect cannot take a committed result down with the explanation.
 */
import { randomUUID } from "node:crypto";

import {
  continueHostTurn,
  interactionResponseSchema,
  type AssistantKit,
  type LanguageModel,
  type PublicPause,
  type ToolOutcome,
  type ToolSet,
} from "@showzy/assistant-kit";
import { COMPANY_SELECTOR_HEADER } from "@showzy/contract";
import { Hono } from "hono";

import type { AssistantInteractionTypes } from "./assistant-interactions.js";
import { REQUEST_ID_HEADER, resolveRequestId } from "./request-id.js";

export const ASSISTANT_KIT_CHOICE_PATH = "/assistant/kit/choice";

type AppEnv = { Variables: { requestId: string } };

/**
 * Runs the real action with whatever the interaction resolved to.
 *
 * The route does not know which action; the caller wires that. `value` is the
 * server's reading of the answer — for a picker, the entity behind the chosen
 * option, which the client never sent.
 */
export type ResolveAnswer = (args: {
  readonly toolName: string;
  readonly kind: string;
  readonly value: unknown;
  readonly session: { readonly userId: string };
  readonly companySelector: string;
}) => Promise<ToolOutcome>;

export interface CreateAssistantKitChoiceAppOptions {
  readonly auth: {
    readonly api: {
      readonly getSession: (args: {
        headers: Headers;
      }) => Promise<{ user: { id: string } } | null>;
    };
  };
  readonly kit: AssistantKit<AssistantInteractionTypes>;
  readonly model: LanguageModel;
  readonly tools: ToolSet;
  readonly resolveAnswer: ResolveAnswer;
}

function json(status: number, body: unknown, requestId: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      [REQUEST_ID_HEADER]: requestId,
    },
  });
}

/**
 * Gone, expired, owned by someone else, or of a kind this deployment no longer
 * registers — all answer the same way. Distinguishing them would let one
 * tenant probe another's conversation.
 */
function goneResponse(requestId: string): Response {
  return json(410, { status: "expired" }, requestId);
}

export interface AssistantKitChoiceOk {
  readonly status: "ok";
  readonly parts: unknown;
  readonly pause: PublicPause | null;
}

export function createAssistantKitChoiceApp(
  options: CreateAssistantKitChoiceAppOptions,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use(async (c, next) => {
    c.set("requestId", resolveRequestId(c.req.header(REQUEST_ID_HEADER)));
    await next();
  });

  app.post(ASSISTANT_KIT_CHOICE_PATH, async (c) => {
    const requestId = c.get("requestId");

    const session = await options.auth.api.getSession({
      headers: c.req.raw.headers,
    });
    if (session === null) {
      return json(401, { error: { code: "UNAUTHENTICATED" } }, requestId);
    }
    const companySelector = c.req.header(COMPANY_SELECTOR_HEADER);
    if (companySelector === undefined || companySelector.length === 0) {
      return json(400, { error: { code: "VALIDATION" } }, requestId);
    }

    let raw: unknown;
    try {
      raw = await c.req.raw.json();
    } catch {
      return json(400, { error: { code: "VALIDATION" } }, requestId);
    }
    const parsed = interactionResponseSchema.safeParse(raw);
    if (!parsed.success) {
      return json(400, { error: { code: "VALIDATION" } }, requestId);
    }
    const body = parsed.data;

    // Identity and tenant together. The package treats it as opaque; a
    // mismatch reads as an absent pause.
    const bind = `${session.user.id}:${companySelector}`;
    const scope = { conversationId: body.conversationId, bind };

    const claimed = await options.kit.claim({
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
        // The interaction refused the answer before spending the claim, so
        // the card is still on screen and still answerable.
        const current = await options.kit.peek(scope);
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
      options.kit.release({ ...scope, interactionId: body.interactionId });

    if (c.req.raw.signal.aborted) {
      // The client is already gone. Do not perform the write on its behalf;
      // give the answer back so the card is still there when they return.
      // 499 is the client-closed-request convention.
      await release();
      return json(499, { status: "aborted" }, requestId);
    }

    const resolvedOutcome = await options.resolveAnswer({
      toolName: claimed.record.continuation.pausedToolCall.name,
      kind: claimed.record.kind,
      value: claimed.value,
      session: { userId: session.user.id },
      companySelector,
    });

    if (resolvedOutcome.kind !== "ok") {
      // The action refused. No effect, so the answer did not take: the card
      // stays on screen instead of vanishing with the failure.
      await release();
      const current = await options.kit.peek(scope);
      return json(
        409,
        {
          status: "action_failed",
          ...(resolvedOutcome.kind === "error"
            ? { code: resolvedOutcome.code, message: resolvedOutcome.message }
            : { code: "PAUSE_NOT_SUPPORTED" }),
          pause: current,
        },
        requestId,
      );
    }

    const turn = await continueHostTurn({
      kit: options.kit,
      conversationId: body.conversationId,
      bind,
      messageId: randomUUID(),
      model: options.model,
      tools: options.tools,
      claimed,
      resolved: resolvedOutcome,
      abortSignal: c.req.raw.signal,
    });

    const payload: AssistantKitChoiceOk = {
      status: "ok",
      parts: turn.parts,
      pause: turn.pause,
    };
    return json(200, payload, requestId);
  });

  return app;
}
