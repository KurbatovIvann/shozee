/**
 * Staff-assistant HTTP identity (SHO-524). Host and live chat share the
 * path and `channel: "ai"` without importing each other.
 */
export const ASSISTANT_CHAT_PATH = "/assistant/chat";

export const ASSISTANT_INVOCATION_CHANNEL = "ai" as const;
