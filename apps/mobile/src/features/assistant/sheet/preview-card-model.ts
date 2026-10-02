import type {
  AssistantPreview,
  AssistantPreviewLevel,
  AssistantPreviewLine,
} from "@showzy/validation/assistant-chat";

export type AssistantPreviewCardCopy = {
  readonly confirmationTitle: string;
  readonly confirmLabel: string;
  readonly confirmingLabel: string;
  readonly dismissLabel: string;
  readonly previewAlso: string;
  readonly previewStrongLabel: string;
  readonly previewStrongWarning: string;
  readonly previewStrongConfirm: string;
};

export type AssistantPreviewBlock = {
  readonly key: string;
  readonly caption: string | null;
  readonly title: string;
  readonly lines: readonly AssistantPreviewLine[];
  readonly notes: readonly string[];
};

export type AssistantPreviewPrimary = {
  readonly label: string;
  readonly danger: boolean;
  readonly arms: boolean;
};

export type AssistantPreviewCardModel = {
  readonly presentationKey: string;
  readonly eyebrow: string;
  readonly strong: boolean;
  readonly warning: string | null;
  readonly title: string;
  readonly summary: string | null;
  readonly blocks: readonly AssistantPreviewBlock[];
  readonly applyingLabel: string | null;
  readonly primary: AssistantPreviewPrimary | null;
  readonly dismissLabel: string | null;
};

export function assistantPreviewPresentationKey(input: {
  readonly interactionId: string;
  readonly revision: number;
}): string {
  return `${input.interactionId}:${String(input.revision)}`;
}

export function assistantPreviewCardModel(input: {
  readonly interactionId: string;
  readonly revision: number;
  readonly summary: string;
  readonly preview: AssistantPreview;
  readonly also: readonly AssistantPreview[];
  readonly level: AssistantPreviewLevel;
  readonly applying: boolean;
  readonly armedKey: string | null;
  readonly copy: AssistantPreviewCardCopy;
}): AssistantPreviewCardModel {
  const { copy } = input;
  const presentationKey = assistantPreviewPresentationKey(input);
  const armed = input.armedKey === presentationKey;
  const strong = input.level === "strong";
  const title = input.preview.title;
  const blocks: readonly AssistantPreviewBlock[] = [
    {
      key: "preview",
      caption: null,
      title,
      lines: input.preview.lines,
      notes: input.preview.notes,
    },
    ...input.also.map((preview, index) => ({
      key: `also:${String(index)}`,
      caption: index === 0 ? copy.previewAlso : null,
      title: preview.title,
      lines: preview.lines,
      notes: preview.notes,
    })),
  ];
  return {
    presentationKey,
    eyebrow: strong ? copy.previewStrongLabel : copy.confirmationTitle,
    strong,
    warning: strong ? copy.previewStrongWarning : null,
    title,
    summary:
      input.summary.length > 0 && input.summary !== title
        ? input.summary
        : null,
    blocks,
    applyingLabel: input.applying ? copy.confirmingLabel : null,
    primary: input.applying
      ? null
      : {
          label:
            strong && armed ? copy.previewStrongConfirm : copy.confirmLabel,
          danger: strong && armed,
          arms: strong && !armed,
        },
    dismissLabel: input.applying ? null : copy.dismissLabel,
  };
}
