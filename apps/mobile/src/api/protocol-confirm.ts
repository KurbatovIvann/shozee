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

type ProtocolInvocation<T> =
  | { readonly outcome: "submitted"; readonly value: T }
  | {
      readonly outcome: "challenged";
      readonly challenge: ConfirmationChallengeView;
    };

async function invokeUntilChallenged<T>(
  invoke: () => Promise<T>,
): Promise<ProtocolInvocation<T>> {
  try {
    return { outcome: "submitted", value: await invoke() };
  } catch (error) {
    const challenge = confirmationChallenge(error);
    if (challenge === null) {
      throw error;
    }
    return { outcome: "challenged", challenge };
  }
}

export async function submitWithProtocolConfirmation<T>(args: {
  readonly submit: () => Promise<T>;
  readonly present: PresentConfirmationChallenge;
  readonly confirm: (challengeId: string) => Promise<T>;
}): Promise<ProtocolConfirmationResult<T>> {
  let invocation = await invokeUntilChallenged(args.submit);
  while (invocation.outcome === "challenged") {
    const { challengeId } = invocation.challenge;
    const choice = await args.present(invocation.challenge);
    if (choice === "cancel") {
      return { outcome: "declined" };
    }
    invocation = await invokeUntilChallenged(() => args.confirm(challengeId));
  }
  return invocation;
}
