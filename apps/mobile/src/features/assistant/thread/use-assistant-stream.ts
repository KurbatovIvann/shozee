/**
 * Keeping one event stream open for as long as it is worth having.
 *
 * ADR-0039 replaced polling with this: the server pushes, and the phone's only
 * jobs are to be connected when it matters and to come back after a break.
 * Nothing here runs on an interval — every reconnection is caused either by the
 * connection ending or by the app returning to the foreground.
 *
 * A stream ending is ordinary, not an error. The server closes an idle one, a
 * network changes, iOS suspends the app within seconds of it being
 * backgrounded. So this reconnects on a short backoff and says nothing to the
 * person: the conversation on screen is still the last thing the server said,
 * and the next connection opens with a `snapshot` that corrects it.
 */
import { useEffect, useRef } from "react";

import type { AssistantStreamEvent } from "@showzy/validation/assistant-events";

import {
  assistantStreamRetryDelayMs,
  openAssistantEventStream,
  type AssistantEventStream,
} from "../api/assistant-events-client";
import type { AssistantKitCall } from "../api/assistant-kit-client";
import { subscribeAssistantForeground } from "./assistant-app-state";

export function useAssistantStream(args: {
  readonly call: AssistantKitCall | null;
  readonly conversationId: string | null;
  /**
   * Whether this conversation is worth a connection: the sheet is on screen, or
   * a turn is running and its result has to land wherever the person goes.
   */
  readonly listening: boolean;
  readonly onEvent: (event: AssistantStreamEvent) => void;
}): void {
  // Read through a ref so a new callback identity on every render does not tear
  // the connection down and open another one.
  const onEventRef = useRef(args.onEvent);
  onEventRef.current = args.onEvent;

  const { call, conversationId, listening } = args;

  useEffect(() => {
    if (call === null || conversationId === null || !listening) {
      return;
    }

    let stopped = false;
    let stream: AssistantEventStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    /**
     * Which connection is the current one. A stream that is replaced still
     * reports that it closed, and without this its report would schedule a
     * reconnection on top of the one already opening.
     */
    let generation = 0;

    const clearTimer = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const connect = (): void => {
      generation += 1;
      const mine = generation;
      stream = openAssistantEventStream({
        ...call,
        conversationId,
        onEvent: (event) => {
          // A connection that delivered something is a working connection, so
          // the next break starts from the short end of the backoff again.
          attempt = 0;
          onEventRef.current(event);
        },
        onClosed: () => {
          if (stopped || mine !== generation) {
            return;
          }
          stream = null;
          attempt += 1;
          timer = setTimeout(connect, assistantStreamRetryDelayMs(attempt));
        },
      });
    };

    connect();

    // Coming back is the one moment a wait is certainly pointless: the stream
    // died while the app was away, and the person is looking at the thread now.
    const unsubscribe = subscribeAssistantForeground(() => {
      if (stopped) {
        return;
      }
      clearTimer();
      attempt = 0;
      const previous = stream;
      stream = null;
      // Bumped before the close so the old stream's report is ignored rather
      // than racing the connection opened on the next line.
      generation += 1;
      previous?.close();
      connect();
    });

    return () => {
      stopped = true;
      clearTimer();
      unsubscribe();
      stream?.close();
    };
  }, [call, conversationId, listening]);
}
