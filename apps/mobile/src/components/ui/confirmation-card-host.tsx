import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { PresentConfirmationChallenge } from "../../api/protocol-confirm";
import { confirmationCardEn, confirmationCardUk } from "../../i18n/copy";
import { detectLocale } from "../../i18n/locale";
import type { ConfirmDialogChoice } from "./confirm-dialog";
import { ConfirmationCard } from "./confirmation-card";
import {
  confirmationCardView,
  type ConfirmationCardView,
} from "./confirmation-card.model";

const ConfirmationCardContext =
  createContext<PresentConfirmationChallenge | null>(null);

type Settle = (choice: ConfirmDialogChoice) => void;

export function ConfirmationCardProvider(props: {
  readonly children: ReactNode;
}) {
  const copy =
    detectLocale() === "uk" ? confirmationCardUk : confirmationCardEn;
  const settleRef = useRef<Settle | null>(null);
  const [open, setOpen] = useState(false);
  const [card, setCard] = useState<ConfirmationCardView | null>(null);

  const present = useCallback<PresentConfirmationChallenge>(
    (challenge) => {
      settleRef.current?.("cancel");
      setCard(confirmationCardView(challenge, copy.fallbackTitle));
      setOpen(true);
      return new Promise<ConfirmDialogChoice>((resolve) => {
        settleRef.current = resolve;
      });
    },
    [copy.fallbackTitle],
  );

  const choose = useCallback((choice: ConfirmDialogChoice) => {
    const settle = settleRef.current;
    settleRef.current = null;
    setOpen(false);
    settle?.(choice);
  }, []);

  const clearCard = useCallback(() => {
    setCard(null);
  }, []);

  return (
    <ConfirmationCardContext.Provider value={present}>
      {props.children}
      <ConfirmationCard
        visible={open}
        view={card}
        copy={copy}
        onChoice={choose}
        onHidden={clearCard}
      />
    </ConfirmationCardContext.Provider>
  );
}

export function useConfirmationCard(): PresentConfirmationChallenge {
  const present = useContext(ConfirmationCardContext);
  if (present === null) {
    throw new TypeError("ConfirmationCardProvider is missing");
  }
  return present;
}
