import { deriveAiToolSources } from "../contract/ai-exposure.js";
import { CONFIRMABLE_RISKS } from "../contract/confirmation-preconditions.js";
import type { RegisteredImplementation } from "../runtime/action-registry.js";

export function collectWritePreviewProblems(
  implementations: readonly RegisteredImplementation[],
  problems: string[],
): void {
  const exposed = new Set(
    deriveAiToolSources(
      implementations.map((implementation) => implementation.contract),
    ).map((contract) => contract.name),
  );
  for (const implementation of implementations) {
    const { contract } = implementation;
    if (
      !exposed.has(contract.name) ||
      !CONFIRMABLE_RISKS.includes(contract.risk) ||
      implementation.preview !== undefined
    ) {
      continue;
    }
    problems.push(
      `"${contract.name}": an AI-exposed risk ${contract.risk} action must bind preview, which itself requires idempotent: true and a human principal (staff, customer, account) — the assistant shows the server's card before the write (ADR-0050)`,
    );
  }
}
