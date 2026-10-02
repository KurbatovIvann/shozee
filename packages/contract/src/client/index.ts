/**
 * `@showzy/contract` — the client-safe contract layer (contract.md §2).
 *
 * May be imported by client bundles (Expo, later Next.js) and by
 * `apps/api` for composition. Its import graph must never reach the core
 * runtime, `packages/db`, or Node builtins — the CI bundle probe
 * (fnd-T25) enforces this; the server-only half lives at
 * `@showzy/contract/server`.
 */
export {
  aiToolSourcesForPrincipal,
  deriveAiToolSources,
} from "./ai-manifest.js";
export {
  buildContractRouter,
  collectCompositionProblems,
  ContractCompositionError,
  toContractProcedure,
} from "./contract-router.js";
export type {
  ContractModuleMap,
  ContractProcedureFor,
  ContractRouterFor,
} from "./contract-router.js";
export { contractModules, contractRouter } from "./modules.js";
export { createContractClient, RPC_PREFIX } from "./create-client.js";
export type {
  AccessTokenProvider,
  ContractCallContext,
  ContractClient,
  ContractClientOptions,
  CookieProvider,
} from "./create-client.js";
export {
  INT64_MAX,
  INT64_MIN,
  MoneyWireError,
  isMoneyWire,
  moneyFromWire,
  moneyToWire,
  moneyWireSchema,
} from "./money-wire.js";
export { createMutationAttempt } from "./mutation-attempt.js";
export type {
  MutationAttempt,
  MutationCallOptions,
} from "./mutation-attempt.js";
export {
  COMPANY_SELECTOR_HEADER,
  CONFIRMATION_CHALLENGE_HEADER,
  IDEMPOTENCY_KEY_HEADER,
} from "./transport-meta.js";
export {
  isWireError,
  wireActionPreviewSchema,
  wireConfirmationChallengeSchema,
  wireErrorDefinitions,
  wireErrorStatus,
  wireValidationIssueSchema,
} from "./wire-errors.js";
export type {
  WireActionPreview,
  WireActionRisk,
  WireError,
  WireErrorCode,
} from "./wire-errors.js";
