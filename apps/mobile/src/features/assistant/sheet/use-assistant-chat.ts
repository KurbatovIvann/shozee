import { useChat } from "@ai-sdk/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useApiClient } from "../../../api/api-provider";
import { apiUrlFromEnv } from "../../../api/config";
import { describeQueryFailure } from "../../../api/errors";
import { useActiveCompany } from "../../../api/query-provider";
import { useBoundContractMutation } from "../../../api/use-bound-contract-mutation";
import { useAuthSession } from "../../../auth/session-provider";
import { clipAssistantInput } from "../api/assistant-chat-body";
import {
  peekAssistantChoice,
  postAssistantChoice,
} from "../api/assistant-choice";
import {
  createStaffAssistantTransport,
  type StaffAssistantUiMessage,
} from "../api/assistant-chat-transport";
import { bindCreateConversationMutate } from "../api/create-conversation";
import {
  resetAssistantTenantSession,
  resumeOwnAssistantConversation,
  sendEnsuredAssistantMessage,
  type AssistantCompanyEpochRef,
} from "../shared/assistant-session";
import {
  queryFailureToAssistantKind,
  type AssistantChatErrorKind,
} from "../shared/chat-error";
import type {
  ChoiceAppendPart,
  ChoiceSelectResult,
} from "../shared/choice-presenter";
import type { AssistantChatMessage } from "../shared/confirmation-presenter";
import type { AssistantChatStatus } from "./use-assistant-confirmation";

function resolveApiUrl(): string | null {
  try {
    return apiUrlFromEnv();
  } catch {
    return null;
  }
}

