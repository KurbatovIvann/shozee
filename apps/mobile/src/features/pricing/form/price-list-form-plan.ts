/**
 * Price-list form write planner (SHO-190). UI parse happens first via
 * `parsePriceListFormUiDraft`; this file turns a valid draft into create,
 * name, default/active, then set/remove entry diffs. Create never sends
 * prices — the save loop navigates to edit.
 */
import type { WireErrorCode } from "@showzy/contract";

import type { ContractClient } from "../../../api/client";
import type { QueryFailureKind } from "../../../api/errors";
import { priceListEditorHref } from "../shared/price-list-hrefs";
import {
  PRICE_LIST_CURRENCY,
  SET_PRICE_LIST_ENTRIES_MAX_ITEMS,
} from "../shared/price-list-caps";
import {
  isPriceListFormValid,
  parsePriceListFormUiDraft,
  snapshotFromDraft,
  validatePriceListForm,
  type PriceListFormDraft,
  type PriceListFormFieldErrors,
  type PriceListFormMode,
  type PriceListFormSnapshot,
} from "./price-list-form-draft";

type PricingClient = ContractClient["client"]["pricing"];
export type CreatePriceListPayload = Parameters<
  PricingClient["createPriceList"]
>[0];
export type UpdatePriceListPayload = Parameters<
  PricingClient["updatePriceList"]
>[0];
export type SetPriceListEntriesPayload = Parameters<
  PricingClient["setPriceListEntries"]
>[0];
export type RemovePriceListEntriesPayload = Parameters<
  PricingClient["removePriceListEntries"]
>[0];

export type PriceListFormWrite =
  | { readonly kind: "createPriceList"; readonly input: CreatePriceListPayload }
  | { readonly kind: "updatePriceList"; readonly input: UpdatePriceListPayload }
  | { readonly kind: "setDefault"; readonly priceListId: string }
  | { readonly kind: "clearDefault" }
  | { readonly kind: "activate"; readonly id: string }
  | { readonly kind: "deactivate"; readonly id: string }
  | {
      readonly kind: "setEntries";
      readonly input: SetPriceListEntriesPayload;
    }
  | {
      readonly kind: "removeEntries";
      readonly input: RemovePriceListEntriesPayload;
    };

export type PriceListFormSavePlan =
  | { readonly kind: "invalid"; readonly errors: PriceListFormFieldErrors }
  | { readonly kind: "retry" }
  | { readonly kind: "noop" }
  | { readonly kind: "write"; readonly write: PriceListFormWrite };

export type PriceListFormMutationResult = {
  readonly id: string;
};

export type PriceListFormSaveNavigation =
  | { readonly kind: "replaceEditor"; readonly href: string }
  | { readonly kind: "leave" };

const RETRYABLE_FAILURE: ReadonlySet<QueryFailureKind> = new Set([
  "network",
  "offline",
  "timeout",
  "rate_limited",
  "internal",
]);

const RETRYABLE_WIRE: ReadonlySet<WireErrorCode> = new Set([
  "RETRY_IN_PROGRESS",
  "IDEMPOTENCY_CONFLICT",
]);

function chunk<T>(items: readonly T[], size: number): T[][] {
  if (items.length === 0) {
    return [];
  }
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push([...items.slice(index, index + size)]);
  }
  return batches;
}

export function createPriceListPayload(
  draft: PriceListFormDraft,
): CreatePriceListPayload | null {
  const snapshot = snapshotFromDraft(draft);
  if (snapshot === null) {
    return null;
  }
  return {
    name: snapshot.name,
    isDefault: snapshot.isDefault,
    isActive: snapshot.isActive,
  };
}

export function priceListFormSaveNavigation(
  mode: PriceListFormMode,
  priceListId: string,
): PriceListFormSaveNavigation {
  if (mode === "create") {
    return {
      kind: "replaceEditor",
      href: priceListEditorHref(priceListId),
    };
  }
  return { kind: "leave" };
}

function entryKey(productId: string, variantId: string | null): string {
  return variantId === null ? productId : `${productId}:${variantId}`;
}

function baselineEntryMap(
  baseline: PriceListFormSnapshot,
): ReadonlyMap<string, string | null> {
  return new Map(
    baseline.entries.map((entry) => [entry.key, entry.priceMinor]),
  );
}

