import { AppState, type AppStateStatus } from "react-native";

export type VoiceBackgroundListener = () => void;

export function subscribeVoiceBackground(
  listener: VoiceBackgroundListener,
): () => void {
  const subscription = AppState.addEventListener(
    "change",
    (next: AppStateStatus) => {
      if (next === "background") {
        listener();
      }
    },
  );
  return () => {
    subscription.remove();
  };
}
