import type { ConfirmationChallengeView } from "../../api/protocol-confirm";
import type { ConfirmDialogTone } from "./confirm-dialog";

export type ConfirmationCardLine = {
  readonly label: string;
  readonly value: string;
};

export type ConfirmationCardView = {
  readonly title: string;
  readonly lines: readonly ConfirmationCardLine[];
  readonly notes: readonly string[];
  readonly summary: string | null;
  readonly tone: ConfirmDialogTone;
};

function confirmationCardTone(
  challenge: ConfirmationChallengeView,
): ConfirmDialogTone {
  return challenge.risk === "high" ? "danger" : "default";
}

export function confirmationCardView(
  challenge: ConfirmationChallengeView,
  fallbackTitle: string,
): ConfirmationCardView {
  const preview = challenge.preview;
  const tone = confirmationCardTone(challenge);
  if (preview === undefined) {
    return {
      title: fallbackTitle,
      lines: [],
      notes: [],
      summary: challenge.summary.length > 0 ? challenge.summary : null,
      tone,
    };
  }
  return {
    title: preview.title.length > 0 ? preview.title : fallbackTitle,
    lines: preview.lines,
    notes: preview.notes ?? [],
    summary: null,
    tone,
  };
}
