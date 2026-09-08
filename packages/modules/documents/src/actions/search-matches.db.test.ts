import { randomUUID } from "node:crypto";

import { PermissionDeniedError, ValidationError } from "@showzy/core/errors";
import {
  createTestKit,
  crossTenantSuite,
  isolationCase,
  kitIdentities,
  type TestKit,
} from "@showzy/core/testing";
import { user } from "@showzy/db/schema/auth";
import { companyMembers } from "@showzy/db/schema/companies";
import { documents } from "@showzy/db/schema/documents";
import { orders } from "@showzy/db/schema/orders";
import {
  canonicalizeDocumentNumberQuery,
  canonicalizeOrderNumberToken,
  SEARCH_QUERY_MAX,
  type SearchHit,
} from "@showzy/validation/search";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DELIVERY_NOTE_TYPE_CODE,
  formatDocumentNumber,
  PAYMENT_INVOICE_TYPE_CODE,
} from "../services/document-number.js";
import { documentNumberLeftPrefixPattern } from "../services/search-matches.js";
import { searchMatches } from "./search-matches.js";

const COMPANY_A_PREFIX = "KA";
const COMPANY_B_PREFIX = "MB";
const SEQ_BOTH = 1n;
const SEQ_CANCELLED = 2n;
const SEQ_PREFIX_SIBLING = 10n;
const SEQ_EXACT_WINDOW = 999999n;
const SEQ_WINDOW_SIBLING_START = 9999990n;

const fixtures = {
  invoice1: randomUUID(),
  delivery1: randomUUID(),
  invoiceCancelled: randomUUID(),
  invoice10: randomUUID(),
  foreignInvoice1: randomUUID(),
  foreignDelivery1: randomUUID(),
  orderBoth: randomUUID(),
  orderCancelled: randomUUID(),
  order10: randomUUID(),
  orderForeign: randomUUID(),
};

const clerks = {
  noView: randomUUID(),
  viewer: randomUUID(),
};

const sellerSnapshot = {
  kind: "seller" as const,
  name: "Konditerska Anna",
  prefix: COMPANY_A_PREFIX,
  companyType: "tov" as const,
  legalName: "ТОВ Альфа",
  edrpou: "12345678",
  legalAddress: "вул. Хрещатик, 1",
  iban: "UA123456789012345678901234567",
  bankName: "ПриватБанк",
  bankMfo: "300001",
  bankEdrpou: "12345678",
  phone: "+380501111111",
  email: "legal@alpha.test",
};

const buyerSnapshot = {
  kind: "customer" as const,
  displayName: "Fixture customer",
};

let kit: TestKit;

async function insertOrder(values: {
  id: string;
  companyId: string;
  orderNumber: string;
}): Promise<void> {
  await kit.db.runtime.db.insert(orders).values({
    id: values.id,
    companyId: values.companyId,
    orderNumber: values.orderNumber,
    customerId: null,
    customerNameSnapshot: "Fixture customer",
    status: "new",
    totalNetMinor: 100n,
    totalTaxMinor: 0n,
    totalGrossMinor: 100n,
    currency: "UAH",
  });
}

async function insertDocument(values: {
  id: string;
  companyId: string;
  orderId: string;
  type: "payment_invoice" | "delivery_note";
  sequence: bigint;
  prefix: string;
  status?: "issued" | "cancelled";
}): Promise<string> {
  const documentNumber = formatDocumentNumber(
    values.prefix,
    values.type,
    values.sequence,
  );
  await kit.db.runtime.db.insert(documents).values({
    id: values.id,
    companyId: values.companyId,
    orderId: values.orderId,
    counterpartyId: null,
    type: values.type,
    status: values.status ?? "issued",
    documentNumber,
    issuedOn: "2026-03-15",
    supplierDetails: {
      ...sellerSnapshot,
      prefix: values.prefix,
    },
    buyerDetails: buyerSnapshot,
    totalNetMinor: 100n,
    totalTaxMinor: 0n,
    totalGrossMinor: 100n,
    currency: "UAH",
    templateSource: "system",
    templateName: values.type,
  });
  return documentNumber;
}

