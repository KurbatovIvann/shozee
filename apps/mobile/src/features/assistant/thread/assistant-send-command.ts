import type { AssistantPause } from "@showzy/validation/assistant-chat";

import type { AssistantKitAnswerRef } from "../api/assistant-kit-client";

export type AssistantSendCommand = {
  readonly key: string;
  readonly text: string;
  readonly answering: AssistantKitAnswerRef | null;
};

export function assistantSendCommand(input: {
  readonly text: string;
  readonly openPause: AssistantPause | null;
}): AssistantSendCommand {
  const open = input.openPause;
  if (open === null) {
    return { key: `send:${input.text}`, text: input.text, answering: null };
  }
  const answering: AssistantKitAnswerRef = {
    interactionId: open.interactionId,
    revision: open.revision,
  };
  return {
    key: `send:${answering.interactionId}:${String(answering.revision)}:${input.text}`,
    text: input.text,
    answering,
  };
}
