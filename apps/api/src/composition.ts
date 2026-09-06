/**
 * The process composition root (fnd-G1 A2): the boot ActionRegistry and
 * the CI contract-check input are assembled here so they cannot diverge.
 *
 * Module tasks register in this file — never in `packages/core`. Each
 * module exports actions from `index.ts`, client descriptors from
 * `index.contract.ts` (added to `packages/contract` `contractModules`),
 * and a `suiteCoverage` declaration next to those barrels (exported from
 * the module's `./suite-coverage` subpath — `index.ts` exports only
 * actions and events). This root registers both barrels, concatenates
 * events/subscriptions/call edges/schema-ownership rows, and merges
 * coverage.
 *
 * Worker delivery bindings stay in `apps/worker/src/subscriptions.ts`
 * and must list the same `defineEventHandler` objects this file passes
 * through `eventSubscriptionRefs`.
 */
import { assistantActions } from "@showzy/assistant";
import { assistantSuiteCoverage } from "@showzy/assistant/suite-coverage";
import { catalogActions } from "@showzy/catalog";
import { catalogSuiteCoverage } from "@showzy/catalog/suite-coverage";
import { chatActions } from "@showzy/chat";
import { chatSuiteCoverage } from "@showzy/chat/suite-coverage";
import { companiesActions } from "@showzy/companies";
import { companiesSuiteCoverage } from "@showzy/companies/suite-coverage";
import { customersActions } from "@showzy/customers";
import { customersSuiteCoverage } from "@showzy/customers/suite-coverage";
import {
  documentsActions,
  documentsCancelled,
  documentsCreated,
  documentsSignRequested,
} from "@showzy/documents";
import { documentsSuiteCoverage } from "@showzy/documents/suite-coverage";
import { docGenerationActions } from "@showzy/doc-generation";
import { docGenerationSuiteCoverage } from "@showzy/doc-generation/suite-coverage";
import { docSigningActions, docSigningRecorded } from "@showzy/doc-signing";
import { docSigningSuiteCoverage } from "@showzy/doc-signing/suite-coverage";
import { filesActions } from "@showzy/files";
import { filesSuiteCoverage } from "@showzy/files/suite-coverage";
import {
  invitesActions,
  invitesAccepted,
  invitesCreated,
  invitesRevoked,
} from "@showzy/invites";
import { invitesSuiteCoverage } from "@showzy/invites/suite-coverage";
import {
  ordersActions,
  ordersCanceled,
  ordersCompleted,
  ordersConfirmed,
  ordersCreated,
  ordersStarted,
} from "@showzy/orders";
import { ordersSuiteCoverage } from "@showzy/orders/suite-coverage";
import { pricingActions } from "@showzy/pricing";
import { pricingSuiteCoverage } from "@showzy/pricing/suite-coverage";
import {
  ActionRegistry,
  emptySuiteCoverage,
  eventSubscriptionRefs,
  schemaTablesFromModules,
  type ContractCheckInput,
  type DeclaredCallEdge,
  type EventDefinitionRef,
  type ImplementedAction,
  type ReadModelGrantRef,
  type SchemaImportRef,
  type SuiteCoverageManifest,
} from "@showzy/core";
import { ownedSchemaModules, projectionGrants } from "@showzy/db";
import type { z } from "zod";
import { registeredEventSubscriptions } from "./subscriptions.js";

/**
 * Per-module inherited-suite declarations (core.md §12). Module tasks
 * append the export that lives next to that module's barrels
 * (`@showzy/<module>/suite-coverage`).
 */
const moduleSuiteCoverage: readonly SuiteCoverageManifest[] = [
  assistantSuiteCoverage,
  catalogSuiteCoverage,
  chatSuiteCoverage,
  companiesSuiteCoverage,
  customersSuiteCoverage,
  documentsSuiteCoverage,
  docGenerationSuiteCoverage,
  docSigningSuiteCoverage,
  filesSuiteCoverage,
  invitesSuiteCoverage,
  ordersSuiteCoverage,
  pricingSuiteCoverage,
];

