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
  readonly armConfirm: (card: ConfirmationCardView) => void;
  readonly choose: (choice: ConfirmDialogChoice) => void;
  readonly clearCard: () => void;
};

export function createConfirmationCardMachine(args: {
  readonly onState: (state: ConfirmationCardState) => void;
}): ConfirmationCardMachine {
  let settle: ((choice: ConfirmDialogChoice) => void) | null = null;
  let state = CLOSED_CONFIRMATION_CARD;
  let confirmArmed = false;

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
      confirmArmed = false;
      emit({ open: true, card });
      return new Promise<ConfirmDialogChoice>((resolve) => {
        settle = resolve;
      });
    },
    armConfirm: (card) => {
      if (!state.open || state.card !== card) {
        return;
      }
      confirmArmed = true;
    },
    choose: (choice) => {
      if (choice === "confirm" && !confirmArmed) {
        return;
      }
      const pending = takeSettle();
      confirmArmed = false;
      emit({ open: false, card: state.card });
      pending?.(choice);
    },
    clearCard: () => {
      if (state.open) {
        return;
      }
      emit({ open: false, card: null });
    },
  };
}