export function useAssistantChat(): {
  readonly ready: boolean;
  readonly messages: readonly AssistantChatMessage[];
  readonly status: AssistantChatStatus;
  readonly error: unknown;
  readonly input: string;
  readonly changeInput: (value: string) => void;
  readonly send: () => void;
  readonly resume: (headers: Readonly<Record<string, string>>) => Promise<void>;
  readonly sendBusy: boolean;
  readonly thinking: boolean;
  readonly canSend: boolean;
  readonly createErrorKind: AssistantChatErrorKind | null;
  readonly confirmationResetRef: {
    current: () => void;
  };
  readonly choiceResetRef: {
    current: () => void;
  };
  readonly companyEpochRef: AssistantCompanyEpochRef;
  readonly postChoice: (input: {
    readonly choiceId: string;
    readonly optionId: string;
  }) => Promise<ChoiceSelectResult>;
  readonly appendAssistantParts: (parts: readonly ChoiceAppendPart[]) => void;
} {
  const auth = useAuthSession();
  const apiClient = useApiClient();
  const { activeCompanyId } = useActiveCompany();
  const sessionUserId = auth.session?.userId ?? null;
  const apiUrl = useMemo(() => resolveApiUrl(), []);
  const confirmationResetRef = useRef<() => void>(() => {
    return;
  });
  const choiceResetRef = useRef<() => void>(() => {
    return;
  });
  const [hydrateBusy, setHydrateBusy] = useState(false);

  const cookieRef = useRef(auth.getCookie);
  cookieRef.current = auth.getCookie;
  const companyIdRef = useRef(activeCompanyId);
  companyIdRef.current = activeCompanyId;
  const conversationIdRef = useRef<string | null>(null);
  const previousCompanyIdRef = useRef(activeCompanyId);
  const companyEpochRef = useRef(0);

  const [input, setInput] = useState("");

  const createConversation = useBoundContractMutation(
    bindCreateConversationMutate,
  );

  const transport = useMemo(
    () =>
      createStaffAssistantTransport({
        apiUrl: apiUrl ?? "http://127.0.0.1",
        getCookie: () => cookieRef.current(),
        getCompanyId: () => companyIdRef.current,
        getConversationId: () => conversationIdRef.current,
      }),
    [apiUrl],
  );

  const { messages, sendMessage, setMessages, status, error, clearError } =
    useChat<StaffAssistantUiMessage>({
      id: activeCompanyId ?? "assistant-none",
      transport,
    });

  const presenterMessages = useMemo((): AssistantChatMessage[] => {
    return messages.map((message) => ({
      id: message.id,
      role: message.role,
      parts: message.parts,
    }));
  }, [messages]);

  const setMessagesRef = useRef(setMessages);
  setMessagesRef.current = setMessages;

  const busy = status === "submitted" || status === "streaming";
  const sendBusy = busy || createConversation.isPending || hydrateBusy;

  const resume = useCallback(
    (headers: Readonly<Record<string, string>>) =>
      sendMessage(undefined, { headers: { ...headers } }),
    [sendMessage],
  );

  const appendAssistantParts = useCallback(
    (parts: readonly ChoiceAppendPart[]) => {
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          parts: [...parts],
        },
      ]);
    },
    [setMessages],
  );

  const postChoice = useCallback(
    (input: { readonly choiceId: string; readonly optionId: string }) => {
      const conversationId = conversationIdRef.current;
      if (conversationId === null || apiUrl === null) {
        return Promise.resolve({
          status: "error",
          text: "Choice resume failed.",
        });
      }
      return postAssistantChoice({
        apiUrl,
        getCookie: () => cookieRef.current(),
        getCompanyId: () => companyIdRef.current,
        conversationId,
        choiceId: input.choiceId,
        optionId: input.optionId,
      });
    },
    [apiUrl],
  );

  useEffect(() => {
    const previous = previousCompanyIdRef.current;
    previousCompanyIdRef.current = activeCompanyId;
    if (previous !== activeCompanyId) {
      companyEpochRef.current += 1;
      resetAssistantTenantSession({
        conversationIdRef,
        setMessages,
        resetConfirmation: () => {
          confirmationResetRef.current();
        },
        resetChoice: () => {
          choiceResetRef.current();
        },
      });
    }
    if (
      activeCompanyId === null ||
      sessionUserId === null ||
      apiClient === null
    ) {
      setHydrateBusy(false);
      return;
    }
    const epoch = companyEpochRef.current;
    let cancelled = false;
    setHydrateBusy(true);
    const client = apiClient;
    void resumeOwnAssistantConversation({
      companyEpochRef,
      epoch,
      sessionUserId,
      listConversations: (input) =>
        client.client.assistant.listConversations(input),
      getConversation: (input) =>
        client.client.assistant.getConversation(input),
      getOrder: async (orderId) => {
        try {
          return await client.client.orders.get({ orderId });
        } catch {
          return null;
        }
      },
      peekChoice: async ({ conversationId, choiceId }) => {
        if (apiUrl === null) {
          return undefined;
        }
        const peeked = await peekAssistantChoice({
          apiUrl,
          getCookie: () => cookieRef.current(),
          getCompanyId: () => companyIdRef.current,
          conversationId,
          choiceId,
        });
        if (peeked.kind !== "envelope") {
          return undefined;
        }
        return peeked.envelope;
      },
    })
      .then((result) => {
        if (cancelled || companyEpochRef.current !== epoch) {
          return;
        }
        if (result.kind === "unavailable") {
          conversationIdRef.current = result.conversationId;
          return;
        }
        if (result.kind !== "resumed") {
          return;
        }
        conversationIdRef.current = result.conversationId;
        setMessagesRef.current(
          result.messages.map((message) => ({
            id: message.id,
            role: message.role,
            parts: [...message.parts],
          })),
        );
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled && companyEpochRef.current === epoch) {
          setHydrateBusy(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeCompanyId, apiClient, apiUrl, sessionUserId, setMessages]);

  const send = useCallback(() => {
    const text = clipAssistantInput(input);
    if (text.length === 0 || sendBusy) {
      return;
    }
    const epoch = companyEpochRef.current;
    setInput("");
    clearError();
    void (async () => {
      try {
        await sendEnsuredAssistantMessage({
          conversationIdRef,
          companyEpochRef,
          create: () => createConversation.submit({}),
          sendMessage: (payload) => sendMessage(payload),
          text,
        });
      } catch {
        if (companyEpochRef.current === epoch) {
          setInput(text);
        }
      }
    })();
  }, [clearError, createConversation, input, sendBusy, sendMessage]);

  const createErrorKind = createConversation.isError
    ? queryFailureToAssistantKind(
        describeQueryFailure(createConversation.error).kind,
      )
    : null;

  return {
    ready: apiClient !== null && activeCompanyId !== null && apiUrl !== null,
    messages: presenterMessages,
    status,
    error,
    input,
    changeInput: setInput,
    send,
    resume,
    sendBusy,
    thinking: busy || hydrateBusy,
    canSend:
      clipAssistantInput(input).length > 0 &&
      !sendBusy &&
      apiClient !== null &&
      activeCompanyId !== null &&
      apiUrl !== null,
    createErrorKind,
    confirmationResetRef,
    choiceResetRef,
    companyEpochRef,
    postChoice,
    appendAssistantParts,
  };
}
