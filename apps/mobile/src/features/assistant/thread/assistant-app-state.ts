/**
 * "The app came back to the foreground", as everything but a device sees it.
 *
 * Web and tests have no `AppState`, and `react-native` cannot be imported in
 * vitest at all — the same split `src/prefs/platform-storage.ts` makes. This is
 * the inert half: it never fires, so a stream on web or in a test reconnects on
 * its own backoff and nothing else.
 *
 * The device half is `assistant-app-state.native.ts`, which Metro picks.
 */
export type AssistantForegroundListener = () => void;

/** Returns the unsubscribe. Never fires here. */
export function subscribeAssistantForeground(
  listener: AssistantForegroundListener,
): () => void {
  // Kept in the signature so this half and the native one stay the same
  // function; there is simply no foreground event to hand it.
  void listener;
  return () => undefined;
}
