/**
 * The screen's view model: identity, the conversation, and the composer.
 *
 * It replaced a file that wired three hooks together and had to reconcile them —
 * merging two sets of ignored challenge ids, asking each of two cards whether it
 * was the one being dismissed, and passing a reset callback back into the chat
 * hook through a ref because the hooks could not see each other. All of that was
 * the cost of three owners for one piece of state.
 *
 * Three concerns are left, and they do not overlap. Which conversation this is
 * (`useAssistantConversationId`), what is in it (`useAssistantConversation`), and
 * what the person has typed but not sent (`input`, below — deliberately not the
 * conversation's business, because it has to survive a failed send).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "expo-router";

import { useApiClient } from "../../../api/api-provider";
import { apiUrlFromEnv } from "../../../api/config";
import { useActiveCompany } from "../../../api/query-provider";
import { useAuthSession } from "../../../auth/session-provider";
import { assistantCopy } from "../../../i18n/assistant";
import { detectLocale } from "../../../i18n/locale";
import {
  clipAssistantKitText,
  type AssistantKitCall,
} from "../api/assistant-kit-client";
import { useAssistantConversation } from "../thread/use-assistant-conversation";
import {
  useAssistantConversationId,
  type AssistantConversationDirectory,
} from "../thread/use-assistant-conversation-id";
import { assistantChatErrorMessage, bannerKindFor } from "../shared/chat-error";
import type { AssistantSheetViewModel } from "./assistant-sheet-view";

function resolveApiUrl(): string | null {
  try {
    return apiUrlFromEnv();
  } catch {
    return null;
  }
}

export function useAssistantSheet(): AssistantSheetViewModel & {
  readonly ready: boolean;
} {
  const locale = detectLocale();
  const copy = useMemo(() => assistantCopy(locale), [locale]);
  const { push } = useRouter();
  const auth = useAuthSession();
  const apiClient = useApiClient();
  const { activeCompanyId } = useActiveCompany();
  const sessionUserId = auth.session?.userId ?? null;
  const apiUrl = useMemo(() => resolveApiUrl(), []);

  const [input, setInput] = useState("");

  /**
   * Bumped when the tenant or the person changes, so a reply already in flight
   * cannot paint one company's thread under another.
   */
  const tenantEpochRef = useRef(0);
  const previousTenantRef = useRef<string | null>(null);
  const tenantKey =
    activeCompanyId === null || sessionUserId === null
      ? null
      : `${sessionUserId}:${activeCompanyId}`;
  if (previousTenantRef.current !== tenantKey) {
    previousTenantRef.current = tenantKey;
    tenantEpochRef.current += 1;
  }

  useEffect(() => {
    setInput("");
  }, [tenantKey]);

  const cookieRef = useRef(auth.getCookie);
  cookieRef.current = auth.getCookie;
  const companyIdRef = useRef(activeCompanyId);
  companyIdRef.current = activeCompanyId;

  /**
   * Stable for the lifetime of a tenant: both hooks below treat a new identity as
   * a new conversation to read.
   */
  const call = useMemo<AssistantKitCall | null>(
    () =>
      apiUrl === null || tenantKey === null
        ? null
        : {
            apiUrl,
            getCookie: () => cookieRef.current(),
            getCompanyId: () => companyIdRef.current,
          },
    [apiUrl, tenantKey],
  );

  const directory = useMemo<AssistantConversationDirectory | null>(
    () =>
      apiClient === null || tenantKey === null
        ? null
        : {
            list: (request) =>
              apiClient.client.assistant.listConversations(request),
            create: () => apiClient.client.assistant.createConversation({}),
          },
    [apiClient, tenantKey],
  );

  const identity = useAssistantConversationId({
    sessionUserId,
    directory,
    tenantEpochRef,
  });

  const conversation = useAssistantConversation({
    conversationId: identity.conversationId,
    locale,
    call,
    tenantEpochRef,
    // This hook exists only while the sheet's screen is mounted, which is
    // exactly while the person is looking at it.
    visible: true,
  });

  /**
   * The draft is held here, not in the conversation hook, because it has to
   * survive a send that did not happen: an unreachable server, or a question
   * still open.
   *
   * It goes back on `refused` and on nothing else. Whether a reply still belongs
   * to what is on screen is the conversation hook's question, answered there by
   * the check that already guards the thread. Deciding it here from a bare
   * failure — "the field is empty, so put it back" — put one company's words
   * into another company's composer after a switch mid-flight (SHO-552).
   */
  const send = useCallback(() => {
    const text = clipAssistantKitText(input);
    if (text.length === 0) {
      return;
    }
    setInput("");
    void conversation.send(text).then((outcome) => {
      if (outcome.kind === "refused") {
        // Only if the person has not started typing something else since.
        setInput((current) => (current.length === 0 ? text : current));
      }
      // `unknown` deliberately does not restore: the accept may have stored the
      // message and queued the turn, and the retry that would settle it is the
      // same command anyway (ADR-0039). The words stay visible as the echo
      // until a window says what actually happened.
    });
  }, [conversation, input]);

  const openHref = useCallback(
    (href: string) => {
      push(href);
    },
    [push],
  );

  // A turn running anywhere on this conversation, this screen's own command in
  // flight, or the conversation still being resolved. The composer is closed
  // for all three; only the first is the server's state.
  const busy = conversation.busy || conversation.sending || identity.resolving;
  const bannerKind = identity.failed
    ? "unavailable"
    : bannerKindFor(conversation.failure);

  return {
    ready: call !== null && directory !== null,
    copy,
    rows: conversation.rows,
    input,
    changeInput: setInput,
    send,
    answer: conversation.answer,
    dismiss: conversation.dismiss,
    openHref,
    busy,
    thinking: busy,
    canSend:
      clipAssistantKitText(input).length > 0 &&
      !busy &&
      identity.conversationId !== null,
    banner:
      bannerKind === null ? null : assistantChatErrorMessage(bannerKind, copy),
    loadOlder: conversation.loadOlder,
    loadingOlder: conversation.loadingOlder,
  };
}
