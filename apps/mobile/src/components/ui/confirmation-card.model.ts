import type { ConfirmationChallengeView } from "../../api/protocol-confirm";

export type ConfirmationCardLine = {
  readonly label: string;
  readonly value: string;
};

export type ConfirmationCardView = {
  readonly title: string;
  readonly lines: readonly ConfirmationCardLine[];
  readonly notes: readonly string[];
  readonly summary: string | null;
};

export function confirmationCardView(
  challenge: ConfirmationChallengeView,
  fallbackTitle: string,
): ConfirmationCardView {
  const preview = challenge.preview;
  if (preview === undefined) {
    return {
      title: fallbackTitle,
      lines: [],
      notes: [],
      summary: challenge.summary.length > 0 ? challenge.summary : null,
    };
  }
  return {
    title: preview.title.length > 0 ? preview.title : fallbackTitle,
    lines: preview.lines,
    notes: preview.notes ?? [],
    summary: null,
  };
}
