/**
 * Tenant chat session helpers for the staff assistant. Company id is a
 * selector, never action input. Switching companies must not reuse the
 * previous conversation id or messages.
 */

import {
  applyOpenPendingToHydratedMessages,
  choiceIdsFromToolRuns,
  entityResultIdsFromToolRuns,
  findOwnConversationId,
  hydratedUiMessagesFromConversation,
  loadChoiceEnvelopes,
  loadOrdersById,
  type AssistantConversationDetail,
  type AssistantListConversationsInput,
  type AssistantListConversationsPage,
  type AssistantResumeResult,
} from "./assistant-hydrate";
import type { StaffAssistantChoiceCardEnvelope } from "./choice";
import type { PublicPending } from "./resume-envelope";

export type AssistantCompanyEpochRef = { current: number };
export type AssistantConversationIdRef = { current: string | null };
export type {
  AssistantResumeResult,
  HydratedAssistantUiMessage,
} from "./assistant-hydrate";

export function isCurrentAssistantEpoch(
  companyEpochRef: AssistantCompanyEpochRef,
  epoch: number,
): boolean {
  return companyEpochRef.current === epoch;
}

/**
 * Drop a late POST /assistant/choice result when the company epoch moved
 * or `reset()` cleared the in-flight lock. Same epoch used by hydrate/send.
 */
export function isCurrentAssistantChoiceSelect(args: {
  readonly companyEpochRef: AssistantCompanyEpochRef;
  readonly epoch: number;
  readonly resolvingRef: { readonly current: string | null };
  readonly challengeId: string;
}): boolean {
  return (
    isCurrentAssistantEpoch(args.companyEpochRef, args.epoch) &&
    args.resolvingRef.current === args.challengeId
  );
}

export async function ensureAssistantConversation(args: {
  readonly conversationIdRef: AssistantConversationIdRef;
  readonly companyEpochRef: AssistantCompanyEpochRef;
  readonly epoch: number;
  readonly create: () => Promise<{ readonly id: string }>;
}): Promise<string | null> {
  const existing = args.conversationIdRef.current;
  if (existing !== null) {
    return isCurrentAssistantEpoch(args.companyEpochRef, args.epoch)
      ? existing
      : null;
  }
  const created = await args.create();
  if (!isCurrentAssistantEpoch(args.companyEpochRef, args.epoch)) {
    return null;
  }
  args.conversationIdRef.current = created.id;
  return created.id;
}

export async function sendEnsuredAssistantMessage(args: {
  readonly conversationIdRef: AssistantConversationIdRef;
  readonly companyEpochRef: AssistantCompanyEpochRef;
  readonly create: () => Promise<{ readonly id: string }>;
  readonly sendMessage: (payload: { readonly text: string }) => Promise<void>;
  readonly text: string;
}): Promise<"sent" | "dropped"> {
  const epoch = args.companyEpochRef.current;
  const conversationId = await ensureAssistantConversation({
    conversationIdRef: args.conversationIdRef,
    companyEpochRef: args.companyEpochRef,
    epoch,
    create: args.create,
  });
  if (
    conversationId === null ||
    !isCurrentAssistantEpoch(args.companyEpochRef, epoch)
  ) {
    return "dropped";
  }
  await args.sendMessage({ text: args.text });
  return "sent";
}

export function resetAssistantTenantSession(args: {
  readonly conversationIdRef: AssistantConversationIdRef;
  readonly setMessages: (messages: []) => void;
  readonly resetConfirmation: () => void;
  readonly resetChoice: () => void;
}): void {
  args.conversationIdRef.current = null;
  args.setMessages([]);
  args.resetConfirmation();
  args.resetChoice();
}

/**
 * Resume the signed-in user's own thread in the active company, or leave
 * the sheet empty. Does not create a conversation and does not open a
 * colleague's newest item.
 */
