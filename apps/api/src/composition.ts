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
 * through `eventSubscriptionRefs`. Action barrels register in
 * `./registry.ts`, which the worker imports too (SHO-569).
 */
import { STAFF_ASSISTANT_FACADE_TOOL_NAMES } from "@showzy/ai";
import { assistantSuiteCoverage } from "@showzy/assistant/suite-coverage";
import { catalogSuiteCoverage } from "@showzy/catalog/suite-coverage";
import { chatSuiteCoverage } from "@showzy/chat/suite-coverage";
import { companiesSuiteCoverage } from "@showzy/companies/suite-coverage";
import { customersSuiteCoverage } from "@showzy/customers/suite-coverage";
import {
  documentsCancelled,
  documentsCreated,
  documentsSignRequested,
} from "@showzy/documents";
import { documentsSuiteCoverage } from "@showzy/documents/suite-coverage";
import { docGenerationSuiteCoverage } from "@showzy/doc-generation/suite-coverage";
import { docSigningRecorded } from "@showzy/doc-signing";
import { docSigningSuiteCoverage } from "@showzy/doc-signing/suite-coverage";
import { filesSuiteCoverage } from "@showzy/files/suite-coverage";
import {
  invitesAccepted,
  invitesCreated,
  invitesRevoked,
} from "@showzy/invites";
import { invitesSuiteCoverage } from "@showzy/invites/suite-coverage";
import {
  ordersCanceled,
  ordersCompleted,
  ordersConfirmed,
  ordersCreated,
  ordersStarted,
} from "@showzy/orders";
import { ordersSuiteCoverage } from "@showzy/orders/suite-coverage";
import { pricingSuiteCoverage } from "@showzy/pricing/suite-coverage";
import { searchSuiteCoverage } from "@showzy/search/suite-coverage";
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
import { ASSISTANT_SURFACE_REGISTRY } from "@showzy/validation/assistant-surfaces";
import type { z } from "zod";

import { createActionRegistry } from "./registry.js";
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
  searchSuiteCoverage,
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
    caller: "orders.searchMatches",
    callee: "companies.get",
  },
  {
    caller: "documents.searchMatches",
    callee: "companies.get",
  },
  {
    caller: "search.query",
    callee: "customers.searchMatches",
  },
  {
    caller: "search.query",
    callee: "catalog.searchMatches",
  },
  {
    caller: "search.query",
    callee: "orders.searchMatches",
  },
  {
    caller: "search.query",
    callee: "pricing.searchMatches",
  },
  {
    caller: "search.query",
    callee: "documents.searchMatches",
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

/**
 * Everything `runContractCheck` walks. The registry is `./registry.js`'s, the
 * one the API boots and the worker runs turns against (SHO-569). Empty collections are explicit
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
    assistantSurfaces: ASSISTANT_SURFACE_REGISTRY.map((surface) => ({
      kind: surface.kind,
      actionNames: surface.actionNames,
      toolNames: surface.toolNames,
    })),
    assistantFacadeToolNames: STAFF_ASSISTANT_FACADE_TOOL_NAMES,
  };
}
