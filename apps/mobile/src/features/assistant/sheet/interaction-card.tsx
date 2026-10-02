/**
 * The card for an open question, whichever kind it is.
 *
 * It renders what the question says and nothing else. The card it replaces took
 * the wire envelope and called three presenter functions to work out whether the
 * picker was still tappable, which option to offer as a retry, and whether a
 * `claimed` or `expired` status should show a note instead — protocol reasoning
 * inside a component, needed because the client had to guess what the server had
 * already done with a tap.
 *
 * None of that has a place here. A question that appears is answerable, because
 * the only source of one is the server's open pause; a question that has been
 * answered, dropped or expired simply is not in the window. A refused tap comes
 * back with the current question, so there is no retry state to hold either.
 */
import type { AssistantInteraction } from "@showzy/validation/assistant-chat";

import { assistantChoiceAnswer } from "../shared/choice-answer";
import { ChoiceCard } from "./choice-card";
import type { AssistantChoiceCardCopy } from "./choice-card-model";
import { PreviewCard } from "./preview-card";
import type { AssistantPreviewCardCopy } from "./preview-card-model";

export type InteractionCardCopy = AssistantChoiceCardCopy &
  AssistantPreviewCardCopy;

export function InteractionCard(props: {
  readonly interaction: AssistantInteraction;
  /** A request is in flight. The same flag for every card: only one can run. */
  readonly applying: boolean;
  readonly pendingOptionId: string | null;
  readonly copy: InteractionCardCopy;
  /** The shape belongs to the kind; the server checks it against that kind. */
  readonly onAnswer: (answer: unknown) => void;
  readonly onCompose: () => void;
  readonly onDismiss: () => void;
}) {
  const { interaction, copy } = props;

  if (interaction.kind === "confirmation") {
    return (
      <PreviewCard
        summary={interaction.summary}
        preview={interaction.preview}
        also={interaction.also}
        level={interaction.level}
        copy={copy}
        applying={props.applying}
        onConfirm={() => {
          // The only answer this kind has. Saying no is dropping the question.
          props.onAnswer({ approved: true });
        }}
        onDismiss={props.onDismiss}
      />
    );
  }

  return (
    <ChoiceCard
      interaction={interaction}
      applying={props.applying}
      answeredOptionId={props.pendingOptionId}
      copy={copy}
      onPick={(optionId) => {
        props.onAnswer(assistantChoiceAnswer(optionId));
      }}
      onCompose={props.onCompose}
      onDismiss={props.onDismiss}
    />
  );
}
