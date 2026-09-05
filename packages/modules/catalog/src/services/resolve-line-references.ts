import type { ActionCtx } from "@showzy/core";
import { CoreInvariantError, NotFoundError } from "@showzy/core/errors";
import { products, productVariants } from "@showzy/db/schema/catalog";
import { uniqueIds } from "@showzy/module-kit/unique-ids";
import {
  candidatesContainingQuery,
  normalizeReferenceQuery,
  pickUniqueNormalizedMatch,
  type EntityRef,
  type UniqueMatchResult,
} from "@showzy/validation/entity-ref";
import {
  likeContainsPattern,
  sanitizeLikeLiteral,
} from "@showzy/validation/pagination";
import { and, asc, eq, ilike, inArray, or, type SQL } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";

import {
  VARIANT_SELECTION_OPTIONS_MAX,
  type ResolveLineItemInput,
  type VariantSelection,
} from "../actions/resolve-line-references.contract.js";
import {
  ambiguousProductQueryMessage,
  ambiguousVariantQueryMessage,
  archivedProductMessage,
  archivedProductQueryMessage,
  noActiveVariantsMessage,
  ReferenceResolutionConflictError,
  unmatchedVariantQueryMessage,
  variantRequiredMessage,
  type VariantSelectionOption,
} from "./reference-resolution-conflict.js";

type StaffDb = Extract<ActionCtx, { principal: "staff" }>["db"];

type ProductLifecycleStatus = "active" | "archived";

const RESOLVE_LINE_CANDIDATE_MAX = 100;

export type LineReferenceInput = ResolveLineItemInput;

export type ResolvedLineReference = {
  readonly productId: string;
  readonly productName: string;
  readonly variantId: string | null;
  readonly variantName: string | null;
};

type ProductCandidate = {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly currency: string;
};

type VariantCandidate = {
  readonly id: string;
  readonly productId: string;
  readonly name: string;
  readonly status: string;
};

function orIlike(
  column: typeof products.name,
  queries: readonly string[],
  patternOf: (normalized: string) => string | undefined,
): SQL | undefined {
  const parts: SQL[] = [];
  for (const query of queries) {
    const pattern = patternOf(normalizeReferenceQuery(query));
    if (pattern !== undefined) {
      parts.push(ilike(column, pattern));
    }
  }
  if (parts.length === 0) {
    return undefined;
  }
  const first = parts[0];
  if (first === undefined) {
    return undefined;
  }
  if (parts.length === 1) {
    return first;
  }
  return or(...parts);
}

