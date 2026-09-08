import { useCallback, useMemo } from "react";
import { useRouter } from "expo-router";

import { assistantCopy } from "../../../i18n/assistant";
import { detectLocale } from "../../../i18n/locale";
import {
  assistantChatErrorKind,
  assistantChatErrorMessage,
} from "../shared/chat-error";
import {
  assistantChatRows,
  assistantDisplayRows,
  assistantRowHasInFlightTools,
  assistantTurnIsWaiting,
} from "../shared/chat-rows";
import type { AssistantSheetViewModel } from "./assistant-sheet-view";
import { useAssistantChat } from "./use-assistant-chat";
import { useAssistantChoice } from "./use-assistant-choice";
import { useAssistantConfirmation } from "./use-assistant-confirmation";

export function useAssistantSheet(): AssistantSheetViewModel & {
  readonly ready: boolean;
} {
  const locale = detectLocale();
  const copy = useMemo(() => assistantCopy(locale), [locale]);
  const { push } = useRouter();
  const chat = useAssistantChat();
  const confirmation = useAssistantConfirmation({
    messages: chat.messages,
    status: chat.status,
    error: chat.error,
    sendBusy: chat.sendBusy,
    resume: chat.resume,
  });
  chat.confirmationResetRef.current = confirmation.reset;
  const choice = useAssistantChoice({
    messages: chat.messages,
    locale,
    companyEpochRef: chat.companyEpochRef,
    postChoice: chat.postChoice,
    appendParts: chat.appendAssistantParts,
  });
  chat.choiceResetRef.current = choice.reset;

  const openHref = useCallback(
    (href: string) => {
      push(href);
    },
    [push],
  );

  const pendingConfirmation =
    confirmation.card.kind === "hidden" ? null : confirmation.card.confirmation;
  const pendingChoice =
    choice.card.kind === "hidden" ? null : choice.card.choice;
  const ignoredChallengeIds = new Set(confirmation.ignoredChallengeIds);
  for (const challengeId of choice.ignoredChallengeIds) {
    ignoredChallengeIds.add(challengeId);
  }

  const mappedRows = assistantChatRows(
    chat.messages,
    pendingConfirmation,
    copy,
    ignoredChallengeIds,
    locale,
    pendingChoice,
  );
  const liveWaiting = assistantTurnIsWaiting({
    status: chat.status,
    rows: mappedRows,
  });
  const rows = assistantDisplayRows(mappedRows, liveWaiting);
  const lastMapped = mappedRows[mappedRows.length - 1];
  const hasInFlightTools =
    lastMapped !== undefined && assistantRowHasInFlightTools(lastMapped);

  const chatKind =
    chat.error !== undefined ? assistantChatErrorKind(chat.error) : null;
  const bannerKind = chat.createErrorKind ?? chatKind;
  const banner =
    bannerKind === null ? null : assistantChatErrorMessage(bannerKind, copy);

  return {
    ready: chat.ready,
    copy,
    rows,
    input: chat.input,
    changeInput: chat.changeInput,
    send: chat.send,
    confirm: confirmation.confirm,
    dismiss: confirmation.dismiss,
    selectChoice: choice.select,
    openHref,
    busy: chat.sendBusy,
    thinking: chat.thinking,
    hasInFlightTools,
    confirmationApplying: confirmation.card.kind === "applying",
    choiceApplying: choice.card.kind === "applying",
    choiceAttempted: choice.attempted,
    canSend: chat.canSend,
    banner,
  };
}
