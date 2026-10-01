import type { WireActionPreview } from "@showzy/contract";

import type { ConfirmDialogChoice } from "../components/ui/confirm-dialog";
import { describeWireError } from "./errors";

export type ConfirmationChallengeView = {
  readonly challengeId: string;
  readonly summary: string;
  readonly preview?: WireActionPreview;
};

export type PresentConfirmationChallenge = (
  challenge: ConfirmationChallengeView,
) => Promise<ConfirmDialogChoice>;

export type ProtocolConfirmationResult<T> =
  | { readonly outcome: "submitted"; readonly value: T }
  | { readonly outcome: "declined" };

export function confirmationChallenge(
  error: unknown,
): ConfirmationChallengeView | null {
  const view = describeWireError(error);
  if (
    view === null ||
    view.code !== "CONFIRMATION_REQUIRED" ||
    view.challengeId === undefined
  ) {
    return null;
  }
  return {
    challengeId: view.challengeId,
    summary: view.summary ?? "",
    ...(view.preview === undefined ? {} : { preview: view.preview }),
  };
}

export async function submitWithProtocolConfirmation<T>(args: {
  readonly submit: () => Promise<T>;
  readonly present: PresentConfirmationChallenge;
  readonly confirm: (challengeId: string) => Promise<T>;
}): Promise<ProtocolConfirmationResult<T>> {
  let challenge: ConfirmationChallengeView;
  try {
    return { outcome: "submitted", value: await args.submit() };
  } catch (error) {
    const pending = confirmationChallenge(error);
    if (pending === null) {
      throw error;
    }
    challenge = pending;
  }
  const choice = await args.present(challenge);
  if (choice === "cancel") {
    return { outcome: "declined" };
  }
  return {
    outcome: "submitted",
    value: await args.confirm(challenge.challengeId),
  };
}