function mergeProductCandidates(
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

function compareProductNameThenId(
  left: ProductCandidate,
  right: ProductCandidate,
): number {
  const byName = left.name.localeCompare(right.name);
  if (byName !== 0) {
    return byName;
  }
  const byCurrency = left.currency.localeCompare(right.currency);
  if (byCurrency !== 0) {
    return byCurrency;
  }
  return left.id.localeCompare(right.id);
}

function productOptionLabel(
  row: ProductCandidate,
  siblings: readonly ProductCandidate[],
): string {
  const sameName = siblings.filter((candidate) => candidate.name === row.name);
  if (sameName.length === 1) {
    return row.name;
  }
  const sameNameCurrency = sameName.filter(
    (candidate) => candidate.currency === row.currency,
  );
  if (sameNameCurrency.length === 1) {
    return `${row.name} (${row.currency})`;
  }
  return `${row.name} (${row.currency}, ${row.id})`;
}

function pickerFromProducts(rows: readonly ProductCandidate[]): {
  readonly options: readonly VariantSelectionOption[];
  readonly optionsTruncated: boolean;
} {
  const sorted = [...rows].toSorted(compareProductNameThenId);
  return {
    options: sorted.slice(0, VARIANT_SELECTION_OPTIONS_MAX).map((row) => ({
      id: row.id,
      label: productOptionLabel(row, sorted),
    })),
    optionsTruncated: sorted.length > VARIANT_SELECTION_OPTIONS_MAX,
  };
}

function variantSelectionOf(line: LineReferenceInput): VariantSelection {
  if (line.variant !== undefined) {
    return { kind: "reference", ref: line.variant };
  }
  return line.variantSelection ?? { kind: "unspecified" };
}

function compareVariantNameThenId(
  left: VariantCandidate,
  right: VariantCandidate,
): number {
  const byName = left.name.localeCompare(right.name);
  if (byName !== 0) {
    return byName;
  }
  return left.id.localeCompare(right.id);
}

function pickerFromVariants(rows: readonly VariantCandidate[]): {
  readonly options: readonly VariantSelectionOption[];
  readonly optionsTruncated: boolean;
} {
  const sorted = [...rows].toSorted(compareVariantNameThenId);
  return {
    options: sorted.slice(0, VARIANT_SELECTION_OPTIONS_MAX).map((row) => ({
      id: row.id,
      label: row.name,
    })),
    optionsTruncated: sorted.length > VARIANT_SELECTION_OPTIONS_MAX,
  };
}

function throwProductSelectionConflict(args: {
  readonly lineIndex: number;
  readonly query: string;
  readonly optionsSource: readonly ProductCandidate[];
}): never {
  const picker = pickerFromProducts(args.optionsSource);
  throw new ReferenceResolutionConflictError({
    reason: "ambiguous",
    target: {
      kind: "order_line_product",
      lineIndex: args.lineIndex,
      query: args.query,
    },
    options: picker.options,
    optionsTruncated: picker.optionsTruncated,
    clientMessage: ambiguousProductQueryMessage(args.query),
  });
}

function throwArchivedProductConflict(args: {
  readonly lineIndex: number;
  readonly query: string;
  readonly uniqueProduct: ProductCandidate | undefined;
}): never {
  throw new ReferenceResolutionConflictError({
    reason: "archived",
    target:
      args.uniqueProduct === undefined
        ? {
            kind: "order_line_product",
            lineIndex: args.lineIndex,
            query: args.query,
          }
        : {
            kind: "order_line_product",
            lineIndex: args.lineIndex,
            query: args.query,
            productName: args.uniqueProduct.name,
          },
    options: [],
    optionsTruncated: false,
    clientMessage:
      args.uniqueProduct === undefined
        ? archivedProductQueryMessage(args.query)
        : archivedProductMessage(args.uniqueProduct.name),
  });
}

function throwVariantSelectionConflict(args: {
  readonly reason:
    "variant_required" | "ambiguous" | "unmatched_query" | "no_active_variants";
  readonly lineIndex: number;
  readonly product: ProductCandidate;
  readonly optionsSource: readonly VariantCandidate[];
  readonly clientMessage: string;
}): never {
  const picker = pickerFromVariants(args.optionsSource);
  throw new ReferenceResolutionConflictError({
    reason: args.reason,
    target: {
      kind: "order_line_variant",
      lineIndex: args.lineIndex,
      productId: args.product.id,
      productName: args.product.name,
    },
    options: args.reason === "no_active_variants" ? [] : picker.options,
    optionsTruncated:
      args.reason === "no_active_variants" ? false : picker.optionsTruncated,
    clientMessage: args.clientMessage,
  });
}

const productCandidateColumns = {
  id: products.id,
  name: products.name,
  status: products.status,
  currency: products.currency,
} as const;

async function loadProductsById(
  db: StaffDb,
  companyId: string,
  ids: readonly string[],
): Promise<ProductCandidate[]> {
  if (ids.length === 0) {
    return [];
  }
  return db
    .select(productCandidateColumns)
    .from(products)
    .where(
      and(
        eq(products.companyId, companyId),
        eq(products.status, "active"),
        inArray(products.id, ids),
      ),
    );
}

/**
 * Equality ILIKE (no `%` wrap) for every unique query string. No scan cap:
 * different query strings cannot crowd each other out, and duplicate exact
 * names are the natural CONFLICT set rather than a contains bag. Active and
 * archived run as independent statements so archived rows cannot consume
 * the active budget.
 */
async function loadProductsByExactQuery(
  db: StaffDb,
  companyId: string,
  queries: readonly string[],
  status: ProductLifecycleStatus,
): Promise<ProductCandidate[]> {
  const exact = orIlike(products.name, queries, sanitizeLikeLiteral);
  if (exact === undefined) {
    return [];
  }
  return db
    .select(productCandidateColumns)
    .from(products)
    .where(
      and(
        eq(products.companyId, companyId),
        eq(products.status, status),
        exact,
      ),
    );
}

async function loadProductsByContainsQuery(
  db: StaffDb,
  companyId: string,
  queries: readonly string[],
  status: ProductLifecycleStatus,
): Promise<ProductCandidate[]> {
  const selects = queries.flatMap((query) => {
    const pattern = likeContainsPattern(normalizeReferenceQuery(query));
    if (pattern === undefined) {
      return [];
    }
    return [
      db
        .select(productCandidateColumns)
        .from(products)
        .where(
          and(
            eq(products.companyId, companyId),
            eq(products.status, status),
            ilike(products.name, pattern),
          ),
        )
        .orderBy(asc(products.name), asc(products.id))
        .limit(RESOLVE_LINE_CANDIDATE_MAX),
    ];
  });
  const first = selects[0];
  if (first === undefined) {
    return [];
  }
  const second = selects[1];
  if (second === undefined) {
    return await first;
  }
  return await unionAll(first, second, ...selects.slice(2));
}

async function loadVariantsForProducts(
  db: StaffDb,
  companyId: string,
  productIds: readonly string[],
): Promise<VariantCandidate[]> {
  if (productIds.length === 0) {
    return [];
  }
  return db
    .select({
      id: productVariants.id,
      productId: productVariants.productId,
      name: productVariants.name,
      status: productVariants.status,
    })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.companyId, companyId),
        inArray(productVariants.productId, productIds),
      ),
    );
}

