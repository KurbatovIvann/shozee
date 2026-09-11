/**
 * Session cookie + company selector for the assistant routes. Never logs cookie
 * or OTP values.
 *
 * There used to be a third header here, the confirmation challenge id. Nothing
 * sends it any more: a question is answered by its `interactionId` in the body,
 * where the server checks it against the stored pause rather than trusting a
 * header the client chose. The header itself still exists for ordinary UI
 * actions (core.md §7); it is the assistant that stopped needing it.
 */
import { COMPANY_SELECTOR_HEADER } from "@showzy/contract";

export function staffAssistantChatHeaders(args: {
  readonly cookie: string | null;
  readonly companyId: string | null;
}): Record<string, string> {
  const headers: Record<string, string> = {};
  if (args.cookie !== null && args.cookie !== "") {
    headers.cookie = args.cookie;
  }
  if (args.companyId !== null && args.companyId !== "") {
    headers[COMPANY_SELECTOR_HEADER] = args.companyId;
  }
  return headers;
}
