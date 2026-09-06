/**
 * `@showzy/core/contract` — the client-safe leaf export (ADR-0016).
 *
 * May be imported by module `*.contract.ts` files, `packages/contract`,
 * and client bundles. Its import graph must never reach the core runtime,
 * `packages/db`, Node builtins, logging, Redis, or workers — the CI bundle
 * probe (fnd-T25) enforces this.
 */
export {
  aiToolSourcesForPrincipal,
  deriveAiToolSources,
} from "./ai-exposure.js";
export {
  ActionContractDefinitionError,
  defineActionContract,
} from "./define-action-contract.js";
export type {
  ActionAiExposure,
  ActionContract,
  ActionContractDefinition,
  ActionPrincipal,
  ActionRateLimit,
  ActionRisk,
  ActionTransport,
  PublicScope,
  SystemScope,
} from "./types.js";
