import { deriveAiToolSources } from "../../contract/ai-exposure.js";
import {
  CONFIRMABLE_RISKS,
  isHumanPrincipal,
} from "../../contract/confirmation-preconditions.js";
import type { ActionContract } from "../../contract/index.js";

export function previewIsRequired(contract: ActionContract): boolean {
  return (
    deriveAiToolSources([contract]).length === 1 &&
    CONFIRMABLE_RISKS.includes(contract.risk) &&
    contract.idempotent &&
    isHumanPrincipal(contract.principal)
  );
}

export function fixtureCardCallbacks(contract: ActionContract) {
  if (previewIsRequired(contract)) {
    return { preview: () => ({ title: "Fixture card", lines: [] }) };
  }
  return contract.requiresConfirmation
    ? { confirmationSummary: () => "fixture summary" }
    : {};
}