export async function resumeOwnAssistantConversation(args: {
  readonly companyEpochRef: AssistantCompanyEpochRef;
  readonly epoch: number;
  readonly sessionUserId: string;
  readonly listConversations: (
    input: AssistantListConversationsInput,
  ) => Promise<AssistantListConversationsPage>;
  readonly getConversation: (input: {
    readonly conversationId: string;
  }) => Promise<AssistantConversationDetail>;
  readonly getOrder: (orderId: string) => Promise<unknown>;
  readonly peekChoice?: (input: {
    readonly conversationId: string;
    readonly choiceId: string;
  }) => Promise<StaffAssistantChoiceCardEnvelope | undefined>;
  readonly peekPending?: (input: {
    readonly conversationId: string;
  }) => Promise<
    | { readonly kind: "ok"; readonly pending: PublicPending | null }
    | { readonly kind: "unavailable" }
  >;
}): Promise<AssistantResumeResult> {
  if (!isCurrentAssistantEpoch(args.companyEpochRef, args.epoch)) {
    return { kind: "dropped" };
  }
  const conversationId = await findOwnConversationId({
    sessionUserId: args.sessionUserId,
    listConversations: args.listConversations,
  });
  if (!isCurrentAssistantEpoch(args.companyEpochRef, args.epoch)) {
    return { kind: "dropped" };
  }
  if (conversationId === null) {
    return { kind: "empty" };
  }
  let detail: AssistantConversationDetail;
  try {
    detail = await args.getConversation({ conversationId });
  } catch {
    if (!isCurrentAssistantEpoch(args.companyEpochRef, args.epoch)) {
      return { kind: "dropped" };
    }
    return { kind: "unavailable", conversationId };
  }
  if (!isCurrentAssistantEpoch(args.companyEpochRef, args.epoch)) {
    return { kind: "dropped" };
  }
  if (detail.userId !== args.sessionUserId) {
    return { kind: "empty" };
  }
  const orderIds = entityResultIdsFromToolRuns(detail.toolRuns);
  const ordersById = await loadOrdersById({
    orderIds,
    getOrder: args.getOrder,
  });
  if (!isCurrentAssistantEpoch(args.companyEpochRef, args.epoch)) {
    return { kind: "dropped" };
  }
  let choiceEnvelopes:
    ReadonlyMap<string, StaffAssistantChoiceCardEnvelope> | undefined;
  let openPending: PublicPending | null = null;
  let pendingLookup: "ok" | "unavailable" | "skipped" = "skipped";
  if (args.peekPending !== undefined) {
    const peekedPending = await args.peekPending({
      conversationId: detail.id,
    });
    if (!isCurrentAssistantEpoch(args.companyEpochRef, args.epoch)) {
      return { kind: "dropped" };
    }
    if (peekedPending.kind === "ok") {
      pendingLookup = "ok";
      openPending = peekedPending.pending;
    } else {
      pendingLookup = "unavailable";
    }
  }
  if (pendingLookup === "ok" && openPending?.kind === "choice") {
    choiceEnvelopes = new Map([[openPending.id, openPending.envelope]]);
  } else if (pendingLookup !== "ok" && args.peekChoice !== undefined) {
    const peekChoice = args.peekChoice;
    const conversationIdForPeek = detail.id;
    choiceEnvelopes = await loadChoiceEnvelopes({
      choiceIds: choiceIdsFromToolRuns(detail.toolRuns),
      peekChoice: (choiceId) =>
        peekChoice({
          conversationId: conversationIdForPeek,
          choiceId,
        }),
    });
    if (!isCurrentAssistantEpoch(args.companyEpochRef, args.epoch)) {
      return { kind: "dropped" };
    }
  }
  const hydrated = hydratedUiMessagesFromConversation({
    messages: detail.messages,
    toolRuns: detail.toolRuns,
    ordersById,
    ...(choiceEnvelopes !== undefined ? { choiceEnvelopes } : {}),
  });
  const messages =
    pendingLookup === "ok"
      ? applyOpenPendingToHydratedMessages({
          messages: hydrated,
          pending: openPending,
        })
      : hydrated;
  return {
    kind: "resumed",
    conversationId: detail.id,
    messages,
    pending: pendingLookup === "ok" ? openPending : null,
  };
}
