/**
 * Composition-root identity and the suite-coverage gate the CI stage
 * relies on (fnd-G1 A2). The green-path stage itself lives in
 * `composition.contract-check.test.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { assistantSuiteCoverage } from "@showzy/assistant/suite-coverage";
import { catalogSuiteCoverage } from "@showzy/catalog/suite-coverage";
import { chatSuiteCoverage } from "@showzy/chat/suite-coverage";
import { companiesSuiteCoverage } from "@showzy/companies/suite-coverage";
import { customersSuiteCoverage } from "@showzy/customers/suite-coverage";
import { docGenerationSuiteCoverage } from "@showzy/doc-generation/suite-coverage";
import { docSigningSuiteCoverage } from "@showzy/doc-signing/suite-coverage";
import { documentsSuiteCoverage } from "@showzy/documents/suite-coverage";
import { filesSuiteCoverage } from "@showzy/files/suite-coverage";
import { invitesSuiteCoverage } from "@showzy/invites/suite-coverage";
import { ordersSuiteCoverage } from "@showzy/orders/suite-coverage";
import { pricingSuiteCoverage } from "@showzy/pricing/suite-coverage";
import { searchSuiteCoverage } from "@showzy/search/suite-coverage";
import { implementAction, runContractCheck } from "@showzy/core";
import { defineActionContract } from "@showzy/core/contract";
import { projectionGrants } from "@showzy/db";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  buildContractCheckInput,
  createActionRegistry,
  createStaffAssistantProvider,
  mergeSuiteCoverage,
  registerAction,
} from "./composition.js";
import { registeredEventSubscriptions } from "./subscriptions.js";

const io = z.object({});

function actionNames(
  registry: ReturnType<typeof createActionRegistry>,
): string[] {
  return registry
    .contracts()
    .map((contract) => contract.name)
    .toSorted();
}

describe("composition root identity", () => {
  it("index.ts warns when the S3 signing host is loopback", () => {
    const indexSource = readFileSync(
      join(import.meta.dirname, "index.ts"),
      "utf8",
    );
    expect(indexSource).toContain("s3DeviceSigningWarning");
    expect(indexSource).toContain("S3_LOOPBACK_SIGNING_WARNING");
  });

  it("boot.ts uses createActionRegistry from this module", () => {
    const bootSource = readFileSync(
      join(import.meta.dirname, "boot.ts"),
      "utf8",
    );
    expect(bootSource).toContain('from "./composition.js"');
    expect(bootSource).toContain("createActionRegistry");
    expect(bootSource).toContain("createStaffAssistantProvider");
    expect(bootSource).toContain("createRedisAuthRateLimitStore(redis, {");
    expect(bootSource).toContain("ipHmacSecret: config.rateLimit.ipHmacSecret");
    expect(bootSource).toContain("configureFilesObjectStore");
    expect(bootSource).toContain("probeFilesObjectStore");
    expect(bootSource).toContain("closeFilesObjectStore");
    expect(bootSource).toContain("configureDocumentShareOrigin");
    expect(bootSource).not.toMatch(/new ActionRegistry\s*\(/);
  });

  it("constructs the staff assistant provider from config without a registry", () => {
    const provider = createStaffAssistantProvider({
      anthropicApiKey: undefined,
      model: "claude-sonnet-4-6",
      gateModel: "claude-haiku-4-5",
    });
    expect(provider.id).toBe("anthropic");
    expect(provider.pricing("claude-sonnet-4-6")?.cacheWrite).toBe(6);
    expect(provider.pricing("claude-haiku-4-5")?.cacheWrite).toBe(2);
    expect(provider.pricing("claude-opus-4-6")?.cacheWrite).toBe(30);
    expect(provider.pricing("some-unknown-model")).toBeNull();
  });

  it("the contract-check input is the boot registry plus the db grant manifest", () => {
    const input = buildContractCheckInput();
    expect(actionNames(input.registry)).toEqual(
      actionNames(createActionRegistry()),
    );
    expect(
      input.registry
        .implementations()
        .map((implementation) => implementation.contract.name)
        .toSorted(),
    ).toEqual(actionNames(createActionRegistry()));
    expect(input.projectionGrants).toBe(projectionGrants);
    expect(input.suiteCoverage).toEqual(
      mergeSuiteCoverage([
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
      ]),
    );
  });

  it("orders.create nests companies.get for numbering prefix", () => {
    const source = readFileSync(
      join(import.meta.dirname, "composition.ts"),
      "utf8",
    );
    const edges: Array<{ caller: string; callee: string }> = [];
    const edgeRe = /caller:\s*"([^"]+)",\s*\n\s*callee:\s*"([^"]+)"/g;
    for (const match of source.matchAll(edgeRe)) {
      const caller = match[1];
      const callee = match[2];
      if (caller !== undefined && callee !== undefined) {
        edges.push({ caller, callee });
      }
    }
    expect(
      edges
        .filter((edge) => edge.caller === "orders.create")
        .map((edge) => edge.callee)
        .toSorted(),
    ).toEqual([
      "catalog.resolveLineReferences",
      "companies.get",
      "customers.resolveCustomerReference",
      "pricing.resolveProductPrices",
    ]);
  });

  it("documents.createFromOrder nested reads omit companies.get", () => {
    const source = readFileSync(
      join(import.meta.dirname, "composition.ts"),
      "utf8",
    );
    const edges: Array<{ caller: string; callee: string }> = [];
    const edgeRe = /caller:\s*"([^"]+)",\s*\n\s*callee:\s*"([^"]+)"/g;
    for (const match of source.matchAll(edgeRe)) {
      const caller = match[1];
      const callee = match[2];
      if (caller !== undefined && callee !== undefined) {
        edges.push({ caller, callee });
      }
    }
    const fromCreate = edges.filter(
      (edge) => edge.caller === "documents.createFromOrder",
    );
    expect(fromCreate.map((edge) => edge.callee).toSorted()).toEqual([
      "companies.getSellerFacts",
      "customers.getCounterparty",
      "customers.getCustomer",
      "docGeneration.resolveLayout",
      "orders.get",
    ]);
    expect(fromCreate.map((edge) => edge.callee)).not.toContain(
      "companies.get",
    );
  });

  it("documents.share nests files.issueShareDownloadUrl", () => {
    const source = readFileSync(
      join(import.meta.dirname, "composition.ts"),
      "utf8",
    );
    const edges: Array<{ caller: string; callee: string }> = [];
    const edgeRe = /caller:\s*"([^"]+)",\s*\n\s*callee:\s*"([^"]+)"/g;
    for (const match of source.matchAll(edgeRe)) {
      const caller = match[1];
      const callee = match[2];
      if (caller !== undefined && callee !== undefined) {
        edges.push({ caller, callee });
      }
    }
    expect(
      edges
        .filter((edge) => edge.caller === "documents.share")
        .map((edge) => edge.callee)
        .toSorted(),
    ).toEqual([
      "docGeneration.getArtifact",
      "docSigning.get",
      "files.issueShareDownloadUrl",
      "files.issueShareSigningDownloadUrl",
    ]);
  });

  it("documents.attachSignedShare nests files.issueSystemSigningDownloadUrl", () => {
    const source = readFileSync(
      join(import.meta.dirname, "composition.ts"),
      "utf8",
    );
    const edges: Array<{ caller: string; callee: string }> = [];
    const edgeRe = /caller:\s*"([^"]+)",\s*\n\s*callee:\s*"([^"]+)"/g;
    for (const match of source.matchAll(edgeRe)) {
      const caller = match[1];
      const callee = match[2];
      if (caller !== undefined && callee !== undefined) {
        edges.push({ caller, callee });
      }
    }
    expect(
      edges
        .filter((edge) => edge.caller === "documents.attachSignedShare")
        .map((edge) => edge.callee),
    ).toEqual(["files.issueSystemSigningDownloadUrl"]);
    expect(source).toContain("documentsActions");
    // The subscription list moved to `./subscriptions.ts` (SHO-279) —
    // assert the registered composition, not the source text.
    expect(registeredEventSubscriptions.map((row) => row.consumer)).toContain(
      "documents.signed-share-attacher",
    );
    expect(source).not.toContain(
      "documents.attachSignedShare->files.getDownloadUrl",
    );
  });

  it("documents.get nests getArtifact and the documents:view PDF URL", () => {
    const source = readFileSync(
      join(import.meta.dirname, "composition.ts"),
      "utf8",
    );
    const edges: Array<{ caller: string; callee: string }> = [];
    const edgeRe = /caller:\s*"([^"]+)",\s*\n\s*callee:\s*"([^"]+)"/g;
    for (const match of source.matchAll(edgeRe)) {
      const caller = match[1];
      const callee = match[2];
      if (caller !== undefined && callee !== undefined) {
        edges.push({ caller, callee });
      }
    }
    expect(
      edges
        .filter((edge) => edge.caller === "documents.get")
        .map((edge) => edge.callee)
        .toSorted(),
    ).toEqual([
      "docGeneration.getArtifact",
      "docSigning.get",
      "files.issueDocumentDownloadUrl",
    ]);
  });

  it("documents.list nests one supplierSigned flags read", () => {
    const source = readFileSync(
      join(import.meta.dirname, "composition.ts"),
      "utf8",
    );
    const edges: Array<{ caller: string; callee: string }> = [];
    const edgeRe = /caller:\s*"([^"]+)",\s*\n\s*callee:\s*"([^"]+)"/g;
    for (const match of source.matchAll(edgeRe)) {
      const caller = match[1];
      const callee = match[2];
      if (caller !== undefined && callee !== undefined) {
        edges.push({ caller, callee });
      }
    }
    expect(
      edges
        .filter((edge) => edge.caller === "documents.list")
        .map((edge) => edge.callee)
        .toSorted(),
    ).toEqual(["docSigning.getSupplierSignedFlags"]);
  });

  it("documents.requestSign and cancel nest signing reads without a reverse get", () => {
    const source = readFileSync(
      join(import.meta.dirname, "composition.ts"),
      "utf8",
    );
    const edges: Array<{ caller: string; callee: string }> = [];
    const edgeRe = /caller:\s*"([^"]+)",\s*\n\s*callee:\s*"([^"]+)"/g;
    for (const match of source.matchAll(edgeRe)) {
      const caller = match[1];
      const callee = match[2];
      if (caller !== undefined && callee !== undefined) {
        edges.push({ caller, callee });
      }
    }
    expect(
      edges
        .filter((edge) => edge.caller === "documents.requestSign")
        .map((edge) => edge.callee)
        .toSorted(),
    ).toEqual(["docGeneration.getArtifact", "docSigning.get"]);
    expect(
      edges
        .filter((edge) => edge.caller === "documents.cancel")
        .map((edge) => edge.callee),
    ).toEqual(["docSigning.get"]);
    expect(edges.map((edge) => `${edge.caller}->${edge.callee}`)).not.toContain(
      "docSigning.get->documents.get",
    );
  });

  it("docSigning.start nests the issued-row lock, getArtifact, and the panel PDF issuer, not documents.get", () => {
    const source = readFileSync(
      join(import.meta.dirname, "composition.ts"),
      "utf8",
    );
    const edges: Array<{ caller: string; callee: string }> = [];
    const edgeRe = /caller:\s*"([^"]+)",\s*\n\s*callee:\s*"([^"]+)"/g;
    for (const match of source.matchAll(edgeRe)) {
      const caller = match[1];
      const callee = match[2];
      if (caller !== undefined && callee !== undefined) {
        edges.push({ caller, callee });
      }
    }
    expect(
      edges
        .filter((edge) => edge.caller === "docSigning.start")
        .map((edge) => edge.callee)
        .toSorted(),
    ).toEqual([
      "docGeneration.getArtifact",
      "documents.lockIssuedForSigning",
      "files.issueDocumentDownloadUrl",
    ]);
    expect(
      edges
        .filter((edge) => edge.caller === "documents.lockIssuedForSigning")
        .map((edge) => edge.callee),
    ).toEqual(["docGeneration.getArtifact"]);
    expect(edges.map((edge) => `${edge.caller}->${edge.callee}`)).not.toContain(
      "docSigning.start->documents.get",
    );
  });

  it("docSigning.complete nests the issued-row lock and pending staging read, not finalizeUpload", () => {
    const source = readFileSync(
      join(import.meta.dirname, "composition.ts"),
      "utf8",
    );
    const edges: Array<{ caller: string; callee: string }> = [];
    const edgeRe = /caller:\s*"([^"]+)",\s*\n\s*callee:\s*"([^"]+)"/g;
    for (const match of source.matchAll(edgeRe)) {
      const caller = match[1];
      const callee = match[2];
      if (caller !== undefined && callee !== undefined) {
        edges.push({ caller, callee });
      }
    }
    expect(
      edges
        .filter((edge) => edge.caller === "docSigning.complete")
        .map((edge) => edge.callee)
        .toSorted(),
    ).toEqual([
      "documents.lockIssuedForSigning",
      "files.readPendingSigningObject",
    ]);
    expect(edges.map((edge) => `${edge.caller}->${edge.callee}`)).not.toContain(
      "docSigning.complete->files.finalizeUpload",
    );
    expect(source).toContain("docSigningActions");
    expect(source).toContain("filesActions");
    expect(source).toContain("docSigningRecorded");
  });
});

describe("composition suiteCoverage gate", () => {
  it("fails the contract check when a boot-registered action is omitted from suiteCoverage", () => {
    const contract = defineActionContract({
      name: "coverageProbe.get",
      description: "Staff read used to prove the suiteCoverage omission gate.",
      principal: "staff",
      transport: "client",
      input: io,
      output: io,
      permissions: ["coverageProbe:view"],
      aiExposure: "internal",
      risk: "read",
      requiresConfirmation: false,
      idempotent: false,
      emits: [],
      atomicCalls: [],
      atomicCallers: [],
      errors: [],
      audit: false,
      timeout: 5_000,
    });
    const registry = createActionRegistry();
    registerAction(
      registry,
      implementAction(contract, {
        handler: () => Promise.resolve({}),
      }),
    );

    const result = runContractCheck({
      ...buildContractCheckInput(),
      registry,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      'action "coverageProbe.get": missing crossTenantSuite instantiation (core.md §12)',
    ]);
  });
});
