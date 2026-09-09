/**
 * `POST /assistant/kit/choice` — the answer-a-picker route on
 * `@showzy/assistant-kit`.
 *
 * Parallel to the live `/assistant/choice`, mounted on its own path and its
 * own app factory. Nothing here is reachable from `createApp` yet, so the
 * running assistant is untouched while this path is proven.
 *
 * What the route owns, and nothing more: who is asking, which tenant they are
 * in, and dispatching the resolved input to a domain action. The pause
 * protocol — claim exactly once, refuse a stale revision, replay the
 * continuation — belongs to the kit.
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

import { REQUEST_ID_HEADER, resolveRequestId } from "./request-id.js";

export const ASSISTANT_KIT_CHOICE_PATH = "/assistant/kit/choice";

type AppEnv = { Variables: { requestId: string } };

/**
 * Runs the real action with the input the pause preserved.
 *
 * The route does not know which action; the caller wires that. `entityId` is
 * the server's resolution of the chosen option — the client never sent it.
 */
export type ResolveAnswer = (args: {
  readonly toolName: string;
  readonly resolvedInput: unknown;
  readonly entityId: string | undefined;
  readonly session: { readonly userId: string };
  readonly companySelector: string;
}) => Promise<ToolOutcome<unknown>>;

export interface CreateAssistantKitChoiceAppOptions {
  readonly auth: {
    readonly api: {
      readonly getSession: (args: {
        headers: Headers;
      }) => Promise<{ user: { id: string } } | null>;
    };
  };
  readonly kit: AssistantKit;
  readonly model: LanguageModel;
  readonly tools: ToolSet;
  readonly resolveAnswer: ResolveAnswer;
}

interface Body {
  readonly conversationId: string;
  readonly interactionId: string;
  readonly revision: number;
  readonly answer: { readonly kind: string; readonly optionId?: string };
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
 * A pause that is gone, expired, or owned by someone else all answer the same
 * way. Distinguishing them would let one tenant probe another's conversation.
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
    const body: Body = parsed.data;

    // Identity and tenant together. The kit treats it as opaque; a mismatch
    // reads as an absent pause.
    const bind = `${session.user.id}:${companySelector}`;
    const scope = { conversationId: body.conversationId, bind };

    const claimed = await options.kit.claim<unknown>({
      ...scope,
      interactionId: body.interactionId,
      revision: body.revision,
      answer: parsed.data.answer,
    });

    if (claimed.kind === "gone" || claimed.kind === "expired") {
      return goneResponse(requestId);
    }
    if (claimed.kind === "stale") {
      return json(409, { status: "stale", pause: claimed.current }, requestId);
    }
    if (claimed.kind === "wrong_answer_kind") {
      return json(
        422,
        { status: "wrong_answer_kind", expected: claimed.expected },
        requestId,
      );
    }

    const release = () =>
      options.kit.release({ ...scope, interactionId: body.interactionId });

    const entityId =
      parsed.data.answer.kind === "select"
        ? options.kit.entityIdFor(claimed.record, parsed.data.answer.optionId)
        : undefined;
    if (parsed.data.answer.kind === "select" && entityId === undefined) {
      // The option is not one this pause offered. Nothing ran, so the pause
      // goes back to answerable.
      await release();
      const current = await options.kit.peek(scope);
      return json(409, { status: "stale", pause: current }, requestId);
    }

    if (c.req.raw.signal.aborted) {
      // The client is already gone. Do not perform the write on its behalf;
      // give the answer back so the card is still there when they return.
      // 499 is the client-closed-request convention.
      await release();
      return json(499, { status: "aborted" }, requestId);
    }

    const resolved = await options.resolveAnswer({
      toolName: claimed.record.continuation.pausedToolCall.name,
      resolvedInput: claimed.record.resolvedInput,
      entityId,
      session: { userId: session.user.id },
      companySelector,
    });

    if (resolved.kind !== "ok") {
      // The action refused. No effect, so the answer did not take: the card
      // stays on screen instead of vanishing with the failure.
      await release();
      const current = await options.kit.peek(scope);
      return json(
        409,
        {
          status: "action_failed",
          ...(resolved.kind === "domain_error"
            ? { code: resolved.code, message: resolved.message }
            : { code: "PENDING_NOT_SUPPORTED" }),
          pause: current,
        },
        requestId,
      );
    }

    const turn = await continueHostTurn<unknown>({
      kit: options.kit,
      conversationId: body.conversationId,
      bind,
      messageId: randomUUID(),
      model: options.model,
      tools: options.tools,
      claimed,
      resolved,
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
