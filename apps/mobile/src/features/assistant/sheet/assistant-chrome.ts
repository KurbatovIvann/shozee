/**
 * Conversation chrome predicates (SHO-392). Sit when idle; dig when the
 * turn is thinking or a tool is in flight. Composer send is hidden until
 * there is text (canvas v35). Talk / dictation poses stay out of scope.
 */

export type AssistantShozikPose = "sit" | "dig";

/** Canvas `ShozikAvatar` header size. Optical, not a hit target. */
export const SHOZIK_HEADER_POSE_SIZE = 40;

/** Canvas first-run sit pose. Optical, not a shared hit token. */
export const SHOZIK_EMPTY_POSE_SIZE = 72;

/** Dig pose in the in-thread wait chip. Optical, not a hit target. */
export const SHOZIK_WAIT_POSE_SIZE = 32;

/**
 * One input, not two. `hasInFlightTools` existed alongside `thinking` because the
 * old path streamed a tool timeline and could be mid-turn without being mid-
 * request. The stored log holds only settled messages, so "a request is in
 * flight" is the whole of it.
 */
export function assistantShozikPose(input: {
  readonly thinking: boolean;
}): AssistantShozikPose {
  return input.thinking ? "dig" : "sit";
}

export function assistantComposerSendVisible(input: string): boolean {
  return input.trim().length > 0;
}

export type AssistantExampleChip = {
  readonly key: string;
  readonly text: string;
};

export function assistantExampleChips(input: {
  readonly examples: readonly string[];
  readonly busy: boolean;
}): readonly AssistantExampleChip[] {
  if (input.busy) {
    return [];
  }
  const seen = new Set<string>();
  const chips: AssistantExampleChip[] = [];
  for (const example of input.examples) {
    const text = example.trim();
    if (text.length === 0 || seen.has(text)) {
      continue;
    }
    seen.add(text);
    chips.push({ key: text, text });
  }
  return chips;
}

export type AssistantReplyTone = "reply" | "clarify" | "error";

export function assistantReplyTone(input: {
  readonly failed: boolean;
  readonly hasOpenQuestion: boolean;
}): AssistantReplyTone {
  if (input.failed) {
    return "error";
  }
  return input.hasOpenQuestion ? "clarify" : "reply";
}
