import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useApiClient } from "../../../api/api-provider";
import { apiUrlFromEnv } from "../../../api/config";
import { describeQueryFailure } from "../../../api/errors";
import { useActiveCompany } from "../../../api/query-provider";
import { useBoundContractMutation } from "../../../api/use-bound-contract-mutation";
import { useAuthSession } from "../../../auth/session-provider";
import { detectLocale } from "../../../i18n/locale";
import { clipAssistantInput } from "../api/assistant-chat-body";
import { postAssistantChoice } from "../api/assistant-choice";
import {
  getAssistantPending,
  postAssistantChat,
  postAssistantConfirm,
  postAssistantPendingAbandon,
} from "../api/assistant-pending";
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
import {
  partsFromResumeEnvelope,
  type AssistantHostInteractionResult,
} from "../shared/resume-envelope";
import type { AssistantChatStatus } from "./use-assistant-confirmation";

function resolveApiUrl(): string | null {
  try {
    return apiUrlFromEnv();
  } catch {
    return null;
  }
}

function errorFromHostResult(
  result: Extract<AssistantHostInteractionResult, { status: "error" }>,
): Error {
  return new Error(
    JSON.stringify({
      code: result.code,
      message: result.message,
    }),
  );
}

export function useAssistantChat(): {
  readonly ready: boolean;
  readonly messages: readonly AssistantChatMessage[];
  readonly status: AssistantChatStatus;
  readonly error: unknown;
  readonly input: string;
  readonly changeInput: (value: string) => void;
  readonly send: () => void;
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
  readonly getConversationId: () => string | null;
  readonly peekPending: () => Promise<
    | {
        readonly kind: "ok";
        readonly pending: {
          readonly id: string;
          readonly version: number;
          readonly kind: "choice" | "confirmation";
        } | null;
      }
    | { readonly kind: "unavailable" }
  >;
  readonly postConfirm: (input: {
    readonly conversationId: string;
    readonly challengeId: string;
  }) => Promise<AssistantHostInteractionResult>;
  readonly postAbandon: (input: {
    readonly conversationId: string;
    readonly pendingId: string;
    readonly expectedVersion: number;
  }) => Promise<AssistantHostInteractionResult>;
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
  const [messages, setMessages] = useState<AssistantChatMessage[]>([]);
  const [status, setStatus] = useState<AssistantChatStatus>("ready");
  const [error, setError] = useState<unknown>(undefined);

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

  const getConversationId = useCallback(() => conversationIdRef.current, []);

  const clearError = useCallback(() => {
    setError(undefined);
  }, []);

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
    [],
  );

  const applyHostResult = useCallback(
    (result: AssistantHostInteractionResult) => {
      if (result.status === "ok") {
        const parts = partsFromResumeEnvelope({
          speech: result.speech,
          cards: result.cards,
          pending: result.pending,
        });
        if (parts.length > 0) {
          appendAssistantParts(parts);
        }
        setStatus("ready");
        return;
      }
      if (result.status === "expired") {
        setError(
          new Error(
            JSON.stringify({
              code: "NOT_FOUND",
              message: "Turn expired.",
            }),
          ),
        );
        setStatus("error");
        return;
      }
      setError(errorFromHostResult(result));
      setStatus("error");
    },
    [appendAssistantParts],
  );

  const peekPending = useCallback(async () => {
    const conversationId = conversationIdRef.current;
    if (conversationId === null || apiUrl === null) {
      return { kind: "unavailable" as const };
    }
    return getAssistantPending({
      apiUrl,
      getCookie: () => cookieRef.current(),
      getCompanyId: () => companyIdRef.current,
      conversationId,
    });
  }, [apiUrl]);

  const postConfirm = useCallback(
    (input: {
      readonly conversationId: string;
      readonly challengeId: string;
    }) => {
      if (apiUrl === null) {
        return Promise.resolve({
          status: "error" as const,
          code: "NETWORK",
          message: "Confirm request failed.",
        });
      }
      return postAssistantConfirm({
        apiUrl,
        getCookie: () => cookieRef.current(),
        getCompanyId: () => companyIdRef.current,
        conversationId: input.conversationId,
        challengeId: input.challengeId,
      });
    },
    [apiUrl],
  );

  const postAbandon = useCallback(
    (input: {
      readonly conversationId: string;
      readonly pendingId: string;
      readonly expectedVersion: number;
    }) => {
      if (apiUrl === null) {
        return Promise.resolve({
          status: "error" as const,
          code: "NETWORK",
          message: "Abandon request failed.",
        });
      }
      return postAssistantPendingAbandon({
        apiUrl,
        getCookie: () => cookieRef.current(),
        getCompanyId: () => companyIdRef.current,
        conversationId: input.conversationId,
        pendingId: input.pendingId,
        expectedVersion: input.expectedVersion,
      });
    },
    [apiUrl],
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
      peekPending: async ({ conversationId }) => {
        if (apiUrl === null) {
          return { kind: "unavailable" };
        }
        return getAssistantPending({
          apiUrl,
          getCookie: () => cookieRef.current(),
          getCompanyId: () => companyIdRef.current,
          conversationId,
        });
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
        setMessages(
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
  }, [activeCompanyId, apiClient, apiUrl, sessionUserId]);

  const sendBusy =
    status === "submitted" ||
    status === "streaming" ||
    createConversation.isPending ||
    hydrateBusy;

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
          sendMessage: async (payload) => {
            const conversationId = conversationIdRef.current;
            if (conversationId === null || apiUrl === null) {
              return;
            }
            setMessages((current) => [
              ...current,
              {
                id: crypto.randomUUID(),
                role: "user",
                parts: [{ type: "text", text: payload.text }],
              },
            ]);
            setStatus("submitted");
            const result = await postAssistantChat({
              apiUrl,
              getCookie: () => cookieRef.current(),
              getCompanyId: () => companyIdRef.current,
              conversationId,
              text: payload.text,
              locale: detectLocale(),
            });
            applyHostResult(result);
          },
          text,
        });
      } catch {
        if (companyEpochRef.current === epoch) {
          setInput(text);
          setStatus("ready");
        }
      }
    })();
  }, [
    apiUrl,
    applyHostResult,
    clearError,
    createConversation,
    input,
    sendBusy,
  ]);

  const createErrorKind = createConversation.isError
    ? queryFailureToAssistantKind(
        describeQueryFailure(createConversation.error).kind,
      )
    : null;

  return {
    ready: apiClient !== null && activeCompanyId !== null && apiUrl !== null,
    messages,
    status,
    error,
    input,
    changeInput: setInput,
    send,
    sendBusy,
    thinking: sendBusy || hydrateBusy,
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
    getConversationId,
    peekPending,
    postConfirm,
    postAbandon,
    postChoice,
    appendAssistantParts,
  };
}