const events: readonly EventDefinitionRef[] = [
  ordersCreated,
  ordersConfirmed,
  ordersStarted,
  ordersCompleted,
  ordersCanceled,
  documentsCancelled,
  documentsCreated,
  documentsSignRequested,
  docSigningRecorded,
  invitesAccepted,
  invitesCreated,
  invitesRevoked,
];

const callEdges: readonly DeclaredCallEdge[] = [
  {
    caller: "orders.create",
    callee: "catalog.resolveLineReferences",
  },
  {
    caller: "orders.create",
    callee: "companies.get",
  },
  {
    caller: "orders.create",
    callee: "pricing.resolveProductPrices",
  },
  {
    caller: "orders.create",
    callee: "customers.resolveCustomerReference",
  },
  {
    caller: "orders.list",
    callee: "customers.listMatchingIds",
  },
  {
    caller: "pricing.resolveProductPrices",
    callee: "catalog.getProductPricingFacts",
  },
  {
    caller: "pricing.setPriceListEntries",
    callee: "catalog.getProductPricingFacts",
  },
  {
    caller: "pricing.resolveProductPrices",
    callee: "customers.getCustomerPricingFacts",
  },
  {
    caller: "catalog.setProductImages",
    callee: "files.getAttachmentFacts",
  },
  {
    caller: "customers.createCustomer",
    callee: "pricing.getPriceList",
  },
  {
    caller: "customers.createGroup",
    callee: "pricing.getPriceList",
  },
  {
    caller: "customers.updateCustomer",
    callee: "pricing.getPriceList",
  },
  {
    caller: "customers.updateGroup",
    callee: "pricing.getPriceList",
  },
  {
    caller: "invites.create",
    callee: "customers.getGroup",
  },
  {
    caller: "invites.create",
    callee: "pricing.getPriceList",
  },
  {
    caller: "documents.createFromOrder",
    callee: "orders.get",
  },
  {
    caller: "documents.createFromOrder",
    callee: "companies.getSellerFacts",
  },
  {
    caller: "documents.createFromOrder",
    callee: "customers.getCounterparty",
  },
  {
    caller: "documents.createFromOrder",
    callee: "customers.getCustomer",
  },
  {
    caller: "documents.createFromOrder",
    callee: "docGeneration.resolveLayout",
  },
  {
    caller: "documents.share",
    callee: "docGeneration.getArtifact",
  },
  {
    caller: "documents.share",
    callee: "docSigning.get",
  },
  {
    caller: "documents.share",
    callee: "files.issueShareDownloadUrl",
  },
  {
    caller: "documents.share",
    callee: "files.issueShareSigningDownloadUrl",
  },
  {
    caller: "documents.get",
    callee: "docGeneration.getArtifact",
  },
  {
    caller: "documents.get",
    callee: "files.issueDocumentDownloadUrl",
  },
  {
    caller: "documents.get",
    callee: "docSigning.get",
  },
  {
    caller: "documents.list",
    callee: "docSigning.getSupplierSignedFlags",
  },
  {
    caller: "documents.requestSign",
    callee: "docGeneration.getArtifact",
  },
  {
    caller: "documents.requestSign",
    callee: "docSigning.get",
  },
  {
    caller: "documents.cancel",
    callee: "docSigning.get",
  },
  {
    caller: "docGeneration.renderPdf",
    callee: "documents.getForGeneration",
  },
  {
    caller: "docGeneration.markFailed",
    callee: "documents.getForGeneration",
  },
  {
    caller: "docSigning.abandonRequest",
    callee: "documents.getForGeneration",
  },
  {
    caller: "docSigning.start",
    callee: "documents.lockIssuedForSigning",
  },
  {
    caller: "docSigning.start",
    callee: "docGeneration.getArtifact",
  },
  {
    caller: "docSigning.start",
    callee: "files.issueDocumentDownloadUrl",
  },
  {
    caller: "docSigning.complete",
    callee: "documents.lockIssuedForSigning",
  },
  {
    caller: "docSigning.complete",
    callee: "files.readPendingSigningObject",
  },
  {
    caller: "documents.attachSignedShare",
    callee: "files.issueSystemSigningDownloadUrl",
  },
  {
    caller: "documents.lockIssuedForSigning",
    callee: "docGeneration.getArtifact",
  },
];

