/**
 * How much of a conversation the model is told about.
 *
 * Shozik is an operational assistant, not a thread of discussion: someone opens
 * it, creates an order, adds a document, and closes it. What matters is the last
 * few things they did — "add a cake to that order" needs the order, and nothing
 * before it. So the window is small on purpose, and there is no summary of what
 * fell out: a précis of an operations log ("you created three orders") is not
 * context for the next action, and costs a model call to produce.
 *
 * A window also fixes something a bigger context makes worse. Five turns of the
 * assistant asking a question in prose and the person typing an answer are five
 * demonstrations that prose is how this works — a stronger signal than any one
 * sentence in the prompt. Old habits age out of a window on their own.
 *
 * Counted in turns rather than messages, because one request is not one message:
 * a turn that calls a tool is three or four (the ask, the call, the result, the
 * reply). Six turns is around twenty-five messages here — "ten messages" would
 * have been two and a half requests.
 */
import type { ModelMessage } from "@showzy/assistant-kit";

/**
 * Requests kept, counted from the newest.
 *
 * Six covers the shape of a real sitting — create, amend, check, act on what was
 * just shown — with room for one detour. The previous assistant windowed to
 * eight *messages*, which was closer to two requests.
 */
export const ASSISTANT_HISTORY_TURNS = 6;

/**
 * Backstop for a turn that called many tools. Applied by dropping whole turns,
 * never by cutting inside one.
 */
export const ASSISTANT_HISTORY_MESSAGES_MAX = 60;

/**
 * The indexes where a request begins.
 *
 * A `user` message is the only safe place to cut. A provider refuses a history
 * where a tool call has no result or a result has no call, and rebuilding the
 * pairing after the fact is exactly the 547-line reconstruction this whole path
 * replaced — so the cut never goes near one.
 */
function turnStarts(messages: readonly ModelMessage[]): number[] {
  const starts: number[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === "user") {
      starts.push(index);
    }
  }
  return starts;
}

/**
 * The tail of the conversation to send, cut on request boundaries.
 *
 * Applied when loading rather than when storing, which is enough to bound both:
 * a turn appends to the window it was given, so the stored value never holds
 * more than one turn beyond it.
 *
 * Returns everything when there is no boundary to cut on. That should not
 * happen — a stored history starts with what someone asked — but a history
 * nobody can safely trim is sent whole rather than corrupted.
 */
export function assistantHistoryWindow(
  messages: readonly ModelMessage[],
  options?: {
    readonly turns?: number;
    readonly messagesMax?: number;
  },
): ModelMessage[] {
  const turns = options?.turns ?? ASSISTANT_HISTORY_TURNS;
  const messagesMax = options?.messagesMax ?? ASSISTANT_HISTORY_MESSAGES_MAX;
  const starts = turnStarts(messages);
  if (starts.length === 0) {
    return [...messages];
  }

  let cut = starts.length <= turns ? starts[0] : starts[starts.length - turns];
  if (cut === undefined) {
    return [...messages];
  }

  // Then drop whole turns from the front until the backstop is satisfied. The
  // newest turn is always kept, however large: dropping the request being
  // answered would leave the model with no idea what it is doing.
  for (const start of starts) {
    if (start < cut) {
      continue;
    }
    if (messages.length - start <= messagesMax) {
      cut = start;
      break;
    }
    cut = start;
  }

  return messages.slice(cut);
}
