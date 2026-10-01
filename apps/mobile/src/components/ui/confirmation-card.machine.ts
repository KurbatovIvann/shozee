import type { ConfirmDialogChoice } from "./confirm-dialog";
import type { ConfirmationCardView } from "./confirmation-card.model";

export type ConfirmationCardState = {
  readonly open: boolean;
  readonly card: ConfirmationCardView | null;
};

export const CLOSED_CONFIRMATION_CARD: ConfirmationCardState = {
  open: false,
  card: null,
};

export type ConfirmationCardMachine = {
  readonly present: (
    card: ConfirmationCardView,
  ) => Promise<ConfirmDialogChoice>;
  readonly choose: (choice: ConfirmDialogChoice) => void;
  readonly clearCard: () => void;
};

export function createConfirmationCardMachine(args: {
  readonly onState: (state: ConfirmationCardState) => void;
}): ConfirmationCardMachine {
  let settle: ((choice: ConfirmDialogChoice) => void) | null = null;
  let state = CLOSED_CONFIRMATION_CARD;

  function emit(next: ConfirmationCardState): void {
    state = next;
    args.onState(next);
  }

  function takeSettle(): ((choice: ConfirmDialogChoice) => void) | null {
    const pending = settle;
    settle = null;
    return pending;
  }

  return {
    present: (card) => {
      takeSettle()?.("cancel");
      emit({ open: true, card });
      return new Promise<ConfirmDialogChoice>((resolve) => {
        settle = resolve;
      });
    },
    choose: (choice) => {
      const pending = takeSettle();
      emit({ open: false, card: state.card });
      pending?.(choice);
    },
    clearCard: () => {
      emit({ open: state.open, card: null });
    },
  };
}
