import type { ConfirmDialogChoice } from "./confirm-dialog";
import type { ConfirmationCardView } from "./confirmation-card.model";

export type ConfirmationCardState = {
  readonly open: boolean;
  readonly card: ConfirmationCardView | null;
  readonly presentationId: number;
  readonly confirmArmed: boolean;
};

export const CLOSED_CONFIRMATION_CARD: ConfirmationCardState = {
  open: false,
  card: null,
  presentationId: 0,
  confirmArmed: false,
};

export type CancelConfirmArm = () => void;

export type ScheduleConfirmArm = (
  arm: () => void,
  delayMs: number,
) => CancelConfirmArm;

export const scheduleConfirmArmWithTimeout: ScheduleConfirmArm = (
  arm,
  delayMs,
) => {
  const timer = setTimeout(arm, delayMs);
  return () => {
    clearTimeout(timer);
  };
};

export type ConfirmationCardMachine = {
  readonly present: (
    card: ConfirmationCardView,
  ) => Promise<ConfirmDialogChoice>;
  readonly armConfirm: (presentationId: number) => void;
  readonly choose: (choice: ConfirmDialogChoice) => void;
  readonly clearCard: () => void;
};

export function createConfirmationCardMachine(args: {
  readonly onState: (state: ConfirmationCardState) => void;
  readonly armDelayMs: number;
  readonly schedule: ScheduleConfirmArm;
}): ConfirmationCardMachine {
  let settle: ((choice: ConfirmDialogChoice) => void) | null = null;
  let state = CLOSED_CONFIRMATION_CARD;
  let presentations = 0;
  let cancelArm: CancelConfirmArm | null = null;

  function emit(next: ConfirmationCardState): void {
    state = next;
    args.onState(next);
  }

  function takeSettle(): ((choice: ConfirmDialogChoice) => void) | null {
    const pending = settle;
    settle = null;
    return pending;
  }

  function cancelPendingArm(): void {
    cancelArm?.();
    cancelArm = null;
  }

  function armConfirm(presentationId: number): void {
    if (!state.open || state.presentationId !== presentationId) {
      return;
    }
    emit({ ...state, confirmArmed: true });
  }

  return {
    present: (card) => {
      takeSettle()?.("cancel");
      cancelPendingArm();
      presentations += 1;
      const presentationId = presentations;
      emit({ open: true, card, presentationId, confirmArmed: false });
      cancelArm = args.schedule(() => {
        armConfirm(presentationId);
      }, args.armDelayMs);
      return new Promise<ConfirmDialogChoice>((resolve) => {
        settle = resolve;
      });
    },
    armConfirm,
    choose: (choice) => {
      if (choice === "confirm" && !state.confirmArmed) {
        return;
      }
      cancelPendingArm();
      const pending = takeSettle();
      emit({
        open: false,
        card: state.card,
        presentationId: state.presentationId,
        confirmArmed: false,
      });
      pending?.(choice);
    },
    clearCard: () => {
      if (state.open) {
        return;
      }
      cancelPendingArm();
      emit(CLOSED_CONFIRMATION_CARD);
    },
  };
}
