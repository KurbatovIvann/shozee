import type { AssistantThreadRow } from "../thread/thread-rows";

export type AssistantThreadFocus = {
  readonly openCardKey: string | null;
};

export const ASSISTANT_THREAD_FOCUS_START: AssistantThreadFocus = {
  openCardKey: null,
};

export type AssistantFocusMove =
  | { readonly kind: "card"; readonly index: number }
  | { readonly kind: "composer" }
  | { readonly kind: "none" };

function openCard(
  rows: readonly AssistantThreadRow[],
): { readonly key: string; readonly index: number } | null {
  for (const [index, row] of rows.entries()) {
    const interaction = row.interaction;
    if (interaction !== null) {
      return {
        key: `${interaction.interactionId}:${String(interaction.revision)}`,
        index,
      };
    }
  }
  return null;
}

export function assistantThreadFocus(
  previous: AssistantThreadFocus,
  rows: readonly AssistantThreadRow[],
): { readonly focus: AssistantThreadFocus; readonly move: AssistantFocusMove } {
  const card = openCard(rows);
  const focus = { openCardKey: card?.key ?? null };
  if (rows.length === 0) {
    return { focus, move: { kind: "none" } };
  }
  if (card !== null) {
    return {
      focus,
      move:
        card.key === previous.openCardKey
          ? { kind: "none" }
          : { kind: "card", index: card.index },
    };
  }
  return {
    focus,
    move:
      previous.openCardKey === null ? { kind: "none" } : { kind: "composer" },
  };
}
