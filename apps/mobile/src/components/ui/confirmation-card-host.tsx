import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { PresentConfirmationChallenge } from "../../api/protocol-confirm";
import type { ConfirmationCardCopy } from "../../i18n/copy";
import type { ConfirmDialogChoice } from "./confirm-dialog";
import { ConfirmationCard } from "./confirmation-card";
import {
  CLOSED_CONFIRMATION_CARD,
  createConfirmationCardMachine,
  type ConfirmationCardMachine,
  type ConfirmationCardState,
} from "./confirmation-card.machine";
import { confirmationCardView } from "./confirmation-card.model";

const ConfirmationCardContext =
  createContext<PresentConfirmationChallenge | null>(null);

export function ConfirmationCardProvider(props: {
  readonly copy: ConfirmationCardCopy;
  readonly children: ReactNode;
}) {
  const copy = props.copy;
  const fallbackTitleRef = useRef(copy.fallbackTitle);
  fallbackTitleRef.current = copy.fallbackTitle;
  const [state, setState] = useState<ConfirmationCardState>(
    CLOSED_CONFIRMATION_CARD,
  );
  const machineRef = useRef<ConfirmationCardMachine | null>(null);
  if (machineRef.current === null) {
    machineRef.current = createConfirmationCardMachine({ onState: setState });
  }
  const machine = machineRef.current;

  const present = useCallback<PresentConfirmationChallenge>(
    (challenge) =>
      machine.present(
        confirmationCardView(challenge, fallbackTitleRef.current),
      ),
    [machine],
  );

  const choose = useCallback(
    (choice: ConfirmDialogChoice) => {
      machine.choose(choice);
    },
    [machine],
  );

  const clearCard = useCallback(() => {
    machine.clearCard();
  }, [machine]);

  return (
    <ConfirmationCardContext.Provider value={present}>
      {props.children}
      <ConfirmationCard
        visible={state.open}
        view={state.card}
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
