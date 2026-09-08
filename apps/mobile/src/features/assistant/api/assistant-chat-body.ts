/**
 * Live staff assistant chat body (SHO-524). `POST /assistant/chat` is
 * `{ conversationId, text, locale? }` — never `companyId`, never local
 * history as model context.
 */
import { detectLocale, type Locale } from "../../../i18n/locale";

export const ASSISTANT_CHAT_PATH = "/assistant/chat";
export const STAFF_ASSISTANT_CHAT_MESSAGE_TEXT_MAX = 16_000;

export function assistantChatUrl(apiOrigin: string): string {
  return `${apiOrigin.replace(/\/+$/, "")}${ASSISTANT_CHAT_PATH}`;
}

export type StaffAssistantChatBody = {
  readonly conversationId: string;
  readonly text: string;
  readonly locale: Locale;
};

export class AssistantConversationMissingError extends Error {
  constructor() {
    super("conversation required");
    this.name = "AssistantConversationMissingError";
  }
}

export function staffAssistantChatBody(args: {
  readonly conversationId: string | null;
  readonly text: string;
  readonly locale?: Locale;
}): StaffAssistantChatBody {
  if (args.conversationId === null) {
    throw new AssistantConversationMissingError();
  }
  return {
    conversationId: args.conversationId,
    text: args.text,
    locale: args.locale ?? detectLocale(),
  };
}

export function clipAssistantInput(text: string): string {
  return text.trim().slice(0, STAFF_ASSISTANT_CHAT_MESSAGE_TEXT_MAX);
}
