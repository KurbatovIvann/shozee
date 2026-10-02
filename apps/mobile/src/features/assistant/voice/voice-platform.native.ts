import { AccessibilityInfo, Linking } from "react-native";

export function openVoiceSettings(): void {
  void Linking.openSettings().catch(() => undefined);
}

export function announceVoice(message: string): void {
  if (message.length === 0) {
    return;
  }
  AccessibilityInfo.announceForAccessibility(message);
}
