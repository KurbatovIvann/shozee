import { randomUUID } from "node:crypto";

import {
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from "@showzy/core/errors";
import {
  createTestKit,
  crossTenantSuite,
  idempotencySuite,
  isolationCase,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { auditLog, domainEvents } from "@showzy/db";
import { user } from "@showzy/db/schema/auth";
import { productMedia, products } from "@showzy/db/schema/catalog";
import { companyMembers } from "@showzy/db/schema/companies";
import { files } from "@showzy/db/schema/files";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getProduct } from "./get-product.js";
import { SET_PRODUCT_IMAGES_MAX } from "./set-product-images.contract.js";
import { setProductImages } from "./set-product-images.js";

const fixtures = {
  productHappy: randomUUID(),
  productIsolationA: randomUUID(),
  productIsolationB: randomUUID(),
  productIdem: randomUUID(),
  productForeign: randomUUID(),
  fileJpeg: randomUUID(),
  filePng: randomUUID(),
  fileWebp: randomUUID(),
  filePending: randomUUID(),
  fileB: randomUUID(),
  fileIdem: randomUUID(),
  fileIdemConflict: randomUUID(),
};

const clerks = {
  noEdit: randomUUID(),
  noFiles: randomUUID(),
};

let kit: TestKit;

async function insertProduct(values: {
  id: string;
  companyId: string;
  name: string;
}): Promise<void> {
  await kit.db.runtime.db.insert(products).values({
    id: values.id,
    companyId: values.companyId,
    name: values.name,
    basePriceMinor: 1500n,
  });
}

async function insertFile(values: {
  id: string;
  companyId: string;
  status: "pending" | "ready";
  mimeType: string;
  checksumSha256: string;
}): Promise<void> {
  await kit.db.runtime.db.insert(files).values({
    id: values.id,
    companyId: values.companyId,
    uploadedByUserId: kitIdentities.users.anna,
    purpose: "catalog",
    objectKey: `${values.companyId}/catalog/${values.id}`,
    mimeType: values.mimeType,
    byteSize: 128n,
    checksumSha256: values.checksumSha256,
    status: values.status,
  });
}

async function mediaFileIds(productId: string): Promise<string[]> {
  const rows = await kit.db.runtime.db
    .select({
      fileId: productMedia.fileId,
      position: productMedia.position,
    })
    .from(productMedia)
    .where(
      and(
        eq(productMedia.companyId, kitIdentities.companies.a),
        eq(productMedia.productId, productId),
      ),
    )
    .orderBy(asc(productMedia.position), asc(productMedia.id));
  return rows.map((row) => row.fileId);
}

async function countSetImageAudits(productId: string): Promise<number> {
  const rows = await kit.db.runtime.db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "catalog.setProductImages"),
        eq(auditLog.targetId, productId),
        eq(auditLog.outcome, "ok"),
      ),
    );
  return rows.length;
}

beforeAll(async () => {
  kit = await createTestKit();
  const companyA = kitIdentities.companies.a;
  const companyB = kitIdentities.companies.b;

  await insertProduct({
    id: fixtures.productHappy,
    companyId: companyA,
    name: "Happy",
  });
  await insertProduct({
    id: fixtures.productIsolationA,
    companyId: companyA,
    name: "Isolation A",
  });
  await insertProduct({
    id: fixtures.productIsolationB,
    companyId: companyB,
    name: "Isolation B",
  });
  await insertProduct({
    id: fixtures.productIdem,
    companyId: companyA,
    name: "Idem",
  });
  await insertProduct({
    id: fixtures.productForeign,
    companyId: companyB,
    name: "Foreign product",
  });

  await insertFile({
    id: fixtures.fileJpeg,
    companyId: companyA,
    status: "ready",
    mimeType: "image/jpeg",
    checksumSha256: "11".repeat(32),
  });
  await insertFile({
    id: fixtures.filePng,
    companyId: companyA,
    status: "ready",
    mimeType: "image/png",
    checksumSha256: "22".repeat(32),
  });
  await insertFile({
    id: fixtures.fileWebp,
    companyId: companyA,
    status: "ready",
    mimeType: "image/webp",
    checksumSha256: "33".repeat(32),
  });
  await insertFile({
    id: fixtures.filePending,
    companyId: companyA,
    status: "pending",
    mimeType: "image/jpeg",
    checksumSha256: "44".repeat(32),
  });
  await insertFile({
    id: fixtures.fileB,
    companyId: companyB,
    status: "ready",
    mimeType: "image/jpeg",
    checksumSha256: "66".repeat(32),
  });
  await insertFile({
    id: fixtures.fileIdem,
    companyId: companyA,
    status: "ready",
    mimeType: "image/jpeg",
    checksumSha256: "77".repeat(32),
  });
  await insertFile({
    id: fixtures.fileIdemConflict,
    companyId: companyA,
    status: "ready",
    mimeType: "image/png",
    checksumSha256: "88".repeat(32),
  });

  await kit.db.runtime.db.insert(user).values([
    {
      id: clerks.noEdit,
      name: "No edit",
      email: "noedit@catalog-images.test",
    },
    {
      id: clerks.noFiles,
      name: "No files",
      email: "nofiles@catalog-images.test",
    },
  ]);
  await kit.db.runtime.db.insert(companyMembers).values([
    {
      companyId: companyA,
      userId: clerks.noEdit,
      role: "employee",
      permissions: { granted: [], denied: [] },
    },
    {
      companyId: companyA,
      userId: clerks.noFiles,
      role: "employee",
      permissions: {
        granted: ["products:edit"],
        denied: ["files:view"],
      },
    },
  ]);
});