export function remainingFormWrites(
  priceListId: string,
  snapshot: PriceListFormSnapshot,
  baseline: PriceListFormSnapshot,
): readonly PriceListFormWrite[] {
  const writes: PriceListFormWrite[] = [];
  if (snapshot.name !== baseline.name) {
    writes.push({
      kind: "updatePriceList",
      input: { id: priceListId, name: snapshot.name },
    });
  }
  if (snapshot.isDefault && !baseline.isDefault) {
    writes.push({ kind: "setDefault", priceListId });
  } else if (!snapshot.isDefault && baseline.isDefault) {
    writes.push({ kind: "clearDefault" });
  }
  const activeAfterDefault = snapshot.isDefault ? true : snapshot.isActive;
  const baselineActive = baseline.isDefault ? true : baseline.isActive;
  if (!snapshot.isDefault && activeAfterDefault !== baselineActive) {
    if (activeAfterDefault) {
      writes.push({ kind: "activate", id: priceListId });
    } else {
      writes.push({ kind: "deactivate", id: priceListId });
    }
  }

  const previous = baselineEntryMap(baseline);
  const snapshotKeys = new Set(snapshot.entries.map((entry) => entry.key));
  const toSet: SetPriceListEntriesPayload["entries"] = [];
  const toRemove: RemovePriceListEntriesPayload["entries"] = [];

  for (const entry of snapshot.entries) {
    const was = previous.get(entry.key) ?? null;
    if (entry.priceMinor === null) {
      if (was !== null) {
        toRemove.push(
          entry.variantId === null
            ? { productId: entry.productId }
            : { productId: entry.productId, variantId: entry.variantId },
        );
      }
      continue;
    }
    if (entry.priceMinor !== was) {
      toSet.push(
        entry.variantId === null
          ? {
              productId: entry.productId,
              priceMinor: entry.priceMinor,
              currency: PRICE_LIST_CURRENCY,
            }
          : {
              productId: entry.productId,
              variantId: entry.variantId,
              priceMinor: entry.priceMinor,
              currency: PRICE_LIST_CURRENCY,
            },
      );
    }
  }
  for (const entry of baseline.entries) {
    if (snapshotKeys.has(entry.key) || entry.priceMinor === null) {
      continue;
    }
    toRemove.push(
      entry.variantId === null
        ? { productId: entry.productId }
        : { productId: entry.productId, variantId: entry.variantId },
    );
  }

  for (const entries of chunk(toSet, SET_PRICE_LIST_ENTRIES_MAX_ITEMS)) {
    if (entries.length === 0) {
      continue;
    }
    writes.push({
      kind: "setEntries",
      input: { priceListId, entries },
    });
  }
  for (const entries of chunk(toRemove, SET_PRICE_LIST_ENTRIES_MAX_ITEMS)) {
    if (entries.length === 0) {
      continue;
    }
    writes.push({
      kind: "removeEntries",
      input: { priceListId, entries },
    });
  }
  return writes;
}

