import { createHash } from "node:crypto";

import {
  SHO_CONTEXT_LIMITS,
  SHO_MAX_CONTEXT_BYTES,
  type ShoContext,
  type ShoContextListName,
  type ShoContextProduct,
  type ShoContextRecord,
} from "@showzy/sho-protocol";

export interface ShoNameEntry {
  readonly id: string;
  readonly name: string;
}

export interface ShoNameList {
  readonly items: readonly ShoNameEntry[];
  readonly truncated: boolean;
}

export interface ShoVariantEntry extends ShoNameEntry {
  readonly productId: string;
}

export interface ShoCatalogNameIndex {
  readonly products: ShoNameList;
  readonly variants: {
    readonly items: readonly ShoVariantEntry[];
    readonly truncated: boolean;
  };
}

export interface ShoCustomersNameIndex {
  readonly customers: ShoNameList;
  readonly groups: ShoNameList;
  readonly counterparties: ShoNameList;
}

export interface ShoPricingNameIndex {
  readonly priceLists: ShoNameList;
}

export const SHO_CONTEXT_SCOPES = ["catalog", "customers", "pricing"] as const;

export type ShoContextScope = (typeof SHO_CONTEXT_SCOPES)[number];

export interface ShoNameIndexSnapshot {
  readonly catalog: ShoCatalogNameIndex | null;
  readonly customers: ShoCustomersNameIndex | null;
  readonly pricing: ShoPricingNameIndex | null;
}

export interface ShoContextBuild {
  readonly scopeHash: string;
  readonly fingerprint: string;
  readonly context: ShoContext;
}

export const SHO_CONTEXT_CAPABILITIES = {
  stock: false,
  fiscal: false,
} as const;

const REVISION_WIDTH = 64;
const SCOPE_HASH_WIDTH = 32;
const MEASURED_REVISION = "0".repeat(REVISION_WIDTH);

interface ShoContextCaps {
  readonly products: number;
  readonly variantsPerProduct: number;
  readonly variants: number;
  readonly customers: number;
  readonly groups: number;
  readonly counterparties: number;
  readonly priceLists: number;
}

const FULL_CAPS: ShoContextCaps = {
  products: SHO_CONTEXT_LIMITS.products,
  variantsPerProduct: SHO_CONTEXT_LIMITS.variantsPerProduct,
  variants: SHO_CONTEXT_LIMITS.variants,
  customers: SHO_CONTEXT_LIMITS.customers,
  groups: SHO_CONTEXT_LIMITS.groups,
  counterparties: SHO_CONTEXT_LIMITS.counterparties,
  priceLists: SHO_CONTEXT_LIMITS.priceLists,
};

interface Clipped<Item> {
  readonly items: Item[];
  readonly partial: boolean;
}

function digest(value: string, width: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, width);
}

function asRecord(
  entry: ShoNameEntry,
  taken: Set<string>,
): ShoContextRecord | null {
  const name = entry.name.trim();
  if (
    name.length === 0 ||
    entry.id.length === 0 ||
    entry.id.length > SHO_CONTEXT_LIMITS.id ||
    taken.has(entry.id)
  ) {
    return null;
  }
  taken.add(entry.id);
  return { id: entry.id, name: name.slice(0, SHO_CONTEXT_LIMITS.name) };
}

function clipList(list: ShoNameList, most: number): Clipped<ShoContextRecord> {
  const taken = new Set<string>();
  const items: ShoContextRecord[] = [];
  let partial = list.truncated;
  for (const entry of list.items) {
    if (items.length >= most) {
      partial = true;
      break;
    }
    const kept = asRecord(entry, taken);
    if (kept === null) {
      partial = true;
      continue;
    }
    items.push(kept);
  }
  return { items, partial };
}