function uniqueArchivedSubject(
  picked: UniqueMatchResult<ProductCandidate>,
): ProductCandidate | undefined {
  if (picked.kind === "unique") {
    return picked.row;
  }
  if (picked.kind === "ambiguous" && picked.rows.length === 1) {
    const [row] = picked.rows;
    if (row !== undefined) {
      return row;
    }
  }
  return undefined;
}

function resolveProductRef(
  ref: EntityRef,
  lineIndex: number,
  byId: ReadonlyMap<string, ProductCandidate>,
  activeQueryCandidates: readonly ProductCandidate[],
  archivedQueryCandidates: readonly ProductCandidate[],
): ProductCandidate {
  if (ref.by === "id") {
    const row = byId.get(ref.id);
    if (row === undefined || row.status !== "active") {
      throw new NotFoundError();
    }
    return row;
  }
  const activeScoped = candidatesContainingQuery(
    ref.value,
    activeQueryCandidates,
    (row) => [row.name],
  );
  const activePicked = pickUniqueNormalizedMatch(
    ref.value,
    activeScoped,
    (row) => [row.name],
  );
  if (activePicked.kind === "unique") {
    return activePicked.row;
  }
  if (activePicked.kind === "ambiguous") {
    throwProductSelectionConflict({
      lineIndex,
      query: ref.value,
      optionsSource: activePicked.rows,
    });
  }
  const archivedScoped = candidatesContainingQuery(
    ref.value,
    archivedQueryCandidates,
    (row) => [row.name],
  );
  const archivedPicked = pickUniqueNormalizedMatch(
    ref.value,
    archivedScoped,
    (row) => [row.name],
  );
  if (archivedPicked.kind === "none") {
    throw new NotFoundError();
  }
  throwArchivedProductConflict({
    lineIndex,
    query: ref.value,
    uniqueProduct: uniqueArchivedSubject(archivedPicked),
  });
}

function resolveReferencedVariant(
  ref: EntityRef,
  lineIndex: number,
  product: ProductCandidate,
  owned: readonly VariantCandidate[],
  active: readonly VariantCandidate[],
): VariantCandidate {
  if (ref.by === "id") {
    const row = owned.find((variant) => variant.id === ref.id);
    if (row === undefined || row.status !== "active") {
      throw new NotFoundError();
    }
    return row;
  }
  // Simple product: no choosable variants. A query is not unmatched_query
  // (HITL picker); it is the same as a missing variant id.
  if (owned.length === 0) {
    throw new NotFoundError();
  }
  if (active.length === 0) {
    throwVariantSelectionConflict({
      reason: "no_active_variants",
      lineIndex,
      product,
      optionsSource: [],
      clientMessage: noActiveVariantsMessage(product.name),
    });
  }
  const scoped = candidatesContainingQuery(ref.value, active, (row) => [
    row.name,
  ]);
  const picked = pickUniqueNormalizedMatch(ref.value, scoped, (row) => [
    row.name,
  ]);
  if (picked.kind === "none") {
    throwVariantSelectionConflict({
      reason: "unmatched_query",
      lineIndex,
      product,
      optionsSource: active,
      clientMessage: unmatchedVariantQueryMessage(ref.value, product.name),
    });
  }
  if (picked.kind === "ambiguous") {
    throwVariantSelectionConflict({
      reason: "ambiguous",
      lineIndex,
      product,
      optionsSource: picked.rows,
      clientMessage: ambiguousVariantQueryMessage(ref.value, product.name),
    });
  }
  return picked.row;
}

export type ExpectedLineResolutionFailure =
  | {
      readonly kind: "terminal";
      readonly error: NotFoundError | ReferenceResolutionConflictError;
    }
  | {
      readonly kind: "picker";
      readonly error: ReferenceResolutionConflictError;
    };

/**
 * Mixed-cart classifier (SHO-441). Only expected reference-resolution
 * failures are collected. Infrastructure, invariant, and authorization
 * errors return null so the caller rethrows them unchanged.
 */
export function classifyExpectedLineResolutionFailure(
  error: unknown,
): ExpectedLineResolutionFailure | null {
  if (error instanceof NotFoundError) {
    return { kind: "terminal", error };
  }
  if (!(error instanceof ReferenceResolutionConflictError)) {
    return null;
  }
  switch (error.reason) {
    case "archived":
    case "no_active_variants":
      return { kind: "terminal", error };
    case "variant_required":
    case "ambiguous":
    case "unmatched_query":
      return { kind: "picker", error };
  }
}

