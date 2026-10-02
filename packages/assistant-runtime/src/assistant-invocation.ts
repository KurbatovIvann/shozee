/**
 * Staff-assistant HTTP identity (SHO-524). Host and live chat share the
 * path and `channel: "ai"` without importing each other.
 */
export const ASSISTANT_CHAT_PATH = "/assistant/chat";

export const ASSISTANT_INVOCATION_CHANNEL = "ai" as const;

export const SHO_INVOCATION_CHANNEL = "sho-ai" as const;

export type AssistantInvocationChannel =
  typeof ASSISTANT_INVOCATION_CHANNEL | typeof SHO_INVOCATION_CHANNEL;
