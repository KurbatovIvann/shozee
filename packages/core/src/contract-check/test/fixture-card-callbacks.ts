import { deriveAiToolSources } from "../../contract/ai-exposure.js";
import {
  isConfirmableRisk,
  isHumanPrincipal,
} from "../../contract/confirmation-preconditions.js";
import type { ActionContract } from "../../contract/index.js";

export function previewIsRequired(contract: ActionContract): boolean {
  return (
    deriveAiToolSources([contract]).length === 1 &&
    isConfirmableRisk(contract.risk) &&
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