function resolveLineVariant(
  line: LineReferenceInput,
  lineIndex: number,
  product: ProductCandidate,
  variants: readonly VariantCandidate[],
): ResolvedLineReference {
  const owned = variants.filter((row) => row.productId === product.id);
  const active = owned.filter((row) => row.status === "active");
  const selection = variantSelectionOf(line);

  if (selection.kind === "reference") {
    const variant = resolveReferencedVariant(
      selection.ref,
      lineIndex,
      product,
      owned,
      active,
    );
    return {
      productId: product.id,
      productName: product.name,
      variantId: variant.id,
      variantName: variant.name,
    };
  }

  if (owned.length === 0) {
    return {
      productId: product.id,
      productName: product.name,
      variantId: null,
      variantName: null,
    };
  }
  if (active.length === 0) {
    throwVariantSelectionConflict({
      reason: "no_active_variants",
      lineIndex,
      product,
      optionsSource: [],
      clientMessage: noActiveVariantsMessage(product.name),
    });
  }
  throwVariantSelectionConflict({
    reason: "variant_required",
    lineIndex,
    product,
    optionsSource: active,
    clientMessage: variantRequiredMessage(product.name),
  });
}

/**
 * Bounded reads: at most one product-id SELECT (active), one exact-name
 * SELECT per status (uncapped active and archived), one contains statement
 * per status that caps candidates per input query string (not one
 * shared LIMIT across the OR or across statuses), and one variant SELECT
 * for sellable (id + active query) product ids. Archived candidates do not
 * load variants. Never one SELECT per input line and never a nested
 * action call. Product-level conflict on a line is thrown before that
 * line's variant conflict. Mixed carts classify every line, then throw the
 * earliest terminal (`archived`, `no_active_variants`, not-found) by input
 * `lineIndex`; pickers run only when no terminal exists.
 */
export async function resolveCatalogLineReferences(args: {
  readonly db: StaffDb;
  readonly companyId: string;
  readonly lines: readonly LineReferenceInput[];
}): Promise<readonly ResolvedLineReference[]> {
  const productIds = uniqueIds(
    args.lines.flatMap((line) =>
      line.product.by === "id" ? [line.product.id] : [],
    ),
  );
  const productQueries = uniqueIds(
    args.lines.flatMap((line) =>
      line.product.by === "query"
        ? [normalizeReferenceQuery(line.product.value)]
        : [],
    ),
  );

  const [idRows, exactActive, containsActive, exactArchived, containsArchived] =
    await Promise.all([
      loadProductsById(args.db, args.companyId, productIds),
      loadProductsByExactQuery(
        args.db,
        args.companyId,
        productQueries,
        "active",
      ),
      loadProductsByContainsQuery(
        args.db,
        args.companyId,
        productQueries,
        "active",
      ),
      loadProductsByExactQuery(
        args.db,
        args.companyId,
        productQueries,
        "archived",
      ),
      loadProductsByContainsQuery(
        args.db,
        args.companyId,
        productQueries,
        "archived",
      ),
    ]);
  const byId = new Map(idRows.map((row) => [row.id, row]));
  const activeQueryRows = mergeProductCandidates(exactActive, containsActive);
  const archivedQueryRows = mergeProductCandidates(
    exactArchived,
    containsArchived,
  );
  const sellableProducts = mergeProductCandidates(idRows, activeQueryRows);
  const variants = await loadVariantsForProducts(
    args.db,
    args.companyId,
    uniqueIds(sellableProducts.map((row) => row.id)),
  );

  const resolved: Array<ResolvedLineReference | undefined> = args.lines.map(
    () => undefined,
  );
  let firstTerminal:
    NotFoundError | ReferenceResolutionConflictError | undefined;
  let firstPicker: ReferenceResolutionConflictError | undefined;

  for (const [index, line] of args.lines.entries()) {
    try {
      const product = resolveProductRef(
        line.product,
        index,
        byId,
        activeQueryRows,
        archivedQueryRows,
      );
      resolved[index] = resolveLineVariant(line, index, product, variants);
    } catch (error) {
      const classified = classifyExpectedLineResolutionFailure(error);
      if (classified === null) {
        throw error;
      }
      if (classified.kind === "terminal") {
        firstTerminal ??= classified.error;
        continue;
      }
      firstPicker ??= classified.error;
    }
  }

  if (firstTerminal !== undefined) {
    throw firstTerminal;
  }
  if (firstPicker !== undefined) {
    throw firstPicker;
  }

  return resolved.map((line, index) => {
    if (line === undefined) {
      throw new CoreInvariantError(
        `catalog.resolveLineReferences missed input line ${String(index)}`,
      );
    }
    return line;
  });
}
