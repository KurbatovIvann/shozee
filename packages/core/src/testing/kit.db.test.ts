/**
 * Self-tests for the module test kit (fnd-T21 — core.md §12). Per-mode
 * fixture actions prove each suite passes on correct isolation and fails
 * on a seeded violation.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ConfirmationRequiredError } from "../errors/index.js";
import { effectiveCompanyId } from "../runtime/context/factories.js";
import {
  createCorrectFixtureActions,
  createCrmWritingConsumerBrowse,
  createLeakyFixtureActions,
} from "./fixture-actions.js";
import { kitIdentities } from "./identities.js";
import { createTestKit, type TestKit } from "./kit.js";
import {
  accountIsolationSuite,
  assertUserRateLimit,
  browseCase,
  consumerIsolationSuite,
  crossTenantSuite,
  isolationCase,
  publicProjectionSuite,
  runAccountIsolationCase,
  runConsumerIsolationCase,
  runCrossTenantCase,
  runPublicProjectionCase,
  runShareIsolationCase,
  shareIsolationCase,
  shareIsolationSuite,
  type SuiteAction,
} from "./suites.js";
import { kitShareDocuments, kitShareTokens } from "./share-fixture.js";

let kit: TestKit;
const correct = createCorrectFixtureActions();
let leaky: ReturnType<typeof createLeakyFixtureActions>;

const ownProduct = { productId: kitIdentities.products.published };
const foreignProduct = {
  productId: kitIdentities.products.ofUnpublishedCompany,
};
const missingProduct = { productId: randomUUID() };
const announcement = { note: "Spring sale" };
const unpublishedProduct = {
  productId: kitIdentities.products.unpublished,
};
const crmInput = { customerId: kitIdentities.crmSentinel };
const followedCompany = { companyId: kitIdentities.companies.a };
const unfollowedCompany = { companyId: randomUUID() };
const shareOwn = {
  token: kitShareTokens.a,
  documentId: kitShareDocuments.a.id,
};
const shareForeign = {
  token: kitShareTokens.a,
  documentId: kitShareDocuments.b.id,
};
const shareExpired = {
  token: kitShareTokens.expired,
  documentId: kitShareDocuments.a.id,
};
const shareRevoked = {
  token: kitShareTokens.revoked,
  documentId: kitShareDocuments.a.id,
};
const shareMismatched = {
  token: kitShareTokens.b,
  documentId: kitShareDocuments.a.id,
};

function shareIsolationFor(action: SuiteAction) {
  return shareIsolationCase(action, {
    own: { input: shareOwn },
    foreign: { input: shareForeign },
    expired: { input: shareExpired },
    revoked: { input: shareRevoked },
    mismatched: { input: shareMismatched },
    rawToken: kitShareTokens.a,
  });
}

function correctCrossTenantCases() {
  return [
    isolationCase(
      correct.staffGetProduct,
      { input: ownProduct },
      { input: foreignProduct },
    ),
    isolationCase(
      correct.staffPublishProduct,
      { input: ownProduct },
      { input: foreignProduct },
      { missing: { input: missingProduct } },
    ),
    isolationCase(
      correct.customerGetOwnCrm,
      { input: crmInput, userId: kitIdentities.users.boris },
      { input: crmInput, userId: kitIdentities.users.anna },
    ),
    isolationCase(
      correct.publicGetPublishedProduct,
      { input: ownProduct },
      { input: unpublishedProduct },
    ),
    isolationCase(correct.publicBrowseDiscovery, { input: {} }, { input: {} }),
    isolationCase(
      correct.systemGetProduct,
      { input: ownProduct },
      { input: foreignProduct },
    ),
    isolationCase(correct.systemGlobalSweep, { input: {} }, { input: {} }),
    isolationCase(
      correct.consumerBrowseDiscovery,
      { input: {} },
      { input: {} },
    ),
    isolationCase(
      correct.accountListMine,
      { input: {}, userId: kitIdentities.users.anna },
      { input: {}, userId: kitIdentities.users.boris },
    ),
    isolationCase(
      correct.accountConfirmFollow,
      { input: followedCompany, userId: kitIdentities.users.anna },
      { input: followedCompany, userId: kitIdentities.users.boris },
      {
        missing: { input: unfollowedCompany, userId: kitIdentities.users.anna },
      },
    ),
    isolationCase(
      correct.shareGetDocument,
      { input: shareOwn },
      { input: shareForeign },
    ),
  ];
}

beforeAll(async () => {
  kit = await createTestKit();
  leaky = createLeakyFixtureActions(kit.db.runtime.db);
});

afterAll(async () => {
  await kit.db.close();
});

describe("buildTestContext — seven principal modes", () => {
  it("builds a staff context from the verified membership row", async () => {
    const ctx = await kit.buildTestContext("staff");
    expect(ctx.principal).toBe("staff");
    if (ctx.principal !== "staff") return;
    expect(ctx.userId).toBe(kitIdentities.users.anna);
    expect(ctx.companyId).toBe(kitIdentities.companies.a);
    expect(effectiveCompanyId(ctx)).toBe(kitIdentities.companies.a);
  });

  it("builds a customer context from the typed resolver", async () => {
    const ctx = await kit.buildTestContext("customer");
    expect(ctx.principal).toBe("customer");
    if (ctx.principal !== "customer") return;
    expect(ctx.userId).toBe(kitIdentities.users.boris);
    expect(ctx.target.companyId).toBe(kitIdentities.companies.a);
    expect(effectiveCompanyId(ctx)).toBe(kitIdentities.companies.a);
  });

  it("builds a public-target context for a published resource", async () => {
    const ctx = await kit.buildTestContext("public", { publicScope: "target" });
    expect(ctx.principal).toBe("public");
    if (ctx.principal !== "public" || ctx.scope !== "target") return;
    expect(ctx.target.companyId).toBe(kitIdentities.companies.a);
    expect(effectiveCompanyId(ctx)).toBe(kitIdentities.companies.a);
  });

  it("builds a public-global context bound to the fixture grant", async () => {
    const ctx = await kit.buildTestContext("public");
    expect(ctx.principal).toBe("public");
    if (ctx.principal !== "public" || ctx.scope !== "globalProjection") return;
    expect(ctx.projectionGrant).toBe("fixture.discovery");
    expect(effectiveCompanyId(ctx)).toBeNull();
    expect(ctx.actor).toEqual({ type: "anonymous", id: "anonymous" });
  });

  it("builds a tenant-scoped system context", async () => {
    const ctx = await kit.buildTestContext("system");
    expect(ctx.principal).toBe("system");
    if (ctx.principal !== "system" || ctx.scope !== "tenant") return;
    expect(ctx.companyId).toBe(kitIdentities.companies.a);
    expect(effectiveCompanyId(ctx)).toBe(kitIdentities.companies.a);
  });

  it("builds a consumer context with a session and no company", async () => {
    const ctx = await kit.buildTestContext("consumer");
    expect(ctx.principal).toBe("consumer");
    if (ctx.principal !== "consumer") return;
    expect(ctx.userId).toBe(kitIdentities.users.anna);
    expect(effectiveCompanyId(ctx)).toBeNull();
  });

  it("builds an account context with a session and no company", async () => {
    const ctx = await kit.buildTestContext("account");
    expect(ctx.principal).toBe("account");
    if (ctx.principal !== "account") return;
    expect(ctx.userId).toBe(kitIdentities.users.anna);
    expect(effectiveCompanyId(ctx)).toBeNull();
  });

  it("builds a share context from the hashed token without a session", async () => {
    const ctx = await kit.buildTestContext("share");
    expect(ctx.principal).toBe("share");
    if (ctx.principal !== "share") return;
    expect(ctx.actor).toEqual({ type: "anonymous", id: "anonymous" });
    expect(ctx.target.companyId).toBe(kitIdentities.companies.a);
    expect(effectiveCompanyId(ctx)).toBe(kitIdentities.companies.a);
    expect(ctx.userId).toBeUndefined();
  });
});

crossTenantSuite(() => kit, correctCrossTenantCases());
publicProjectionSuite(() => kit, [browseCase(correct.publicBrowseDiscovery)]);
consumerIsolationSuite(
  () => kit,
  [browseCase(correct.consumerBrowseDiscovery)],
);
accountIsolationSuite(
  () => kit,
  [
    isolationCase(
      correct.accountListMine,
      { input: {}, userId: kitIdentities.users.anna },
      { input: {}, userId: kitIdentities.users.boris },
    ),
  ],
);
shareIsolationSuite(
  () => kit,
  [
    shareIsolationFor(correct.shareGetDocument),
    shareIsolationFor(correct.shareSubmitSignature),
  ],
);

describe("createTestKit ships the confirmation hook", () => {
  it("issues a preview card and executes on the challenge", async () => {
    const request = {
      idempotencyKey: randomUUID(),
      requireConfirmation: true as const,
    };
    const challenged = await kit
      .invoke(correct.staffPublishProduct, ownProduct, {}, { request })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(challenged).toBeInstanceOf(ConfirmationRequiredError);
    if (!(challenged instanceof ConfirmationRequiredError)) return;
    expect(challenged.challenge.preview?.title).toBe("Publish product");
    const output = await kit.invoke(
      correct.staffPublishProduct,
      ownProduct,
      {},
      {
        request: {
          ...request,
          confirmationChallengeId: challenged.challenge.challengeId,
        },
      },
    );
    expect(output).toEqual({
      productId: kitIdentities.products.published,
      published: true,
    });
  });
});

describe("suites fail on seeded violations", () => {
  it("detects a staff handler that ignores company scope", async () => {
    await expect(
      runCrossTenantCase(
        kit,
        isolationCase(
          leaky.staffGetProduct,
          { input: ownProduct },
          { input: foreignProduct },
        ),
      ),
    ).rejects.toThrow(/expected foreign access/);
  });

  it("detects a preview case that declares neither a probe nor the exemption", async () => {
    await expect(
      runCrossTenantCase(
        kit,
        isolationCase(
          correct.staffPublishProduct,
          { input: ownProduct },
          { input: foreignProduct },
        ),
      ),
    ).rejects.toThrow(/must declare a missing-reference probe/);
  });

  it("accepts the no-reference exemption on an input that names no row", async () => {
    await expect(
      runCrossTenantCase(
        kit,
        isolationCase(
          correct.staffAnnounceSale,
          { input: announcement },
          { input: announcement, companyId: kitIdentities.companies.b },
          { noReference: true },
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects the no-reference exemption on an input that carries a uuid", async () => {
    await expect(
      runCrossTenantCase(
        kit,
        isolationCase(
          correct.staffPublishProduct,
          { input: ownProduct },
          { input: ownProduct, companyId: kitIdentities.companies.b },
          { noReference: true },
        ),
      ),
    ).rejects.toThrow(/input schema carries a uuid field/);
  });

  it("accepts an actor-varying preview case that probes a missing reference", async () => {
    await expect(
      runCrossTenantCase(
        kit,
        isolationCase(
          correct.staffPublishProduct,
          { input: ownProduct },
          { input: ownProduct, companyId: kitIdentities.companies.b },
          {
            missing: {
              input: missingProduct,
              companyId: kitIdentities.companies.b,
            },
          },
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it("detects a preview that tells a foreign id apart from a missing one", async () => {
    await expect(
      runCrossTenantCase(
        kit,
        isolationCase(
          leaky.staffPublishProduct,
          { input: ownProduct },
          { input: foreignProduct },
          { missing: { input: missingProduct } },
        ),
      ),
    ).rejects.toThrow(
      /PERMISSION_DENIED .* where a missing one gets NOT_FOUND/,
    );
  });

  it("detects a preview that refuses a foreign id differently from execution", async () => {
    await expect(
      runCrossTenantCase(
        kit,
        isolationCase(
          leaky.staffPublishProductDenyingAtPreview,
          { input: ownProduct },
          { input: foreignProduct },
          { missing: { input: missingProduct } },
        ),
      ),
    ).rejects.toThrow(
      /preview refused a foreign reference with PERMISSION_DENIED .* but execution refuses it with NOT_FOUND/,
    );
  });

  it("detects a preview that names the owner of a foreign id", async () => {
    await expect(
      runCrossTenantCase(
        kit,
        isolationCase(
          leaky.staffPublishProductNamingTheOwner,
          { input: ownProduct },
          { input: foreignProduct },
          { missing: { input: missingProduct } },
        ),
      ),
    ).rejects.toThrow(/belongs to another company/);
  });

  it("detects a preview that cards a foreign id", async () => {
    await expect(
      runCrossTenantCase(
        kit,
        isolationCase(
          leaky.staffPublishProductCardingAnyProduct,
          { input: ownProduct },
          { input: foreignProduct },
          { missing: { input: missingProduct } },
        ),
      ),
    ).rejects.toThrow(/a foreign reference got a confirmation card/);
  });

  it("detects a customer resolver that skips ownership", async () => {
    await expect(
      runCrossTenantCase(
        kit,
        isolationCase(
          leaky.customerGetOwnCrm,
          { input: crmInput, userId: kitIdentities.users.boris },
          { input: crmInput, userId: kitIdentities.users.anna },
        ),
      ),
    ).rejects.toThrow(/expected foreign access/);
  });

  it("detects a public-target resolver that returns unpublished resources", async () => {
    await expect(
      runCrossTenantCase(
        kit,
        isolationCase(
          leaky.publicGetPublishedProduct,
          { input: ownProduct },
          { input: unpublishedProduct },
        ),
      ),
    ).rejects.toThrow(/expected foreign access/);
  });

  it("detects a public-global handler that scans domain tables", async () => {
    await expect(
      runPublicProjectionCase(kit, browseCase(leaky.publicBrowseDiscovery)),
    ).rejects.toThrow(/leaked/);
  });

  it("detects a system handler that ignores tenant scope", async () => {
    await expect(
      runCrossTenantCase(
        kit,
        isolationCase(
          leaky.systemGetProduct,
          { input: ownProduct },
          { input: foreignProduct },
        ),
      ),
    ).rejects.toThrow(/expected foreign access/);
  });

  it("accepts a system-global job without a foreign deny", async () => {
    await expect(
      runCrossTenantCase(
        kit,
        isolationCase(correct.systemGlobalSweep, { input: {} }, { input: {} }),
      ),
    ).resolves.toBeUndefined();
  });

  it("detects a consumer handler that returns unpublished products", async () => {
    await expect(
      runConsumerIsolationCase(kit, browseCase(leaky.consumerBrowseDiscovery)),
    ).rejects.toThrow(/leaked/);
  });

  it("detects a consumer handler that writes a CRM row", async () => {
    await expect(
      runConsumerIsolationCase(
        kit,
        browseCase(createCrmWritingConsumerBrowse(kit.db.runtime.db)),
      ),
    ).rejects.toThrow(/CRM sentinel/);
  });

  it("detects an account handler that returns another user's companies", async () => {
    await expect(
      runAccountIsolationCase(
        kit,
        isolationCase(
          leaky.accountListMine,
          { input: {}, userId: kitIdentities.users.anna },
          { input: {}, userId: kitIdentities.users.boris },
        ),
      ),
    ).rejects.toThrow(/leaked user [AB]/);
  });

  it("detects an account handler that writes a company-scoped audit/event row", async () => {
    await expect(
      runAccountIsolationCase(
        kit,
        isolationCase(
          leaky.accountWritesCompanyScope,
          { input: {}, userId: kitIdentities.users.anna },
          { input: {}, userId: kitIdentities.users.boris },
        ),
      ),
    ).rejects.toThrow(/company_id=/);
  });

  it("detects a consumer action that is not rate-limited at 60/min", async () => {
    await expect(
      assertUserRateLimit(
        kit,
        correct.consumerBrowseDiscovery,
        { input: {}, userId: kitIdentities.users.anna },
        { enforce: () => Promise.resolve() },
      ),
    ).rejects.toThrow(/did not rate-limit/);
  });

  it("detects an account action that is not rate-limited at 90/min", async () => {
    await expect(
      assertUserRateLimit(
        kit,
        correct.accountListMine,
        { input: {}, userId: kitIdentities.users.anna },
        { enforce: () => Promise.resolve() },
      ),
    ).rejects.toThrow(/did not rate-limit/);
  });

  it("detects a share resolver that lets token A reach token B's resource", async () => {
    await expect(
      runShareIsolationCase(kit, shareIsolationFor(leaky.shareGetDocument)),
    ).rejects.toThrow(/expected foreign-token access/);
  });

  it("detects a share write that inserts a CRM row", async () => {
    await expect(
      runShareIsolationCase(kit, shareIsolationFor(leaky.shareWritesCrm)),
    ).rejects.toThrow(/CRM sentinel/);
  });
});