const readModelGrants: readonly ReadModelGrantRef[] = [
  // Projection owners record spec-declared grants here (ADR-0015).
];

const schemaImports: readonly SchemaImportRef[] = [
  { importer: "assistant", schemaOwner: "assistant" },
  { importer: "catalog", schemaOwner: "catalog" },
  { importer: "chat", schemaOwner: "chat" },
  { importer: "companies", schemaOwner: "companies" },
  { importer: "customers", schemaOwner: "customers" },
  { importer: "documents", schemaOwner: "documents" },
  { importer: "doc-generation", schemaOwner: "doc-generation" },
  { importer: "doc-signing", schemaOwner: "doc-signing" },
  { importer: "files", schemaOwner: "files" },
  { importer: "invites", schemaOwner: "invites" },
  { importer: "orders", schemaOwner: "orders" },
  { importer: "pricing", schemaOwner: "pricing" },
];

/** Registers one implemented action's contract + implementation pair. */
export function registerAction<
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
  TTarget,
>(
  registry: ActionRegistry,
  action: ImplementedAction<TInput, TOutput, TTarget>,
): void {
  registry.registerContract(action.contract);
  registry.registerImplementation(action);
}

function registerActions<TTarget>(
  registry: ActionRegistry,
  actions: readonly ImplementedAction<z.ZodType, z.ZodType, TTarget>[],
): void {
  for (const action of actions) {
    registerAction(registry, action);
  }
}

export function mergeSuiteCoverage(
  manifests: readonly SuiteCoverageManifest[],
): SuiteCoverageManifest {
  if (manifests.length === 0) {
    return emptySuiteCoverage;
  }
  return {
    isolation: manifests.flatMap((manifest) => manifest.isolation),
    publicProjection: manifests.flatMap(
      (manifest) => manifest.publicProjection,
    ),
    consumerIsolation: manifests.flatMap(
      (manifest) => manifest.consumerIsolation,
    ),
    accountIsolation: manifests.flatMap(
      (manifest) => manifest.accountIsolation,
    ),
    shareIsolation: manifests.flatMap((manifest) => manifest.shareIsolation),
    idempotency: manifests.flatMap((manifest) => manifest.idempotency),
    events: manifests.flatMap((manifest) => manifest.events),
    atomic: manifests.flatMap((manifest) => manifest.atomic),
  };
}

/** The boot registry — same builder the contract-check stage walks. */
export function createActionRegistry(): ActionRegistry {
  const registry = new ActionRegistry();
  registerActions(registry, assistantActions);
  registerActions(registry, catalogActions);
  registerActions(registry, chatActions);
  registerActions(registry, companiesActions);
  registerActions(registry, customersActions);
  registerActions(registry, filesActions);
  registerActions(registry, invitesActions);
  registerActions(registry, documentsActions);
  registerActions(registry, docGenerationActions);
  registerActions(registry, docSigningActions);
  registerActions(registry, ordersActions);
  registerActions(registry, pricingActions);
  return registry;
}

/**
 * Everything `runContractCheck` walks. Empty collections are explicit
 * statements that nothing of that kind exists yet.
 */
export function buildContractCheckInput(): ContractCheckInput {
  return {
    registry: createActionRegistry(),
    events,
    subscriptions: eventSubscriptionRefs([...registeredEventSubscriptions]),
    callEdges,
    projectionGrants,
    readModelGrants,
    schemaImports,
    suiteCoverage: mergeSuiteCoverage(moduleSuiteCoverage),
    schemaTables: schemaTablesFromModules(ownedSchemaModules),
  };
}