export function writesEqual(
  left: PriceListFormWrite,
  right: PriceListFormWrite,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

export function isPriceListFormRetryable(
  kind: QueryFailureKind | null,
  wireCode: WireErrorCode | null = null,
): boolean {
  if (wireCode !== null && RETRYABLE_WIRE.has(wireCode)) {
    return true;
  }
  return kind !== null && RETRYABLE_FAILURE.has(kind);
}

export function planPriceListFormSave(args: {
  readonly mode: PriceListFormMode;
  readonly priceListId: string | null;
  readonly draft: PriceListFormDraft;
  readonly baseline: PriceListFormSnapshot | null;
  readonly lastWrite: PriceListFormWrite | null;
  readonly lastFailureKind: QueryFailureKind | null;
  readonly lastWireCode?: WireErrorCode | null;
}): PriceListFormSavePlan {
  const errors = validatePriceListForm(args.draft);
  if (!isPriceListFormValid(errors)) {
    return { kind: "invalid", errors };
  }
  const retryable = isPriceListFormRetryable(
    args.lastFailureKind,
    args.lastWireCode ?? null,
  );
  if (args.mode === "create") {
    const input = createPriceListPayload(args.draft);
    if (input === null) {
      return { kind: "invalid", errors };
    }
    const write: PriceListFormWrite = { kind: "createPriceList", input };
    if (
      args.lastWrite !== null &&
      writesEqual(args.lastWrite, write) &&
      retryable
    ) {
      return { kind: "retry" };
    }
    return { kind: "write", write };
  }
  if (args.priceListId === null || args.baseline === null) {
    return { kind: "invalid", errors };
  }
  const snapshot = snapshotFromDraft(args.draft);
  if (snapshot === null) {
    return { kind: "invalid", errors };
  }
  const writes = remainingFormWrites(args.priceListId, snapshot, args.baseline);
  if (writes.length === 0) {
    return { kind: "noop" };
  }
  const write = writes[0];
  if (write === undefined) {
    return { kind: "noop" };
  }
  if (
    args.lastWrite !== null &&
    writesEqual(args.lastWrite, write) &&
    retryable
  ) {
    return { kind: "retry" };
  }
  return { kind: "write", write };
}

export function parseThenPlanPriceListFormSave(args: {
  readonly mode: PriceListFormMode;
  readonly priceListId: string | null;
  readonly draft: PriceListFormDraft;
  readonly baseline: PriceListFormSnapshot | null;
  readonly lastWrite: PriceListFormWrite | null;
  readonly lastFailureKind: QueryFailureKind | null;
  readonly lastWireCode?: WireErrorCode | null;
}): PriceListFormSavePlan {
  const parsed = parsePriceListFormUiDraft(args.draft);
  if (!parsed.ok) {
    return { kind: "invalid", errors: parsed.errors };
  }
  return planPriceListFormSave({ ...args, draft: parsed.draft });
}

function applySetEntries(
  baseline: PriceListFormSnapshot,
  write: Extract<PriceListFormWrite, { kind: "setEntries" }>,
): PriceListFormSnapshot {
  const next = new Map(baselineEntryMap(baseline));
  const meta = new Map(
    baseline.entries.map((entry) => [entry.key, entry] as const),
  );
  for (const entry of write.input.entries) {
    const variantId = entry.variantId ?? null;
    const key = entryKey(entry.productId, variantId);
    next.set(key, entry.priceMinor);
    meta.set(key, {
      key,
      productId: entry.productId,
      variantId,
      priceMinor: entry.priceMinor,
    });
  }
  return {
    ...baseline,
    entries: [...meta.values()].map((entry) => ({
      ...entry,
      priceMinor: next.get(entry.key) ?? entry.priceMinor,
    })),
  };
}

function applyRemoveEntries(
  baseline: PriceListFormSnapshot,
  write: Extract<PriceListFormWrite, { kind: "removeEntries" }>,
): PriceListFormSnapshot {
  const removed = new Set(
    write.input.entries.map((entry) =>
      entryKey(entry.productId, entry.variantId ?? null),
    ),
  );
  return {
    ...baseline,
    entries: baseline.entries.map((entry) =>
      removed.has(entry.key) ? { ...entry, priceMinor: null } : entry,
    ),
  };
}

export function applyWriteSuccess(args: {
  readonly draft: PriceListFormDraft;
  readonly baseline: PriceListFormSnapshot | null;
  readonly write: PriceListFormWrite;
}): {
  readonly draft: PriceListFormDraft;
  readonly baseline: PriceListFormSnapshot | null;
  readonly done: boolean;
  readonly priceListId: string | null;
} {
  if (args.write.kind === "createPriceList") {
    return {
      draft: args.draft,
      baseline: snapshotFromDraft(args.draft),
      done: true,
      priceListId: null,
    };
  }
  const loaded = snapshotFromDraft(args.draft);
  let baseline: PriceListFormSnapshot = args.baseline ??
    loaded ?? {
      name: "",
      isDefault: false,
      isActive: true,
      entries: [],
    };
  let priceListId: string | null = null;

  switch (args.write.kind) {
    case "updatePriceList":
      priceListId = args.write.input.id;
      baseline = {
        ...baseline,
        name: args.write.input.name ?? baseline.name,
      };
      break;
    case "setDefault":
      priceListId = args.write.priceListId;
      baseline = { ...baseline, isDefault: true, isActive: true };
      break;
    case "clearDefault":
      baseline = { ...baseline, isDefault: false };
      break;
    case "activate":
      priceListId = args.write.id;
      baseline = { ...baseline, isActive: true };
      break;
    case "deactivate":
      priceListId = args.write.id;
      baseline = { ...baseline, isActive: false };
      break;
    case "setEntries":
      priceListId = args.write.input.priceListId;
      baseline = applySetEntries(baseline, args.write);
      break;
    case "removeEntries":
      priceListId = args.write.input.priceListId;
      baseline = applyRemoveEntries(baseline, args.write);
      break;
  }

  const snapshot = snapshotFromDraft(args.draft);
  const remaining =
    priceListId === null || snapshot === null
      ? []
      : remainingFormWrites(priceListId, snapshot, baseline);
  return {
    draft: args.draft,
    baseline,
    done: remaining.length === 0,
    priceListId,
  };
}
