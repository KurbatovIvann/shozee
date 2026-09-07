/**
 * Staff-assistant choice store (SHO-409). Choice is the `choice` variant of
 * the pending-interaction protocol (ADR-0035 / SHO-516). CAS lives in
 * `pending-interaction.ts`. Never GETDEL — that stays core's confirmation
 * challenge.
 *
 * Keys are `pending:choice:{choiceId}`. Old `choice:{id}` keys expire unused.
 */
import type { ChoiceBind, ChoiceRecord } from "@showzy/ai";

import {
  bindPendingStoreBacking,
  createChoiceStoreFromPending,
  createMemoryPendingInteractionStore,
} from "./pending-interaction.js";

export type ChoiceClaimDecision =
  | { readonly kind: "claimed"; readonly record: ChoiceRecord }
  | { readonly kind: "replay"; readonly record: ChoiceRecord }
  | { readonly kind: "expired" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "conflict" }
  | { readonly kind: "invalid_option" };

export type ChoiceCompleteDecision =
  | { readonly kind: "completed"; readonly record: ChoiceRecord }
  | { readonly kind: "replay"; readonly record: ChoiceRecord }
  | { readonly kind: "expired" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "conflict" };

export type ChoicePeekDecision =
  | { readonly kind: "found"; readonly record: ChoiceRecord }
  | { readonly kind: "expired" }
  | { readonly kind: "forbidden" };

export interface StaffAssistantChoiceStore {
  open(record: ChoiceRecord): Promise<boolean>;
  claim(input: {
    readonly choiceId: string;
    readonly bind: ChoiceBind;
    readonly optionId: string;
  }): Promise<ChoiceClaimDecision>;
  peek(input: {
    readonly choiceId: string;
    readonly bind: ChoiceBind;
  }): Promise<ChoicePeekDecision>;
  complete(input: {
    readonly choiceId: string;
    readonly bind: ChoiceBind;
    readonly optionId: string;
  }): Promise<ChoiceCompleteDecision>;
}

export function createMemoryChoiceStore(options?: {
  readonly now?: () => number;
  readonly ttlMs?: number;
}): StaffAssistantChoiceStore {
  const pending = createMemoryPendingInteractionStore(options);
  const choice = createChoiceStoreFromPending(pending);
  bindPendingStoreBacking(choice, pending);
  return choice;
}
