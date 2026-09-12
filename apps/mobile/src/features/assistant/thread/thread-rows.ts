/**
 * The stored conversation → the rows a thread renders. One function, one
 * derivation.
 *
 * The old path had three: parts fabricated locally after answering a question,
 * a resume envelope, and a re-derivation from raw tool parts — all reaching the
 * same card, and disagreeing when they did not. Here the server stores what it
 * decided and this reads it back. There is nothing to re-derive, so there is
 * nothing to disagree about.
 *
 * Two rules carry most of the weight.
 *
 * `openPause` is the only source of an answerable question. `interaction` parts
 * in the messages are snapshots of the moment each was asked, kept for the
 * record; they are never rendered as tappable. An answered question stops
 * appearing in `openPause`, which is why this file — and the hook above it —
 * needs no local memory of what has already been answered.
 *
 * Nothing here invents a part. A card the server did not write does not appear,
 * and a card this build cannot read is omitted rather than half-drawn.
 */
import {
  assistantInteractionFromPause,
  type AssistantChatThread,
  type AssistantChatMessage,
  type AssistantChatTurn,
  type AssistantInteraction,
  type AssistantPause,
} from "@showzy/validation/assistant-chat";

import { assistantTextPartStatus } from "./assistant-thread-merge";

import type { Locale } from "../../../i18n/locale";
import {
  localizeAssistantCardPayload,
  type AssistantSurface,
} from "../surfaces";

/** Stable list id for the in-flight row. Not part of the thread. */
export const ASSISTANT_WAITING_ROW_ID = "assistant-waiting";

/** Stable list id for a question whose own message is no longer stored. */
export const ASSISTANT_ORPHAN_INTERACTION_ROW_ID = "assistant-open-question";

/** Stable list id for a message that has been sent but not yet acknowledged. */
export const ASSISTANT_PENDING_USER_ROW_ID = "assistant-pending-user";

export type AssistantThreadRow = {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly surfaces: readonly AssistantSurface[];
  readonly interaction: AssistantInteraction | null;
  readonly failed: boolean;
  readonly interrupted: boolean;
  readonly waiting: boolean;
};

const NO_SURFACES: readonly AssistantSurface[] = [];

function textOf(message: AssistantChatMessage): string {
  const chunks: string[] = [];
  for (const part of message.parts) {
    if (part.kind === "text") {
      chunks.push(part.text);
    }
  }
  return chunks.join("");
}

function failedIn(message: AssistantChatMessage): boolean {
  return message.parts.some(
    (part) => part.kind === "text" && part.status === "error",
  );
}

function interruptedIn(
  message: AssistantChatMessage,
  turn: AssistantChatTurn | null,
): boolean {
  return message.parts.some(
    (part) =>
      part.kind === "text" &&
      assistantTextPartStatus(turn, part.status) === "interrupted",
  );
}

function surfacesOf(
  message: AssistantChatMessage,
  locale: Locale,
): readonly AssistantSurface[] {
  const surfaces: AssistantSurface[] = [];
  for (const part of message.parts) {
    if (part.kind !== "card") {
      continue;
    }
    const surface = localizeAssistantCardPayload(
      part.type,
      part.payload,
      locale,
    );
    if (surface !== null) {
      surfaces.push(surface);
    }
  }
  return surfaces;
}

function asksThis(
  message: AssistantChatMessage,
  pause: AssistantPause,
): boolean {
  return message.parts.some(
    (part) =>
      part.kind === "interaction" && part.interactionId === pause.interactionId,
  );
}

function isEmpty(row: AssistantThreadRow): boolean {
  return (
    row.text.length === 0 &&
    row.surfaces.length === 0 &&
    row.interaction === null &&
    !row.failed &&
    !row.interrupted
  );
}

/**
 * The message that asked the open question, if it is still stored.
 *
 * The pause and the messages are two records, and the message that asked can be
 * missing from what this build shows: one it could not read is left out of the
 * window. Dropping the question there would leave the conversation permanently
 * stuck — every new turn refused by a question nothing can answer. It gets a
 * row of its own instead of being attached to whatever message happens to be
 * last.
 */
function interactionHost(
  messages: readonly AssistantChatMessage[],
  pause: AssistantPause,
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && asksThis(message, pause)) {
      return message.messageId;
    }
  }
  return null;
}

export function assistantThreadRows(input: {
  readonly thread: Pick<AssistantChatThread, "messages" | "openPause" | "turn">;
  readonly locale: Locale;
  /** A request is in flight. Adds one trailing row; hides nothing. */
  readonly waiting: boolean;
  /**
   * What the person just sent, until the server confirms it.
   *
   * Not an exception to "nothing here invents a part": this is the composer's
   * own text, echoed back to the person who typed it, and it disappears the
   * moment the server's window carries the real message. The server writes the
   * user message before the model runs, so the gap is one round trip — but that
   * round trip is a whole turn, and watching your own message vanish for it
   * reads as the app having dropped it.
   */
  readonly pending?: string | null;
}): readonly AssistantThreadRow[] {
  const { messages, openPause, turn } = input.thread;
  const interaction =
    openPause === null ? null : assistantInteractionFromPause(openPause);
  const hostId =
    openPause === null || interaction === null
      ? null
      : interactionHost(messages, openPause);

  const rows: AssistantThreadRow[] = [];
  for (const message of messages) {
    const row: AssistantThreadRow = {
      id: message.messageId,
      role: message.role,
      text: textOf(message),
      surfaces:
        message.role === "assistant"
          ? surfacesOf(message, input.locale)
          : NO_SURFACES,
      interaction: message.messageId === hostId ? interaction : null,
      failed: failedIn(message),
      interrupted: interruptedIn(message, turn),
      waiting: false,
    };
    if (!isEmpty(row)) {
      rows.push(row);
    }
  }

  // A question whose message is gone still has to be answerable.
  if (interaction !== null && !rows.some((row) => row.interaction !== null)) {
    rows.push({
      id: ASSISTANT_ORPHAN_INTERACTION_ROW_ID,
      role: "assistant",
      text: "",
      surfaces: NO_SURFACES,
      interaction,
      failed: false,
      interrupted: false,
      waiting: false,
    });
  }

  const pending = input.pending ?? null;
  if (pending !== null && pending.length > 0) {
    rows.push({
      id: ASSISTANT_PENDING_USER_ROW_ID,
      role: "user",
      text: pending,
      surfaces: NO_SURFACES,
      interaction: null,
      failed: false,
      interrupted: false,
      waiting: false,
    });
  }

  if (input.waiting) {
    rows.push({
      id: ASSISTANT_WAITING_ROW_ID,
      role: "assistant",
      text: "",
      surfaces: NO_SURFACES,
      interaction: null,
      failed: false,
      interrupted: false,
      waiting: true,
    });
  }

  return rows;
}
