import type { AssistantCopy } from "../../../i18n/assistant";
import type { Locale } from "../../../i18n/locale";
import { assistantSurfacesFromParts, type AssistantSurface } from "../surfaces";
import type { PendingChoice } from "./choice-presenter";
import type {
  AssistantChatMessage,
  PendingConfirmation,
} from "./confirmation-presenter";
import { assistantJobLabel } from "./job-labels";
import {
  toolStepsFromParts,
  type AssistantTimelineStatus,
} from "./turn-timeline";

const NO_DISMISSED_CHALLENGES: ReadonlySet<string> = new Set();
const EMPTY_SURFACES: readonly AssistantSurface[] = [];

/** Stable FlashList id for the live wait line (not persisted). */
export const ASSISTANT_LIVE_WAIT_ROW_ID = "assistant-wait";

export type AssistantLiveStatus = "submitted" | "streaming" | "ready" | "error";

export type AssistantTimelineStep = {
  readonly id: string;
  readonly label: string;
  readonly status: AssistantTimelineStatus;
};

export type AssistantChatRow = {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly confirmation: PendingConfirmation | null;
  readonly choice: PendingChoice | null;
  readonly timeline: readonly AssistantTimelineStep[];
  readonly surfaces: readonly AssistantSurface[];
};

/** Thread row after wait-state buffering. Timeline is never shown. */
export type AssistantVisibleRow = {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly confirmation: PendingConfirmation | null;
  readonly choice: PendingChoice | null;
  readonly surfaces: readonly AssistantSurface[];
  readonly waiting: boolean;
};

function textFromParts(message: AssistantChatMessage): string {
  const chunks: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text" && typeof part.text === "string") {
      chunks.push(part.text);
    }
  }
  return chunks.join("");
}

function labeledTimeline(
  message: AssistantChatMessage,
  copy: AssistantCopy,
  dismissedChallengeIds: ReadonlySet<string>,
): readonly AssistantTimelineStep[] {
  return toolStepsFromParts(
    message.parts,
    message.id,
    dismissedChallengeIds,
  ).map((step) => ({
    id: step.id,
    label: assistantJobLabel(step.toolName, copy),
    status: step.status,
  }));
}

export function assistantChatRows(
  messages: readonly AssistantChatMessage[],
  pending: PendingConfirmation | null,
  copy: AssistantCopy,
  dismissedChallengeIds: ReadonlySet<string> = NO_DISMISSED_CHALLENGES,
  locale: Locale = "uk",
  pendingChoice: PendingChoice | null = null,
): readonly AssistantChatRow[] {
  const rows: AssistantChatRow[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }
    const text = textFromParts(message);
    const confirmation =
      pending !== null && pending.messageId === message.id ? pending : null;
    const choice =
      pendingChoice !== null && pendingChoice.messageId === message.id
        ? pendingChoice
        : null;
    const timeline =
      message.role === "assistant"
        ? labeledTimeline(message, copy, dismissedChallengeIds)
        : [];
    const surfaces =
      message.role === "assistant"
        ? assistantSurfacesFromParts(message.parts, locale)
        : EMPTY_SURFACES;
    if (
      text.length === 0 &&
      confirmation === null &&
      choice === null &&
      timeline.length === 0 &&
      surfaces.length === 0
    ) {
      continue;
    }
    rows.push({
      id: message.id,
      role: message.role,
      text,
      confirmation,
      choice,
      timeline,
      surfaces,
    });
  }
  return rows;
}

export function assistantRowHasInFlightTools(row: AssistantChatRow): boolean {
  return row.timeline.some(
    (step) => step.status === "queued" || step.status === "running",
  );
}

/**
 * HITL on the **current** turn (last assistant after the last user) turns
 * the wait line off. A leftover confirmation on a past assistant must
 * not suppress wait/buffering for a newer live turn — composer `canSend`
 * stays gated on `sendBusy` only, so that follow-up is allowed.
 */
function currentTurnHasHitl(rows: readonly AssistantChatRow[]): boolean {
  const lastAssistantIndex = lastIndexOfRole(rows, "assistant");
  const lastUserIndex = lastIndexOfRole(rows, "user");
  if (lastAssistantIndex <= lastUserIndex) {
    return false;
  }
  const row = rows[lastAssistantIndex];
  if (row === undefined) {
    return false;
  }
  return row.confirmation !== null || row.choice !== null;
}

export function assistantTurnIsWaiting(input: {
  readonly status: AssistantLiveStatus;
  readonly rows: readonly AssistantChatRow[];
}): boolean {
  if (input.status !== "submitted" && input.status !== "streaming") {
    return false;
  }
  return !currentTurnHasHitl(input.rows);
}

function toVisibleRow(row: AssistantChatRow): AssistantVisibleRow | null {
  if (row.role === "user") {
    if (row.text.length === 0) {
      return null;
    }
    return {
      id: row.id,
      role: "user",
      text: row.text,
      confirmation: null,
      choice: null,
      surfaces: EMPTY_SURFACES,
      waiting: false,
    };
  }
  if (
    row.text.length === 0 &&
    row.confirmation === null &&
    row.choice === null &&
    row.surfaces.length === 0
  ) {
    return null;
  }
  return {
    id: row.id,
    role: "assistant",
    text: row.text,
    confirmation: row.confirmation,
    choice: row.choice,
    surfaces: row.surfaces,
    waiting: false,
  };
}

function lastIndexOfRole(
  rows: readonly AssistantChatRow[],
  role: "user" | "assistant",
): number {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index]?.role === role) {
      return index;
    }
  }
  return -1;
}

/**
 * Live-turn presentation: one wait row while in flight; prose text +
 * surfaces together when ready. Past / hydrate turns never wait. Hide
 * streamed text/surfaces only for the current-turn assistant (after the
 * last user row). A previous ready reply — including leftover HITL on
 * that past assistant — stays visible during a follow-up wait. Server
 * text parts are already prose (SHO-507); this mapper does not parse a
 * `{ spoken }` envelope.
 */
export function assistantDisplayRows(
  rows: readonly AssistantChatRow[],
  liveWaiting: boolean,
): readonly AssistantVisibleRow[] {
  const lastAssistantIndex = lastIndexOfRole(rows, "assistant");
  const lastUserIndex = lastIndexOfRole(rows, "user");
  const hideCurrentAssistant =
    liveWaiting && lastAssistantIndex > lastUserIndex;
  const visible: AssistantVisibleRow[] = [];
  for (const [index, row] of rows.entries()) {
    if (hideCurrentAssistant && index === lastAssistantIndex) {
      continue;
    }
    const displayed = toVisibleRow(row);
    if (displayed !== null) {
      visible.push(displayed);
    }
  }
  if (liveWaiting) {
    visible.push({
      id: ASSISTANT_LIVE_WAIT_ROW_ID,
      role: "assistant",
      text: "",
      confirmation: null,
      choice: null,
      surfaces: EMPTY_SURFACES,
      waiting: true,
    });
  }
  return visible;
}
