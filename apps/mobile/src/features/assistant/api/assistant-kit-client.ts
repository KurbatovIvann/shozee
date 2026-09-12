/**
 * The four assistant calls. Every one of them answers with the conversation as
 * it stands — its latest window, or the page a read asked for — so this module
 * has one job: get that window, or say why not.
 *
 * There is nothing per-status to decode. The old client had a discriminated
 * union per endpoint and a local copy of the server's own union to parse it
 * with — 357 lines to post one option id — because each status carried a
 * different fragment the client then had to splice into what it already had.
 * Here a refusal carries the same window a success does, so "what went wrong"
 * and "what the conversation looks like now" are two independent answers instead
 * of one entangled one.
 *
 * A refusal with a window is the normal case worth keeping in mind: the
 * question you tried to answer is stale, and the card you should now see comes
 * back in the same response.
 */
import { fetch as expoFetch } from "expo/fetch";
import {
  parseAssistantChatWindow,
  type AssistantChatWindow,
} from "@showzy/validation/assistant-chat";
import { z } from "zod";

import { staffAssistantChatHeaders } from "./assistant-chat-headers";

export const ASSISTANT_KIT_CHAT_PATH = "/assistant/kit/chat";
export const ASSISTANT_KIT_ANSWER_PATH = "/assistant/kit/answer";
export const ASSISTANT_KIT_ABANDON_PATH = "/assistant/kit/abandon";
export const ASSISTANT_KIT_MESSAGES_PATH = "/assistant/kit/messages";

export const ASSISTANT_KIT_TEXT_MAX = 4000;

/**
 * Why a call did not do what was asked.
 *
 * `stale`, `unresolvable`, `action_failed` and `interaction_open` all mean the
 * conversation moved and the accompanying window is current — they are worth
 * telling the person about, but nothing is broken. `turn_open` means another
 * turn holds the conversation and this request did nothing at all.
 * `rate_limited` is the spend ceiling, which is a decision rather than a fault.
 * The rest are faults.
 *
 * `not_sent` means nothing left the phone: blank text, or a tap while another
 * command was in flight. It was called `aborted` while this client could cancel
 * a request, which made it read as "a turn was stopped" — the one thing it has
 * never meant, and now cannot mean at all (ADR-0039).
 */
export type AssistantKitFailureKind =
  | "unreachable"
  | "unreadable"
  | "unauthorized"
  | "expired"
  | "rejected"
  | "server"
  | "rate_limited"
  | "not_sent"
  | "interaction_open"
  | "turn_open"
  | "stale"
  | "unresolvable"
  | "action_failed";

export type AssistantKitFailure = {
  readonly kind: AssistantKitFailureKind;
  readonly message?: string;
};

/**
 * Both fields are independent. A refusal usually carries a window; a
 * transport failure carries none, and the caller keeps what it already had.
 */
export type AssistantKitOutcome = {
  readonly window: AssistantChatWindow | null;
  readonly failure: AssistantKitFailure | null;
};

const bodySchema = z.looseObject({
  status: z.string().optional(),
  reason: z.string().optional(),
  code: z.string().optional(),
  message: z.string().optional(),
  window: z.unknown().optional(),
  error: z.looseObject({ code: z.string() }).optional(),
});

/**
 * There is no `signal`. A phone must never cancel a turn: the turn runs off the
 * request and outlives it, so cancelling the request would only hide a job that
 * is still going (ADR-0039). A stop, if one is ever wanted, is an explicit
 * route. The event stream has a signal of its own, which closes a read this
 * client is doing and ends nothing on the server.
 */
export interface AssistantKitCall {
  readonly apiUrl: string;
  readonly getCookie: () => string | null;
  readonly getCompanyId: () => string | null;
}

export function assistantKitUrl(apiUrl: string, path: string): string {
  return `${apiUrl.replace(/\/+$/, "")}${path}`;
}

function failureFromStatus(
  httpStatus: number,
  status: string | undefined,
): AssistantKitFailureKind {
  if (status === "interaction_open") {
    return "interaction_open";
  }
  if (status === "turn_open") {
    return "turn_open";
  }
  if (status === "stale") {
    return "stale";
  }
  if (status === "unresolvable") {
    return "unresolvable";
  }
  if (status === "action_failed") {
    return "action_failed";
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return "unauthorized";
  }
  if (httpStatus === 410) {
    return "expired";
  }
  if (httpStatus === 429) {
    return "rate_limited";
  }
  if (httpStatus >= 500) {
    return "server";
  }
  return "rejected";
}

/** A message this build cannot read costs that message, not the conversation. */
function windowFrom(value: unknown): AssistantChatWindow | null {
  return parseAssistantChatWindow(value);
}

