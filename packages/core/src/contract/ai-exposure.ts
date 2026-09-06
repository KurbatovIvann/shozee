/**
 * The AI tool-manifest *source* (contract.md §2): which descriptors may
 * become AI tools at all, and which of those a given session principal
 * may see. Actual manifest generation (JSON-schema tools, permission
 * filtering against a live context) is the AI phase; this derivation is
 * the single place exposure is decided, so AI can never become a bypass
 * to an internal action.
 *
 * Lives in the client-safe contract leaf so `@showzy/contract` and the
 * registry-wide contract check (SHO-467) share one function.
 */
import type { ActionContract, ActionPrincipal } from "./types.js";

/**
 * Descriptors eligible to become AI tools: `transport: "client"` **and**
 * `aiExposure: "exposed"` — both required, so an internal action (or a
 * client action deliberately kept away from models) never surfaces.
 */
export function deriveAiToolSources(
  contracts: readonly ActionContract[],
): readonly ActionContract[] {
  return contracts.filter(
    (contract) =>
      contract.transport === "client" && contract.aiExposure === "exposed",
  );
}

/**
 * Principal-filtered view of the tool sources: a consumer session sees
 * only `consumer`-principal tools, an account session only `account`
 * tools, and so on — no company-scoped tools appear without an active
 * company context (contract.md §2). Runtime permission filtering against
 * the verified context happens in the AI layer on top of this set.
 */
export function aiToolSourcesForPrincipal(
  contracts: readonly ActionContract[],
  principal: ActionPrincipal,
): readonly ActionContract[] {
  return deriveAiToolSources(contracts).filter(
    (contract) => contract.principal === principal,
  );
}
