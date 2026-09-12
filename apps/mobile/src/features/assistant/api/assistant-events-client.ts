/**
 * The conversation's event stream, as the phone reads it (ADR-0039, SHO-562).
 *
 * `GET /assistant/kit/events` answers server-sent events under the same session
 * and company rule as the other four calls. This module does one job: turn that
 * byte stream into parsed events, and say when it ended. What to do about an
 * event is `assistant-thread-merge.ts`; when to reconnect is
 * `use-assistant-stream.ts`.
 *
 * **The abort here is not the one ADR-0039 removed.** `AssistantKitCall.signal`
 * and the `499 → aborted` mapping are gone because a phone must never cancel a
 * *turn* — the turn outlives the request by design. This signal cancels a read
 * that this client is doing of its own accord: closing a stream it no longer
 * wants. Nothing on the server ends because of it except the socket, and the
 * turn keeps running. They are opposite things that happen to share a type.
 *
 * Nothing is replayed on reconnect and no `Last-Event-ID` is sent, because
 * every connection opens with a `snapshot`. That is what makes a lost event
 * cost nothing, and it is why this file keeps no cursor.
 */
import { fetch as expoFetch } from "expo/fetch";
import {
  parseAssistantStreamEvent,
  type AssistantStreamEvent,
} from "@showzy/validation/assistant-events";

import { staffAssistantChatHeaders } from "./assistant-chat-headers";
import { assistantKitUrl, type AssistantKitCall } from "./assistant-kit-client";

export const ASSISTANT_KIT_EVENTS_PATH = "/assistant/kit/events";

/**
 * How long to wait before connecting again, by consecutive failed attempt.
 *
 * A stream that ends is normal — the server closes an idle one, a network
 * changes, the app was backgrounded — so the first retry is quick and the
 * ceiling is low enough that a phone coming back to a working network is live
 * again within seconds. Returning to the foreground resets the count, so a
 * person who opens the app never waits out a backoff earned while it was shut.
 */
export function assistantStreamRetryDelayMs(attempt: number): number {
  const steps = [1_000, 2_000, 5_000, 10_000, 20_000];
  const capped = Math.min(Math.max(attempt, 1), steps.length);
  return steps[capped - 1] ?? 20_000;
}

export interface AssistantEventStream {
  /** Idempotent. The stream reports nothing after this returns. */
  close(): void;
}

/**
 * Open one connection and read it until it ends.
 *
 * `onEvent` is called for each event the server sent that this build can read;
 * anything unreadable, reserved or unknown is skipped rather than failing the
 * stream, for the same reason a window drops one message it cannot parse.
 * `onClosed` is called exactly once, whatever ended it — including `close()`.
 */
export function openAssistantEventStream(
  request: AssistantKitCall & {
    readonly conversationId: string;
    readonly onEvent: (event: AssistantStreamEvent) => void;
    readonly onClosed: () => void;
  },
): AssistantEventStream {
  const controller = new AbortController();
  let done = false;
  const finish = (): void => {
    if (done) {
      return;
    }
    done = true;
    request.onClosed();
  };

  void (async () => {
    try {
      const response = await expoFetch(
        `${assistantKitUrl(request.apiUrl, ASSISTANT_KIT_EVENTS_PATH)}?conversationId=${encodeURIComponent(request.conversationId)}`,
        {
          method: "GET",
          credentials: "omit",
          headers: {
            accept: "text/event-stream",
            ...staffAssistantChatHeaders({
              cookie: request.getCookie(),
              companyId: request.getCompanyId(),
            }),
          },
          signal: controller.signal,
        },
      );
      const body = response.ok ? response.body : null;
      if (body === null) {
        // A refusal is not reported as a conversation failure: the commands
        // carry that, and this stream's only remedy is to try again later.
        finish();
        return;
      }
      await readFrames(body, (event) => {
        if (!done) {
          request.onEvent(event);
        }
      });
    } catch {
      // A dropped connection, an abort, or a body that stopped mid-frame. All
      // of them mean the same thing here: the stream is over.
    } finally {
      finish();
    }
  })();

  return {
    close() {
      if (done) {
        return;
      }
      controller.abort();
      finish();
    },
  };
}

/**
 * The SSE framing, and only as much of it as this server speaks.
 *
 * Frames are separated by a blank line; within one, `event:` names it and
 * `data:` lines are joined with newlines. A line starting with `:` is a
 * comment, which is what the heartbeat is — it keeps intermediaries from timing
 * the connection out and carries nothing to parse.
 */
async function readFrames(
  body: ReadableStream<Uint8Array>,
  emit: (event: AssistantStreamEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      return;
    }
    buffer += decoder
      .decode(chunk.value, { stream: true })
      .replaceAll("\r\n", "\n");
    let split = buffer.indexOf("\n\n");
    while (split !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const event = frameToEvent(frame);
      if (event !== null) {
        emit(event);
      }
      split = buffer.indexOf("\n\n");
    }
  }
}

function frameToEvent(frame: string): AssistantStreamEvent | null {
  let name = "";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":") || line.length === 0) {
      continue;
    }
    if (line.startsWith("event:")) {
      name = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).replace(/^ /, ""));
    }
  }
  if (name.length === 0 || data.length === 0) {
    return null;
  }
  // The name must agree with the payload's own `type`, and an unknown or
  // reserved type answers `null`. Both checks live in the shared parser, so a
  // producer and this reader cannot disagree about a field.
  return parseAssistantStreamEvent(name, data.join("\n"));
}