async function call(
  request: AssistantKitCall,
  path: string,
  init: { readonly method: "GET" | "POST"; readonly body?: unknown },
): Promise<AssistantKitOutcome> {
  let response: Response;
  try {
    response = await expoFetch(assistantKitUrl(request.apiUrl, path), {
      method: init.method,
      credentials: "omit",
      headers: {
        "content-type": "application/json",
        ...staffAssistantChatHeaders({
          cookie: request.getCookie(),
          companyId: request.getCompanyId(),
        }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch {
    // Nothing was learned about the conversation, so nothing is reported about
    // it. Whatever the caller is showing stays.
    return { window: null, failure: { kind: "unreachable" } };
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return {
      window: null,
      failure: {
        kind: response.ok
          ? "unreadable"
          : failureFromStatus(response.status, undefined),
      },
    };
  }

  const body = bodySchema.safeParse(raw);
  if (!body.success) {
    return { window: null, failure: { kind: "unreadable" } };
  }
  const window = windowFrom(body.data.window);

  // The two answers that carry the conversation as the command left it.
  // `accepted` (202) is a turn stored and queued; `ok` (200) is a command that
  // accepted no turn — a replay of one already decided, or an answer whose
  // second question needs no turn. They are not the same event, but they are
  // the same news to a client: neither says "nothing happened", and the window
  // each carries is the truth. Reading `ok` as an empty outcome would leave the
  // thread showing a turn that had already finished (SHO-563).
  if (
    response.ok &&
    (body.data.status === "ok" || body.data.status === "accepted")
  ) {
    // A 2xx whose window this build cannot read is a fault, not an empty
    // conversation: showing nothing would look like the turn never happened.
    return window === null
      ? { window: null, failure: { kind: "unreadable" } }
      : { window, failure: null };
  }
  if (response.ok) {
    // `abandon` answers `{ status: "abandoned" }` and carries no window.
    return { window, failure: null };
  }

  const message = body.data.message ?? body.data.reason;
  const kind = failureFromStatus(response.status, body.data.status);
  return {
    window,
    failure: { kind, ...(message === undefined ? {} : { message }) },
  };
}

export function clipAssistantKitText(text: string): string {
  return text.trim().slice(0, ASSISTANT_KIT_TEXT_MAX);
}

/**
 * The latest window, or with `before` — an `olderCursor` a previous answer gave
 * — the page before it. The cursor is handed back as it came and never read.
 */
export function getAssistantKitWindow(
  request: AssistantKitCall & {
    readonly conversationId: string;
    readonly before?: string;
  },
): Promise<AssistantKitOutcome> {
  const before =
    request.before === undefined
      ? ""
      : `&before=${encodeURIComponent(request.before)}`;
  return call(
    request,
    `${ASSISTANT_KIT_MESSAGES_PATH}?conversationId=${encodeURIComponent(
      request.conversationId,
    )}${before}`,
    { method: "GET" },
  );
}

export function postAssistantKitChat(
  request: AssistantKitCall & {
    readonly conversationId: string;
    /**
     * The client's own token for this attempt. Stable across a retry of the
     * same tap, which is what makes the server's idempotency key identify an
     * attempt rather than a keystroke.
     */
    readonly commandId: string;
    readonly text: string;
  },
): Promise<AssistantKitOutcome> {
  return call(request, ASSISTANT_KIT_CHAT_PATH, {
    method: "POST",
    body: {
      commandId: request.commandId,
      conversationId: request.conversationId,
      text: request.text,
    },
  });
}

/**
 * One route for every kind of question. `answer` is opaque here — what a valid
 * answer looks like belongs to the kind, and the server checks it against that
 * kind's own schema.
 */
export function postAssistantKitAnswer(
  request: AssistantKitCall & {
    readonly conversationId: string;
    readonly commandId: string;
    readonly interactionId: string;
    readonly revision: number;
    readonly answer: unknown;
  },
): Promise<AssistantKitOutcome> {
  return call(request, ASSISTANT_KIT_ANSWER_PATH, {
    method: "POST",
    body: {
      commandId: request.commandId,
      conversationId: request.conversationId,
      interactionId: request.interactionId,
      revision: request.revision,
      answer: request.answer,
    },
  });
}

/** No revision: whichever version is open, the person is done with it. */
export function postAssistantKitAbandon(
  request: AssistantKitCall & {
    readonly conversationId: string;
    readonly interactionId: string;
  },
): Promise<AssistantKitOutcome> {
  return call(request, ASSISTANT_KIT_ABANDON_PATH, {
    method: "POST",
    body: {
      conversationId: request.conversationId,
      interactionId: request.interactionId,
    },
  });
}
