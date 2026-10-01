import type { ActionCtx } from "@showzy/core";
import { products } from "@showzy/db/schema/catalog";
import type { EntityLookupOption } from "@showzy/module-kit/entity-lookup";
import {
  pickListNameSearch,
  referenceNameSearch,
} from "@showzy/module-kit/name-match";
import { normalizeReferenceQuery } from "@showzy/validation/entity-ref";
import { sanitizeLikeLiteral } from "@showzy/validation/pagination";
import { and, desc, eq, ilike } from "drizzle-orm";

type StaffDb = Extract<ActionCtx, { principal: "staff" }>["db"];

const PRODUCT_CANDIDATE_MAX = 100;

export type ProductCandidate = {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
};

const productCandidateColumns = {
  id: products.id,
  name: products.name,
  currency: products.currency,
};

export function productMatchFields(
  row: ProductCandidate,
): readonly (string | null)[] {
  return [row.name];
}

export function productCandidateName(row: ProductCandidate): string {
  return row.name;
}

export function productCandidateOptions(
  rows: readonly ProductCandidate[],
): readonly EntityLookupOption[] {
  return rows.map((row) => {
    const sameName = rows.filter((other) => other.name === row.name);
    if (sameName.length === 1) {
      return { id: row.id, label: row.name };
    }
    const sameCurrency = sameName.filter(
      (other) => other.currency === row.currency,
    );
    return sameCurrency.length === 1
      ? { id: row.id, label: `${row.name} (${row.currency})` }
      : { id: row.id, label: `${row.name} (${row.currency}, ${row.id})` };
  });
}

function mergeCandidates(
  primary: readonly ProductCandidate[],
  extra: readonly ProductCandidate[],
): ProductCandidate[] {
  const byId = new Map<string, ProductCandidate>();
  for (const row of primary) {
    byId.set(row.id, row);
  }
  for (const row of extra) {
    byId.set(row.id, row);
  }
  return [...byId.values()];
}

export async function loadProductReferenceCandidates(args: {
  readonly db: StaffDb;
  readonly companyId: string;
  readonly query: string;
}): Promise<readonly ProductCandidate[]> {
  const normalized = normalizeReferenceQuery(args.query);
  const exactPattern = sanitizeLikeLiteral(normalized);
  const search = referenceNameSearch(
    { name: products.name, nameFts: products.nameFts },
    normalized,
  );
  if (exactPattern === undefined || search === undefined) {
    return [];
  }

  const inCompany = eq(products.companyId, args.companyId);
  const nameMatchClause = await pickListNameSearch(search, async (strict) => {
    const found = await args.db
      .select({ id: products.id })
      .from(products)
      .where(and(inCompany, strict))
      .limit(1);
    return found.length > 0;
  });

  const [exactRows, relaxedRows] = await Promise.all([
    args.db
      .select(productCandidateColumns)
      .from(products)
      .where(and(inCompany, ilike(products.name, exactPattern))),
    args.db
      .select(productCandidateColumns)
      .from(products)
      .where(and(inCompany, nameMatchClause))
      .orderBy(desc(products.updatedAt), desc(products.id))
      .limit(PRODUCT_CANDIDATE_MAX),
  ]);
  return mergeCandidates(exactRows, relaxedRows);
}