afterAll(async () => {
  await kit.db.close();
});

crossTenantSuite(
  () => kit,
  [
    isolationCase(
      setProductImages,
      {
        input: {
          productId: fixtures.productIsolationA,
          fileIds: [fixtures.fileJpeg],
        },
      },
      {
        input: {
          productId: fixtures.productIsolationB,
          fileIds: [fixtures.fileB],
        },
      },
    ),
  ],
);

idempotencySuite(
  () => kit,
  [
    {
      action: setProductImages,
      input: {
        productId: fixtures.productIdem,
        fileIds: [fixtures.fileIdem],
      },
      conflictingInput: {
        productId: fixtures.productIdem,
        fileIds: [fixtures.fileIdemConflict],
      },
      readEffect: () => countSetImageAudits(fixtures.productIdem),
    },
  ],
);

describe("catalog.setProductImages", () => {
  it("attaches, reorders, and clears in one transaction and audits once per write", async () => {
    const requestId = randomUUID();
    const attached = await kit.invoke(
      setProductImages,
      {
        productId: fixtures.productHappy,
        fileIds: [fixtures.fileJpeg, fixtures.filePng, fixtures.fileWebp],
      },
      {},
      { request: { requestId } },
    );

    expect(attached).toEqual({
      productId: fixtures.productHappy,
      fileIds: [fixtures.fileJpeg, fixtures.filePng, fixtures.fileWebp],
    });
    expect(await mediaFileIds(fixtures.productHappy)).toEqual([
      fixtures.fileJpeg,
      fixtures.filePng,
      fixtures.fileWebp,
    ]);
    const blob = JSON.stringify(attached);
    expect(blob).not.toContain("objectKey");
    expect(blob).not.toContain("object_key");
    expect(blob).not.toContain("/catalog/");
    expect(blob).not.toMatch(/https?:\/\//);

    const auditRows = await kit.db.runtime.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "catalog.setProductImages",
      companyId: kitIdentities.companies.a,
      actorType: "user",
      actorId: kitIdentities.users.anna,
      targetType: "product",
      targetId: fixtures.productHappy,
      outcome: "ok",
      inputSnapshot: null,
    });
    const eventRows = await kit.db.runtime.db
      .select({ id: domainEvents.id })
      .from(domainEvents)
      .where(eq(domainEvents.requestId, requestId));
    expect(eventRows).toEqual([]);

    const reordered = await kit.invoke(setProductImages, {
      productId: fixtures.productHappy,
      fileIds: [fixtures.fileWebp, fixtures.fileJpeg],
    });
    expect(reordered.fileIds).toEqual([fixtures.fileWebp, fixtures.fileJpeg]);
    expect(await mediaFileIds(fixtures.productHappy)).toEqual([
      fixtures.fileWebp,
      fixtures.fileJpeg,
    ]);
    const got = await kit.invoke(getProduct, {
      productId: fixtures.productHappy,
    });
    expect(got.imageFileIds).toEqual([fixtures.fileWebp, fixtures.fileJpeg]);

    const cleared = await kit.invoke(setProductImages, {
      productId: fixtures.productHappy,
      fileIds: [],
    });
    expect(cleared.fileIds).toEqual([]);
    expect(await mediaFileIds(fixtures.productHappy)).toEqual([]);
  });

  it("is idempotent by construction: a second key with the same payload leaves one ordered set", async () => {
    const payload = {
      productId: fixtures.productHappy,
      fileIds: [fixtures.filePng, fixtures.fileJpeg],
    };
    const first = await kit.invoke(setProductImages, payload);
    const second = await kit.invoke(setProductImages, payload);
    expect(first).toEqual(second);
    expect(await mediaFileIds(fixtures.productHappy)).toEqual([
      fixtures.filePng,
      fixtures.fileJpeg,
    ]);
  });

  it("denies staff without products:edit", async () => {
    await expect(
      kit.invoke(
        setProductImages,
        { productId: fixtures.productHappy, fileIds: [fixtures.fileJpeg] },
        { userId: clerks.noEdit, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("denies attach and clear alike when files:view is denied, because products:edit requires it", async () => {
    for (const fileIds of [[fixtures.fileJpeg], []]) {
      await expect(
        kit.invoke(
          setProductImages,
          { productId: fixtures.productHappy, fileIds },
          { userId: clerks.noFiles, companyId: kitIdentities.companies.a },
        ),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
    }
  });

  it("rejects an oversized batch, duplicates, and extra identifiers", async () => {
    const before = await mediaFileIds(fixtures.productHappy);
    await expect(
      kit.invoke(setProductImages, {
        productId: fixtures.productHappy,
        fileIds: Array.from({ length: SET_PRODUCT_IMAGES_MAX + 1 }, () =>
          randomUUID(),
        ),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(setProductImages, {
        productId: fixtures.productHappy,
        fileIds: [fixtures.fileJpeg, fixtures.fileJpeg],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(setProductImages, {
        productId: fixtures.productHappy,
        fileIds: [fixtures.fileJpeg],
        companyId: kitIdentities.companies.a,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await mediaFileIds(fixtures.productHappy)).toEqual(before);
  });

  it("fails the whole batch for a missing, pending, or foreign file with the same not-found", async () => {
    const before = await mediaFileIds(fixtures.productHappy);
    const missingId = randomUUID();
    const missingError = await kit
      .invoke(setProductImages, {
        productId: fixtures.productHappy,
        fileIds: [missingId],
      })
      .then(
        () => {
          throw new Error("expected NotFoundError for a missing file");
        },
        (error: unknown) => error,
      );
    const pendingError = await kit
      .invoke(setProductImages, {
        productId: fixtures.productHappy,
        fileIds: [fixtures.filePending],
      })
      .then(
        () => {
          throw new Error("expected NotFoundError for a pending file");
        },
        (error: unknown) => error,
      );
    const foreignError = await kit
      .invoke(setProductImages, {
        productId: fixtures.productHappy,
        fileIds: [fixtures.fileB],
      })
      .then(
        () => {
          throw new Error("expected NotFoundError for a foreign file");
        },
        (error: unknown) => error,
      );

    expect(missingError).toBeInstanceOf(NotFoundError);
    expect(pendingError).toBeInstanceOf(NotFoundError);
    expect(foreignError).toBeInstanceOf(NotFoundError);
    if (
      missingError instanceof NotFoundError &&
      pendingError instanceof NotFoundError &&
      foreignError instanceof NotFoundError
    ) {
      expect(missingError.clientMessage).toBe(pendingError.clientMessage);
      expect(pendingError.clientMessage).toBe(foreignError.clientMessage);
    }

    await expect(
      kit.invoke(setProductImages, {
        productId: fixtures.productHappy,
        fileIds: [fixtures.fileJpeg, fixtures.filePending],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      kit.invoke(setProductImages, {
        productId: fixtures.productHappy,
        fileIds: [fixtures.fileJpeg, fixtures.fileB],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await mediaFileIds(fixtures.productHappy)).toEqual(before);
  });

  it("fails a missing or foreign product with the same not-found", async () => {
    const missingId = randomUUID();
    const missingError = await kit
      .invoke(setProductImages, { productId: missingId, fileIds: [] })
      .then(
        () => {
          throw new Error("expected NotFoundError for a missing product");
        },
        (error: unknown) => error,
      );
    const foreignError = await kit
      .invoke(setProductImages, {
        productId: fixtures.productForeign,
        fileIds: [fixtures.fileJpeg],
      })
      .then(
        () => {
          throw new Error("expected NotFoundError for a foreign product");
        },
        (error: unknown) => error,
      );
    expect(missingError).toBeInstanceOf(NotFoundError);
    expect(foreignError).toBeInstanceOf(NotFoundError);
    if (
      missingError instanceof NotFoundError &&
      foreignError instanceof NotFoundError
    ) {
      expect(missingError.clientMessage).toBe(foreignError.clientMessage);
    }
  });
});
