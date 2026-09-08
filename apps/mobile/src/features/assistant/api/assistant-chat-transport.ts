/**
 * AI SDK DefaultChatTransport for `POST /assistant/chat`. Streaming uses
 * Expo `expo/fetch` (built-in). Cookie + `x-company-id` are headers —
 * never action input.
 */
import { DefaultChatTransport, type UIMessage } from "ai";
import { fetch as expoFetch } from "expo/fetch";

import type { StaffAssistantChoiceCardEnvelope } from "../shared/choice";
import {
  assistantChatUrl,
  prepareStaffAssistantSendMessagesRequest,
} from "./assistant-chat-body";
import { staffAssistantChatHeaders } from "./assistant-chat-headers";

export type StaffAssistantUiMessage = UIMessage<
  unknown,
  {
    confirmation: {
      status: "confirmation_required";
      challengeId: string;
      summary: string;
      expiresAt: string;
      actionName: string;
      toolCallId: string;
    };
    choice: StaffAssistantChoiceCardEnvelope;
    resumeCard: unknown;
  }
>;

export function createStaffAssistantTransport(options: {
  readonly apiUrl: string;
  readonly getCookie: () => string;
  readonly getCompanyId: () => string | null;
  readonly getConversationId: () => string | null;
}): DefaultChatTransport<StaffAssistantUiMessage> {
  return new DefaultChatTransport<StaffAssistantUiMessage>({
    api: assistantChatUrl(options.apiUrl),
    credentials: "omit",
    fetch: (input, init) => {
      const url =
        typeof input === "string" || input instanceof URL ? input : input.url;
      return expoFetch(url, { ...init, credentials: "omit" });
    },
    headers: () =>
      staffAssistantChatHeaders({
        cookie: options.getCookie(),
        companyId: options.getCompanyId(),
      }),
    prepareSendMessagesRequest: ({ messages, headers }) => {
      return prepareStaffAssistantSendMessagesRequest({
        conversationId: options.getConversationId(),
        messages,
        headers,
      });
    },
  });
}
