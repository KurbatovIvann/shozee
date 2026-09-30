import type { ActionPrincipal } from "./types.js";

const HUMAN_PRINCIPALS: ReadonlySet<ActionPrincipal> = new Set([
  "staff",
  "customer",
  "account",
]);

export interface ConfirmationSubject {
  readonly principal: ActionPrincipal;
  readonly idempotent: boolean;
}

export function isHumanPrincipal(principal: ActionPrincipal): boolean {
  return HUMAN_PRINCIPALS.has(principal);
}

export function confirmationPreconditionProblems(
  subject: ConfirmationSubject,
  flag: string,
): string[] {
  const problems: string[] = [];
  if (!isHumanPrincipal(subject.principal)) {
    problems.push(
      `${flag} applies to human principals (staff, customer, account) only`,
    );
  }
  if (!subject.idempotent) {
    problems.push(
      `${flag} requires idempotent: true (confirmed retries must replay safely, core.md §5)`,
    );
  }
  return problems;
}
