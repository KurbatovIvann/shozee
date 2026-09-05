/**
 * `@showzy/core` — the server-side action runtime (ADR-0016).
 *
 * Server-only: module `actions/<name>.ts` implementations and app boot
 * code import from here. Client bundles and `*.contract.ts` files must
 * import `@showzy/core/contract` instead; domain code throws from
 * `@showzy/core/errors`.
 */
export {
  ActionImplementationError,
  implementAction,
} from "./runtime/implement-action.js";
export type {
  ActionServerCallbacks,
  ImplementedAction,
} from "./runtime/implement-action.js";
export {
  ActionRegistry,
  ActionRegistryError,
} from "./runtime/action-registry.js";
export {
  assertContractCheck,
  ContractCheckError,
  runContractCheck,
} from "./contract-check/contract-check.js";
export type {
  ContractCheckInput,
  ContractCheckResult,
  DeclaredCallEdge,
  EventDefinitionRef,
  EventSubscriptionRef,
  ProjectionGrantLookup,
  ReadModelGrantRef,
  SchemaImportRef,
} from "./contract-check/contract-check.js";
export { emptySuiteCoverage } from "./contract-check/suite-coverage.js";
export type { SuiteCoverageManifest } from "./contract-check/suite-coverage.js";
export type {
  AnyActionContract,
  RegisteredImplementation,
} from "./runtime/action-registry.js";
export type {
  ActionExecutionCtx,
  ActionHandler,
  AuditSnapshotFn,
  AuditTargetEnv,
  AuditTargetFn,
  AuditTargetRef,
  ConfirmationSummaryEnv,
  ConfirmationSummaryFn,
  JsonValue,
  MaybePromise,
  ResolvedTarget,
  TargetResolutionEnv,
  TargetResolutionPrincipal,
  TargetResolver,
} from "./runtime/types.js";
export { executeAction } from "./runtime/pipeline/execute-action.js";
export type { ActionInvocation } from "./runtime/pipeline/execute-action.js";
export { createAuditHook } from "./runtime/audit/create-audit-hook.js";
export type { AuditHookDeps } from "./runtime/audit/create-audit-hook.js";
export {
  cleanupExpiredIdempotencyKeys,
  createIdempotencyHook,
  IDEMPOTENCY_LEASE_MARGIN_MS,
  IDEMPOTENCY_RETENTION_MS,
} from "./runtime/idempotency/create-idempotency-hook.js";
export type { IdempotencyHookDeps } from "./runtime/idempotency/create-idempotency-hook.js";
export {
  createRateLimitHook,
  IP_HMAC_ROTATION_MS,
  rateLimitDefaults,
} from "./runtime/rate-limit/create-rate-limit-hook.js";
export type { RateLimitHookDeps } from "./runtime/rate-limit/create-rate-limit-hook.js";
export { createInMemoryRateLimitStore } from "./runtime/rate-limit/token-bucket.js";
export type {
  RateLimitConsumeRequest,
  RateLimitDecision,
  RateLimitStore,
} from "./runtime/rate-limit/token-bucket.js";
export {
  canonicalJson,
  canonicalJsonSha256,
} from "./runtime/audit/canonical-json.js";
export type { JsonSerializable } from "./runtime/audit/canonical-json.js";
export {
  CONFIRMATION_TTL_MS,
  createConfirmationHook,
} from "./runtime/confirmation/create-confirmation-hook.js";
export type { ConfirmationHookDeps } from "./runtime/confirmation/create-confirmation-hook.js";
export { createInMemoryConfirmationStore } from "./runtime/confirmation/store.js";
export type { ConfirmationStore } from "./runtime/confirmation/store.js";
export type {
  ActionPipelineDeps,
  ActionSpan,
  ActionSpanFields,
  ActionSpanOutcome,
  ActionTelemetry,
  ActionTransactionRunner,
  AuditHook,
  ConfirmationGrant,
  ConfirmationHook,
  IdempotencyHook,
  IdempotencyProbeResult,
  IdempotencyReserveResult,
  PipelineHookEnv,
  PipelineHookRequestMeta,
  PipelineHooks,
  PipelineRequestMeta,
  PreflightAuthorization,
  PrincipalInvocation,
  RateLimitHook,
} from "./runtime/pipeline/types.js";
export {
  defineEvent,
  EventDefinitionError,
} from "./runtime/events/define-event.js";
export type {
  EventAggregateRef,
  EventDefinition,
  EventDefinitionInput,
  EventEmission,
  EventScope,
} from "./runtime/events/define-event.js";
export { eventEnvelopeSchema } from "./runtime/events/envelope.js";
export type {
  EventEnvelope,
  EventEnvelopeActor,
  EventEnvelopeAggregate,
} from "./runtime/events/envelope.js";
export {
  defineEventHandler,
  EventHandlerDefinitionError,
  eventSubscriptionRefs,
} from "./runtime/events/define-event-handler.js";
export type {
  EventHandlerBinding,
  EventSubscription,
} from "./runtime/events/define-event-handler.js";
export {
  DELIVERY_CLAIM_MARGIN_MS,
  DELIVERY_DISCOVERY_BATCH_SIZE,
  DELIVERY_MAX_ATTEMPTS,
  DELIVERY_RETRY_BASE_MS,
  deliveryRetryDelayMs,
  dispatchOutboxBatch,
  executeDelivery,
  findClaimableDeliveries,
} from "./runtime/events/delivery.js";
export type {
  ClaimableDelivery,
  DeliveryOutcome,
  OutboxDispatcherDeps,
  OutboxDispatchResult,
} from "./runtime/events/delivery.js";
export {
  DeliveryReplayCliError,
  parseDeliveryReplayArgs,
  runDeliveryReplayCli,
} from "./runtime/events/replay-dead-deliveries.cli.js";
export {
  replayDeadDeliveries,
  type DeliveryReplayDeps,
  type DeliveryReplayResult,
} from "./runtime/events/replay-dead-deliveries.js";
export {
  createAccountContext,
  createConsumerContext,
  createCustomerContext,
  createPublicContext,
  createShareContext,
  createStaffContext,
  createSystemContext,
  effectiveCompanyId,
} from "./runtime/context/factories.js";
export type {
  ActionRequestMeta,
  ContextRuntime,
  SessionPrincipal,
  SystemScopeInput,
} from "./runtime/context/factories.js";
export {
  resolveEffectivePermissions,
  staffHasPermission,
} from "./runtime/context/permissions.js";
export { SHARE_DURABLE_ACTOR } from "./runtime/context/types.js";
export type {
  AccountCtx,
  ActionActor,
  ActionChannel,
  ActionCtx,
  ActionCtxFor,
  BaseCtx,
  CompanyRole,
  ConsumerCtx,
  CtxCall,
  CtxCallAtomic,
  CtxEmit,
  CustomerCtx,
  PublicCtx,
  PublicGlobalCtx,
  PublicTargetCtx,
  ShareCtx,
  StaffCtx,
  StaffMembership,
  SystemCtx,
} from "./runtime/context/types.js";
