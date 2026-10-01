import type { ActionPrincipal, ActionRisk } from "./types.js";

const HUMAN_PRINCIPALS: ReadonlySet<ActionPrincipal> = new Set([
  "staff",
  "customer",
  "account",
]);

export const CONFIRMABLE_RISKS: readonly ActionRisk[] = ["write", "high"];

export interface ConfirmationSubject {
  readonly principal: ActionPrincipal;
  readonly idempotent: boolean;
  readonly risk: ActionRisk;
}

export function isHumanPrincipal(principal: ActionPrincipal): boolean {
  return HUMAN_PRINCIPALS.has(principal);
}

export function confirmationPreconditionProblems(
  subject: ConfirmationSubject,
  flag: string,
  allowedRisks?: readonly ActionRisk[],
): string[] {
  const problems: string[] = [];
  if (allowedRisks !== undefined && !allowedRisks.includes(subject.risk)) {
    problems.push(
      `${flag} applies to risk ${allowedRisks.join(" and ")} actions only — risk is "${subject.risk}"`,
    );
  }
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
