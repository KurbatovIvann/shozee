export type VoiceBackgroundListener = () => void;

export function subscribeVoiceBackground(
  listener: VoiceBackgroundListener,
): () => void {
  void listener;
  return () => undefined;
}
