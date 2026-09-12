/**
 * The device half: the app returning to the foreground.
 *
 * ADR-0039 puts this in place of a timer — a phone reconnects when it comes
 * back, and nothing polls. A backgrounded app's stream is usually already dead
 * (iOS suspends within seconds), so this is the moment the conversation has to
 * be read again, and the connection that does it starts from a `snapshot`.
 *
 * Only the transition **into** `active` is reported. `inactive` is the state
 * behind a notification shade or an app switcher and is not a departure, so
 * reporting it would reconnect over a stream that is still perfectly alive.
 */
import { AppState, type AppStateStatus } from "react-native";

export type AssistantForegroundListener = () => void;

export function subscribeAssistantForeground(
  listener: AssistantForegroundListener,
): () => void {
  let previous: AppStateStatus = AppState.currentState;
  const subscription = AppState.addEventListener(
    "change",
    (next: AppStateStatus) => {
      const returned = previous !== "active" && next === "active";
      previous = next;
      if (returned) {
        listener();
      }
    },
  );
  return () => {
    subscription.remove();
  };
}
