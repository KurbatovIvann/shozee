import { AssistantResultFrame } from "./assistant-result-frame";
import type { AssistantClosedCardModel } from "./closed-card-model";

export function ClosedCard(props: {
  readonly model: AssistantClosedCardModel;
  readonly onOpenHref: (href: string) => void;
}) {
  const { model } = props;

  return (
    <AssistantResultFrame
      pill={{ label: model.label, tone: model.tone }}
      {...(model.question === null ? {} : { title: model.question })}
      {...(model.answer === null ? {} : { subtitle: model.answer })}
      actions={model.opens.map((open) => ({
        id: open.key,
        label: open.label,
        variant: "secondary" as const,
        onPress: () => {
          props.onOpenHref(open.href);
        },
      }))}
    />
  );
}
