import type { AssistantTurnEndReason } from "@showzy/validation/assistant-chat";

export type AssistantInterruptedNoticeCopy = {
  readonly interruptedMessage: string;
  readonly interruptedNotStarted: string;
};

export function assistantInterruptedNotice(
  endReason: AssistantTurnEndReason | null,
  copy: AssistantInterruptedNoticeCopy,
): string {
  if (endReason === null) {
    return copy.interruptedMessage;
  }
  switch (endReason) {
    case "not_started":
      return copy.interruptedNotStarted;
    case "job_exhausted":
    case "timeout":
      return copy.interruptedMessage;
  }
}