beforeAll(async () => {
  expect(
    formatDocumentNumber(COMPANY_A_PREFIX, "payment_invoice", SEQ_BOTH),
  ).toBe("KA-РХ-000001");
  expect(
    formatDocumentNumber(COMPANY_A_PREFIX, "delivery_note", SEQ_BOTH),
  ).toBe("KA-ВН-000001");
  expect(canonicalizeOrderNumberToken("000001", COMPANY_A_PREFIX)).toBe(
    "KA-000001",
  );
  expect(canonicalizeDocumentNumberQuery("000001", COMPANY_A_PREFIX)).toEqual({
    kind: "seq",
    sequence: "000001",
  });
  expect(canonicalizeDocumentNumberQuery("1", COMPANY_A_PREFIX)).toEqual({
    kind: "seq",
    sequence: "000001",
  });
  expect(
    canonicalizeDocumentNumberQuery(COMPANY_A_PREFIX, COMPANY_A_PREFIX),
  ).toEqual({
    kind: "none",
  });

  kit = await createTestKit();

  await insertOrder({
    id: fixtures.orderBoth,
    companyId: kitIdentities.companies.a,
    orderNumber: "T-BOTH",
  });
  await insertOrder({
    id: fixtures.orderCancelled,
    companyId: kitIdentities.companies.a,
    orderNumber: "T-CANC",
  });
  await insertOrder({
    id: fixtures.order10,
    companyId: kitIdentities.companies.a,
    orderNumber: "T-TEN",
  });
  await insertOrder({
    id: fixtures.orderForeign,
    companyId: kitIdentities.companies.b,
    orderNumber: "T-FOR",
  });

  await insertDocument({
    id: fixtures.invoice1,
    companyId: kitIdentities.companies.a,
    orderId: fixtures.orderBoth,
    type: "payment_invoice",
    sequence: SEQ_BOTH,
    prefix: COMPANY_A_PREFIX,
  });
  await insertDocument({
    id: fixtures.delivery1,
    companyId: kitIdentities.companies.a,
    orderId: fixtures.orderBoth,
    type: "delivery_note",
    sequence: SEQ_BOTH,
    prefix: COMPANY_A_PREFIX,
  });
  await insertDocument({
    id: fixtures.invoiceCancelled,
    companyId: kitIdentities.companies.a,
    orderId: fixtures.orderCancelled,
    type: "payment_invoice",
    sequence: SEQ_CANCELLED,
    prefix: COMPANY_A_PREFIX,
    status: "cancelled",
  });
  await insertDocument({
    id: fixtures.invoice10,
    companyId: kitIdentities.companies.a,
    orderId: fixtures.order10,
    type: "payment_invoice",
    sequence: SEQ_PREFIX_SIBLING,
    prefix: COMPANY_A_PREFIX,
  });
  await insertDocument({
    id: fixtures.foreignInvoice1,
    companyId: kitIdentities.companies.b,
    orderId: fixtures.orderForeign,
    type: "payment_invoice",
    sequence: SEQ_BOTH,
    prefix: COMPANY_B_PREFIX,
  });
  await insertDocument({
    id: fixtures.foreignDelivery1,
    companyId: kitIdentities.companies.b,
    orderId: fixtures.orderForeign,
    type: "delivery_note",
    sequence: SEQ_BOTH,
    prefix: COMPANY_B_PREFIX,
  });

  const explainSeed = Array.from({ length: 40 }, (_, index) => ({
    orderId: randomUUID(),
    id: randomUUID(),
    sequence: 500n + BigInt(index),
  }));
  await kit.db.runtime.db.insert(orders).values(
    explainSeed.map((row, index) => ({
      id: row.orderId,
      companyId: kitIdentities.companies.a,
      orderNumber: `T-EX${String(index).padStart(2, "0")}`,
      customerId: null,
      customerNameSnapshot: "Fixture customer",
      status: "new" as const,
      totalNetMinor: 100n,
      totalTaxMinor: 0n,
      totalGrossMinor: 100n,
      currency: "UAH" as const,
    })),
  );
  await kit.db.runtime.db.insert(documents).values(
    explainSeed.map((row) => ({
      id: row.id,
      companyId: kitIdentities.companies.a,
      orderId: row.orderId,
      counterpartyId: null,
      type: "payment_invoice" as const,
      status: "issued" as const,
      documentNumber: formatDocumentNumber(
        COMPANY_A_PREFIX,
        "payment_invoice",
        row.sequence,
      ),
      issuedOn: "2026-03-15",
      supplierDetails: sellerSnapshot,
      buyerDetails: buyerSnapshot,
      totalNetMinor: 100n,
      totalTaxMinor: 0n,
      totalGrossMinor: 100n,
      currency: "UAH" as const,
      templateSource: "system" as const,
      templateName: "payment_invoice",
    })),
  );

  await kit.db.runtime.db.insert(user).values([
    {
      id: clerks.noView,
      name: "No view",
      email: "no-view-documents-search@kit.test",
    },
    {
      id: clerks.viewer,
      name: "Viewer",
      email: "viewer-documents-search@kit.test",
    },
  ]);
  await kit.db.runtime.db.insert(companyMembers).values([
    {
      companyId: kitIdentities.companies.a,
      userId: clerks.noView,
      role: "employee",
      permissions: { granted: [], denied: ["documents:view"] },
    },
    {
      companyId: kitIdentities.companies.a,
      userId: clerks.viewer,
      role: "employee",
      permissions: {
        granted: ["documents:view", "companies:view"],
        denied: ["orders:view"],
      },
    },
  ]);

  await kit.db.admin.query("ANALYZE documents");
});

