/**
 * Classifier skip for HITL resumes only (SHO-404 / SHO-513). Confirmation
 * and choice resumes do not run the classifier. Every fresh user turn is
 * classified — `sticky_session` must not skip the gate.
 */
export type StaffAssistantGateSkipReason =
  "confirmation_resume" | "choice_resume";

export function staffAssistantShouldSkipIntentGate(options: {
  readonly confirmationResume?: boolean;
  readonly choiceResume?: boolean;
}): boolean {
  return options.confirmationResume === true || options.choiceResume === true;
}
