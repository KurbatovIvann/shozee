/**
 * Whether the thread scrolls to its end after its content changed size.
 *
 * It used to, every time. That was right while a thread only ever grew at the
 * bottom, and wrong the moment an older page could arrive at the top: the person
 * scrolled up to read it, and the list threw them back down (SHO-555).
 *
 * So the thread follows its end unless the last change put rows above what is on
 * screen and nothing has arrived at the end since. A reply, an echo or the wait
 * row changes the last row and brings the thread back down, as before; the
 * layout passes that follow an older page do not.
 */

export type AssistantThreadEdges = {
  readonly first: string | null;
  readonly last: string | null;
  /** An older page arrived above and nothing new has come at the end since. */
  readonly holding: boolean;
};

export const ASSISTANT_THREAD_START: AssistantThreadEdges = {
  first: null,
  last: null,
  holding: false,
};

export function assistantThreadFollow(
  previous: AssistantThreadEdges,
  rows: readonly { readonly id: string }[],
): { readonly edges: AssistantThreadEdges; readonly scrollToEnd: boolean } {
  const first = rows[0]?.id ?? null;
  const last = rows.at(-1)?.id ?? null;
  const holding =
    last !== previous.last
      ? false
      : previous.first !== null && first !== previous.first
        ? true
        : previous.holding;
  return { edges: { first, last, holding }, scrollToEnd: !holding };
}