afterAll(async () => {
  await kit.db.close();
});

crossTenantSuite(
  () => kit,
  [
    isolationCase(
      searchMatches,
      { input: { query: "000001" } },
      {
        input: { query: "000001" },
        companyId: kitIdentities.companies.b,
        userId: kitIdentities.users.anna,
      },
    ),
  ],
);

describe("documents.searchMatches", () => {
  it("returns empty groups without error for empty or punctuation-only queries", async () => {
    const empty = { groups: [] };
    expect(await kit.invoke(searchMatches, { query: "" })).toEqual(empty);
    expect(await kit.invoke(searchMatches, { query: "   " })).toEqual(empty);
    expect(await kit.invoke(searchMatches, { query: "..." })).toEqual(empty);
    expect(await kit.invoke(searchMatches, { query: "!!! ???" })).toEqual(
      empty,
    );
    expect(await kit.invoke(searchMatches, { query: "%%%" })).toEqual(empty);
    expect(await kit.invoke(searchMatches, { query: "#" })).toEqual(empty);
  });

  it("matches a full canonical number, hash, and case as exact", async () => {
    const canonical = formatDocumentNumber(
      COMPANY_A_PREFIX,
      "payment_invoice",
      SEQ_BOTH,
    );
    const queries = [canonical, `#${canonical.toLocaleLowerCase("uk")}`];
    for (const query of queries) {
      const listed = await kit.invoke(searchMatches, { query });
      const hit = documentGroup(listed)?.hits.find(
        (row) => row.id === fixtures.invoice1,
      );
      expect(hit).toEqual(
        expect.objectContaining({
          id: fixtures.invoice1,
          label: canonical,
          sublabel: PAYMENT_INVOICE_TYPE_CODE,
          matchedOn: "number",
          exact: true,
          status: "issued",
        }),
      );
      expect(hitIds(documentGroup(listed))).toEqual([fixtures.invoice1]);
      expect(hit).not.toHaveProperty("productId");
    }
  });

  it("matches type-code + seq with the company prefix prepended", async () => {
    const listed = await kit.invoke(searchMatches, { query: "РХ-000001" });
    const hit = documentGroup(listed)?.hits.find(
      (row) => row.id === fixtures.invoice1,
    );
    expect(hit?.matchedOn).toBe("number");
    expect(hit?.exact).toBe(true);
    expect(hit?.sublabel).toBe(PAYMENT_INVOICE_TYPE_CODE);
    expect(hitIds(documentGroup(listed))).toEqual([fixtures.invoice1]);
    expect(hitIds(documentGroup(listed))).not.toContain(fixtures.delivery1);
  });

  it("matches numeric seq 000001 and 1 as both types, exact false", async () => {
    for (const query of ["000001", "1"]) {
      const listed = await kit.invoke(searchMatches, { query });
      const ids = hitIds(documentGroup(listed));
      expect(ids).toEqual(
        expect.arrayContaining([fixtures.invoice1, fixtures.delivery1]),
      );
      expect(ids).toHaveLength(2);
      expect(ids).not.toContain(fixtures.foreignInvoice1);
      for (const hit of documentGroup(listed)?.hits ?? []) {
        expect(hit.matchedOn).toBe("number");
        expect(hit.exact).toBe(false);
      }
      const invoice = documentGroup(listed)?.hits.find(
        (row) => row.id === fixtures.invoice1,
      );
      const delivery = documentGroup(listed)?.hits.find(
        (row) => row.id === fixtures.delivery1,
      );
      expect(invoice?.sublabel).toBe(PAYMENT_INVOICE_TYPE_CODE);
      expect(delivery?.sublabel).toBe(DELIVERY_NOTE_TYPE_CODE);
    }
  });

  it("marks a numeric seq exact when only one type remains", async () => {
    const listed = await kit.invoke(searchMatches, { query: "000002" });
    expect(hitIds(documentGroup(listed))).toEqual([fixtures.invoiceCancelled]);
    const hit = documentGroup(listed)?.hits[0];
    expect(hit?.matchedOn).toBe("number");
    expect(hit?.exact).toBe(true);
    expect(hit?.status).toBe("cancelled");
    expect(hit?.sublabel).toBe(PAYMENT_INVOICE_TYPE_CODE);
  });

  it("does not match documents by number when the query is the company prefix alone", async () => {
    const listed = await kit.invoke(searchMatches, { query: COMPANY_A_PREFIX });
    const hashed = await kit.invoke(searchMatches, {
      query: `#${COMPANY_A_PREFIX.toLowerCase()}`,
    });
    expect(listed).toEqual({ groups: [] });
    expect(hashed).toEqual({ groups: [] });
  });

  it("matches left-prefix on a canonical full number and is never exact", async () => {
    const listed = await kit.invoke(searchMatches, { query: "РХ-0000" });
    const ids = hitIds(documentGroup(listed));
    expect(ids).toEqual(
      expect.arrayContaining([
        fixtures.invoice1,
        fixtures.invoiceCancelled,
        fixtures.invoice10,
      ]),
    );
    expect(ids).toHaveLength(3);
    expect(ids).not.toContain(fixtures.delivery1);
    expect(ids).not.toContain(fixtures.foreignInvoice1);
    for (const hit of documentGroup(listed)?.hits ?? []) {
      expect(hit.matchedOn).toBe("number");
      expect(hit.exact).toBe(false);
      expect(hit.sublabel).toBe(PAYMENT_INVOICE_TYPE_CODE);
    }
  });

  it("returns cancelled documents with status and does not hide them", async () => {
    const canonical = formatDocumentNumber(
      COMPANY_A_PREFIX,
      "payment_invoice",
      SEQ_CANCELLED,
    );
    const listed = await kit.invoke(searchMatches, { query: canonical });
    const hit = documentGroup(listed)?.hits.find(
      (row) => row.id === fixtures.invoiceCancelled,
    );
    expect(hit?.status).toBe("cancelled");
    expect(hit?.exact).toBe(true);
    expect(hit?.matchedOn).toBe("number");
    expect(hit?.label).toBe(canonical);
  });

  it("keeps another company's documents out of this tenant", async () => {
    const listed = await kit.invoke(searchMatches, { query: "000001" });
    expect(hitIds(documentGroup(listed))).toEqual(
      expect.arrayContaining([fixtures.invoice1, fixtures.delivery1]),
    );
    expect(hitIds(documentGroup(listed))).not.toContain(
      fixtures.foreignInvoice1,
    );
    expect(hitIds(documentGroup(listed))).not.toContain(
      fixtures.foreignDelivery1,
    );

    const other = await kit.invoke(
      searchMatches,
      { query: "000001" },
      {
        companyId: kitIdentities.companies.b,
        userId: kitIdentities.users.boris,
      },
    );
    expect(hitIds(documentGroup(other))).toEqual(
      expect.arrayContaining([
        fixtures.foreignInvoice1,
        fixtures.foreignDelivery1,
      ]),
    );
    expect(hitIds(documentGroup(other))).toHaveLength(2);
    expect(hitIds(documentGroup(other))).not.toContain(fixtures.invoice1);
  });

  it("denies staff without documents:view", async () => {
    await expect(
      kit.invoke(
        searchMatches,
        { query: "000001" },
        { userId: clerks.noView, companyId: kitIdentities.companies.a },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("still matches by number for staff with documents:view and companies:view", async () => {
    const listed = await kit.invoke(
      searchMatches,
      { query: "РХ-000001" },
      { userId: clerks.viewer, companyId: kitIdentities.companies.a },
    );
    const hit = documentGroup(listed)?.hits.find(
      (row) => row.id === fixtures.invoice1,
    );
    expect(hit?.matchedOn).toBe("number");
    expect(hit?.exact).toBe(true);
  });

  it("truncates at limitPerType and keeps an exact number first in the SQL window", async () => {
    const canonical = formatDocumentNumber(
      COMPANY_A_PREFIX,
      "payment_invoice",
      SEQ_EXACT_WINDOW,
    );
    expect(canonical).toBe("KA-РХ-999999");
    expect(
      formatDocumentNumber(
        COMPANY_A_PREFIX,
        "payment_invoice",
        SEQ_WINDOW_SIBLING_START,
      ),
    ).toBe("KA-РХ-9999990");
    const exactId = randomUUID();
    const weakIds: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const id = randomUUID();
      const orderId = randomUUID();
      weakIds.push(id);
      await insertOrder({
        id: orderId,
        companyId: kitIdentities.companies.a,
        orderNumber: `T-WIN${String(index).padStart(2, "0")}`,
      });
      await insertDocument({
        id,
        companyId: kitIdentities.companies.a,
        orderId,
        type: "payment_invoice",
        sequence: SEQ_WINDOW_SIBLING_START + BigInt(index),
        prefix: COMPANY_A_PREFIX,
      });
    }
    const exactOrderId = randomUUID();
    await insertOrder({
      id: exactOrderId,
      companyId: kitIdentities.companies.a,
      orderNumber: "T-WINX",
    });
    await insertDocument({
      id: exactId,
      companyId: kitIdentities.companies.a,
      orderId: exactOrderId,
      type: "payment_invoice",
      sequence: SEQ_EXACT_WINDOW,
      prefix: COMPANY_A_PREFIX,
    });

    const listed = await kit.invoke(searchMatches, {
      query: canonical,
      limitPerType: 5,
    });
    expect(documentGroup(listed)?.truncated).toBe(true);
    expect(hitIds(documentGroup(listed))).toHaveLength(5);
    expect(hitIds(documentGroup(listed))[0]).toBe(exactId);
    expect(documentGroup(listed)?.hits[0]?.exact).toBe(true);
    expect(documentGroup(listed)?.hits[0]?.matchedOn).toBe("number");
    expect(weakIds).toEqual(
      expect.arrayContaining(hitIds(documentGroup(listed)).slice(1)),
    );
  });

  it("rejects oversize query, extras, and companyId in input", async () => {
    await expect(
      kit.invoke(searchMatches, { query: "x".repeat(SEARCH_QUERY_MAX + 1) }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(searchMatches, {
        query: "000001",
        types: ["document"],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      kit.invoke(searchMatches, {
        query: "000001",
        companyId: kitIdentities.companies.b,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("uses an index for left-prefix LIKE on document_number", async () => {
    const parsed = canonicalizeDocumentNumberQuery(
      "РХ-00001",
      COMPANY_A_PREFIX,
    );
    expect(parsed).toEqual({
      kind: "canonical",
      value: "KA-РХ-00001",
    });
    const pattern = documentNumberLeftPrefixPattern(
      parsed.kind === "canonical" ? parsed.value : "",
    );
    expect(pattern).toBe("KA-РХ-00001%");
    expect(pattern?.includes("%")).toBe(true);
    expect(pattern?.startsWith("%")).toBe(false);

    const compiled = kit.db.runtime.db
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          eq(documents.companyId, kitIdentities.companies.a),
          sql`${documents.documentNumber} LIKE ${pattern}`,
        ),
      )
      .toSQL();

    await kit.db.admin.query("BEGIN");
    try {
      await kit.db.admin.query("SET LOCAL enable_seqscan = off");
      const explained = await kit.db.admin.query<{ "QUERY PLAN": string }>(
        `EXPLAIN ${compiled.sql}`,
        compiled.params,
      );
      const plan = explained.rows.map((row) => row["QUERY PLAN"]).join("\n");
      const indexCond = plan
        .split("\n")
        .filter((line) => /Index Cond:/i.test(line))
        .join("\n");
      expect(plan).toMatch(/Index (Only )?Scan|Bitmap Index Scan/);
      expect(indexCond).toMatch(/document_number/);
      expect(indexCond).toMatch(/~~|~>=~|~<~/);
      expect(plan).not.toMatch(/\bSeq Scan\b/);
    } finally {
      await kit.db.admin.query("ROLLBACK");
    }
  });
});

type SearchMatchesResult = {
  groups: ReadonlyArray<{
    type: "document";
    hits: readonly SearchHit[];
    truncated: boolean;
  }>;
};

function documentGroup(result: SearchMatchesResult) {
  return result.groups[0];
}

function hitIds(group: { hits: readonly SearchHit[] } | undefined): string[] {
  return group?.hits.map((hit) => hit.id) ?? [];
}
