/**
 * `@showzy/core/testing` — the module test kit (fnd-T21/T22, core.md §12).
 *
 * Every later module inherits tenant isolation, idempotency, events, and
 * atomic-call coverage by instantiating these suites against its actions.
 * Omitting a required instantiation fails the contract check
 * (`suiteCoverage` on `ContractCheckInput`).
 *
 * The kit world is the db.md §8 parity fixtures plus matching
 * `companies` / `company_members` rows.
 */
export { kitIdentities } from "./identities.js";
export type { KitIdentities } from "./identities.js";
export {
  assertDeclaredEscapingError,
  checkInvokeActionError,
  declaredErrorsReportPath,
  UndeclaredActionError,
} from "./declared-errors.js";
export {
  buildJobEnvelope,
  buildTestContext,
  createCapturingLogger,
  createRecordingJobPort,
  createTestKit,
  invokeAction,
  seedTestKit,
} from "./kit.js";
export type {
  BuildTestContextOverrides,
  InvokeOptions,
  IsolationActor,
  RecordingJobPort,
  TestKit,
} from "./kit.js";
export {
  accountIsolationSuite,
  browseCase,
  consumerIsolationSuite,
  crossTenantSuite,
  isolationCase,
  jobIsolationCase,
  jobIsolationSuite,
  publicProjectionSuite,
  runAccountIsolationCase,
  runConsumerIsolationCase,
  runCrossTenantCase,
  runJobIsolationCase,
  runPublicProjectionCase,
  runShareIsolationCase,
  shareIsolationCase,
  shareIsolationSuite,
} from "./suites.js";
export type {
  BrowseCase,
  CrossTenantCase,
  IsolationInvocation,
  JobIsolationCase,
  JobIsolationEffect,
  JobIsolationInvocation,
  JobIsolationOwnRun,
  ShareIsolationCase,
  SuiteAction,
} from "./suites.js";
export {
  atomicCallSuite,
  eventSuite,
  expectCoreInvariant,
  idempotencySuite,
  runAtomicCallCase,
  runEventSuiteCase,
  runIdempotencyCase,
  runSocialDesiredStateCase,
} from "./protocol-suites.js";
export type {
  AtomicCallCase,
  AtomicCallProbe,
  EventSuiteSpec,
  IdempotencyCase,
  SocialDesiredStateCase,
} from "./protocol-suites.js";