function clipProducts(
  catalog: ShoCatalogNameIndex,
  caps: ShoContextCaps,
): Clipped<ShoContextProduct> {
  const listed = clipList(catalog.products, caps.products);
  const perProduct = new Map<
    string,
    { readonly taken: Set<string>; readonly items: ShoContextRecord[] }
  >(
    listed.items.map((product) => [
      product.id,
      { taken: new Set<string>(), items: [] },
    ]),
  );
  let partial = listed.partial || catalog.variants.truncated;
  let total = 0;
  for (const variant of catalog.variants.items) {
    const bucket = perProduct.get(variant.productId);
    if (
      bucket === undefined ||
      bucket.items.length >= caps.variantsPerProduct ||
      total >= caps.variants
    ) {
      partial = true;
      continue;
    }
    const kept = asRecord(variant, bucket.taken);
    if (kept === null) {
      partial = true;
      continue;
    }
    bucket.items.push(kept);
    total += 1;
  }
  const items = listed.items.map((product) => {
    const bucket = perProduct.get(product.id);
    return bucket === undefined || bucket.items.length === 0
      ? product
      : { ...product, variants: bucket.items };
  });
  return { items, partial };
}

function compose(
  snapshot: ShoNameIndexSnapshot,
  caps: ShoContextCaps,
): ShoContext {
  const products =
    snapshot.catalog === null ? null : clipProducts(snapshot.catalog, caps);
  const customers =
    snapshot.customers === null
      ? null
      : clipList(snapshot.customers.customers, caps.customers);
  const groups =
    snapshot.customers === null
      ? null
      : clipList(snapshot.customers.groups, caps.groups);
  const counterparties =
    snapshot.customers === null
      ? null
      : clipList(snapshot.customers.counterparties, caps.counterparties);
  const priceLists =
    snapshot.pricing === null
      ? null
      : clipList(snapshot.pricing.priceLists, caps.priceLists);
  const partial: ShoContextListName[] = (
    [
      ["products", products],
      ["customers", customers],
      ["groups", groups],
      ["counterparties", counterparties],
      ["priceLists", priceLists],
    ] as const
  )
    .filter(([, clipped]) => clipped !== null && clipped.partial)
    .map(([name]) => name);
  return {
    version: 2,
    capabilities: SHO_CONTEXT_CAPABILITIES,
    ...(products === null ? {} : { products: products.items }),
    ...(customers === null ? {} : { customers: customers.items }),
    ...(groups === null ? {} : { groups: groups.items }),
    ...(counterparties === null
      ? {}
      : { counterparties: counterparties.items }),
    ...(priceLists === null ? {} : { priceLists: priceLists.items }),
    ...(partial.length === 0 ? {} : { partial }),
  };
}

function uploadBytes(context: ShoContext): number {
  return Buffer.byteLength(
    JSON.stringify({
      fingerprint: MEASURED_REVISION,
      context: { ...context, revision: MEASURED_REVISION },
    }),
    "utf8",
  );
}

function halved(caps: ShoContextCaps): ShoContextCaps {
  return {
    products: Math.floor(caps.products / 2),
    variantsPerProduct: Math.floor(caps.variantsPerProduct / 2),
    variants: Math.floor(caps.variants / 2),
    customers: Math.floor(caps.customers / 2),
    groups: Math.floor(caps.groups / 2),
    counterparties: Math.floor(caps.counterparties / 2),
    priceLists: Math.floor(caps.priceLists / 2),
  };
}

function shedable(caps: ShoContextCaps): boolean {
  return Object.values(caps).some((cap) => cap > 0);
}

export function shoScopeHash(snapshot: ShoNameIndexSnapshot): string {
  const visible = SHO_CONTEXT_SCOPES.filter(
    (scope) => snapshot[scope] !== null,
  );
  return digest(visible.join(","), SCOPE_HASH_WIDTH);
}

export function buildShoContext(
  snapshot: ShoNameIndexSnapshot,
): ShoContextBuild {
  let caps = FULL_CAPS;
  let context = compose(snapshot, caps);
  while (uploadBytes(context) > SHO_MAX_CONTEXT_BYTES && shedable(caps)) {
    caps = halved(caps);
    context = compose(snapshot, caps);
  }
  const fingerprint = digest(JSON.stringify(context), REVISION_WIDTH);
  return {
    scopeHash: shoScopeHash(snapshot),
    fingerprint,
    context: { ...context, revision: fingerprint },
  };
}
