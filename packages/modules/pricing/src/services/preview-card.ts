import { getProductPricingFacts } from "@showzy/catalog";
import type { ActionPreviewEnv } from "@showzy/core";
import type { ActionPreview, ActionPreviewLine } from "@showzy/core/errors";
import { NotFoundError } from "@showzy/core/errors";
import { priceListEntries, priceLists } from "@showzy/db/schema/pricing";
import { moneyToCanonical } from "@showzy/module-kit/canonical";
import { formatMoneyMinor } from "@showzy/module-kit/money-format";
import { changeLines } from "@showzy/module-kit/preview-changes";
import { previewCompanyScope } from "@showzy/module-kit/preview-scope";
import { and, eq, inArray } from "drizzle-orm";
import type { z } from "zod";

import type { createPriceListInputSchema } from "../actions/create-price-list.contract.js";
import type { removePriceListEntriesInputSchema } from "../actions/remove-price-list-entries.contract.js";
import type { setPriceListEntriesInputSchema } from "../actions/set-price-list-entries.contract.js";
import type { updatePriceListInputSchema } from "../actions/update-price-list.contract.js";
import {
  comparePriceListEntryKeys,
  entryKey,
  type PriceListEntryKeyParts,
} from "./entry-keys.js";
import { rejectDefaultDeactivate } from "./set-price-list-active.js";

type PreviewEnv = ActionPreviewEnv;
type Contract = { readonly name: string };
type CreateFields = z.output<typeof createPriceListInputSchema>;
type SetEntriesFields = z.output<typeof setPriceListEntriesInputSchema>;
type RemoveEntriesFields = z.output<typeof removePriceListEntriesInputSchema>;
type UpdateFields = z.output<typeof updatePriceListInputSchema>;
type StoredEntry = { readonly priceMinor: bigint; readonly currency: string };

export const PRICE_LIST_NAME_LABEL = "Назва";
export const PRICE_LIST_DEFAULT_LABEL = "Основний";
export const PRICE_LIST_ACTIVE_LABEL = "Активний";
export const PRICE_LIST_ENTRY_COUNT_LABEL = "Цін у списку";
export const PRICE_LIST_NONE = "не задано";
export const PRICE_LIST_YES = "так";
export const PRICE_LIST_NO = "ні";
export const PRICE_LIST_ENTRIES_EMPTY = "нічого не знайдено";
export const PRICE_LIST_ENTRIES_LABEL = "Ціни";

export const DELETE_PRICE_LIST_NOTE =
  "Усі ціни в цьому прайс-листі буде видалено. Клієнти й групи, яким його призначено, залишаться і перейдуть на наступний рівень цін.";

function flag(value: boolean): string {
  return value ? PRICE_LIST_YES : PRICE_LIST_NO;
}

function changeLine(
  label: string,
  stored: string | null,
  next: string,
): ActionPreviewLine {
  if (stored === null || stored === next) {
    return { label, value: next };
  }
  return { label, value: `${stored} → ${next}` };
}

async function loadPriceList(env: PreviewEnv, companyId: string, id: string) {
  const row = (
    await env.tx
      .select({
        name: priceLists.name,
        isActive: priceLists.isActive,
        isDefault: priceLists.isDefault,
      })
      .from(priceLists)
      .where(and(eq(priceLists.companyId, companyId), eq(priceLists.id, id)))
      .limit(1)
  )[0];
  if (row === undefined) {
    throw new NotFoundError();
  }
  return row;
}

async function currentDefaultName(
  env: PreviewEnv,
  companyId: string,
): Promise<string | null> {
  const row = (
    await env.tx
      .select({ name: priceLists.name })
      .from(priceLists)
      .where(
        and(
          eq(priceLists.companyId, companyId),
          eq(priceLists.isDefault, true),
        ),
      )
      .limit(1)
  )[0];
  return row?.name ?? null;
}

async function countEntries(
  env: PreviewEnv,
  companyId: string,
  priceListId: string,
): Promise<number> {
  return env.tx.$count(
    priceListEntries,
    and(
      eq(priceListEntries.companyId, companyId),
      eq(priceListEntries.priceListId, priceListId),
    ),
  );
}

async function loadStoredEntries(
  env: PreviewEnv,
  companyId: string,
  priceListId: string,
  productIds: readonly string[],
): Promise<Map<string, StoredEntry>> {
  const stored = new Map<string, StoredEntry>();
  if (productIds.length === 0) {
    return stored;
  }
  const rows = await env.tx
    .select({
      productId: priceListEntries.productId,
      variantId: priceListEntries.variantId,
      priceMinor: priceListEntries.priceMinor,
      currency: priceListEntries.currency,
    })
    .from(priceListEntries)
    .where(
      and(
        eq(priceListEntries.companyId, companyId),
        eq(priceListEntries.priceListId, priceListId),
        inArray(priceListEntries.productId, [...productIds]),
      ),
    );
  for (const row of rows) {
    stored.set(entryKey(row.productId, row.variantId), {
      priceMinor: row.priceMinor,
      currency: row.currency,
    });
  }
  return stored;
}

async function loadCatalogNames(
  env: PreviewEnv,
  items: readonly PriceListEntryKeyParts[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (items.length === 0) {
    return names;
  }
  const facts = await env.call(getProductPricingFacts, {
    items: items.map((item) => {
      const variantId = item.variantId ?? null;
      return variantId === null
        ? { productId: item.productId }
        : { productId: item.productId, variantId };
    }),
  });
  for (const product of facts.products) {
    names.set(product.productId, product.name);
    for (const variant of product.variants) {
      names.set(variant.variantId, variant.name);
    }
  }
  return names;
}

function nameOf(names: Map<string, string>, id: string): string {
  const name = names.get(id);
  if (name === undefined) {
    throw new NotFoundError();
  }
  return name;
}

function uniqueEntries<T extends PriceListEntryKeyParts>(
  entries: readonly T[],
): T[] {
  const byKey = new Map(
    entries.map((entry) => [entryKey(entry.productId, entry.variantId), entry]),
  );
  return [...byKey.values()].toSorted(comparePriceListEntryKeys);
}

function entryLabel(
  names: Map<string, string>,
  entry: PriceListEntryKeyParts,
): string {
  const product = nameOf(names, entry.productId);
  const variantId = entry.variantId ?? null;
  return variantId === null
    ? product
    : `${product} / ${nameOf(names, variantId)}`;
}

function storedPriceText(row: StoredEntry): string {
  return formatMoneyMinor(moneyToCanonical(row.priceMinor), row.currency);
}

export function createPriceListPreview(
  contract: Contract,
): (input: CreateFields, env: PreviewEnv) => Promise<ActionPreview> {
  return async (input, env) => {
    const companyId = previewCompanyScope(env.companyId, contract);
    const previousDefault = input.isDefault
      ? await currentDefaultName(env, companyId)
      : null;
    return {
      title: `Новий прайс-лист: ${input.name}`,
      lines: [
        { label: PRICE_LIST_NAME_LABEL, value: input.name },
        input.isDefault
          ? changeLine(PRICE_LIST_DEFAULT_LABEL, previousDefault, input.name)
          : { label: PRICE_LIST_DEFAULT_LABEL, value: PRICE_LIST_NO },
        {
          label: PRICE_LIST_ACTIVE_LABEL,
          value: flag(input.isDefault || input.isActive),
        },
      ],
    };
  };
}

export function updatePriceListPreview(
  contract: Contract,
): (input: UpdateFields, env: PreviewEnv) => Promise<ActionPreview> {
  return async (input, env) => {
    const companyId = previewCompanyScope(env.companyId, contract);
    const stored = await loadPriceList(env, companyId, input.id);
    const name = input.name;
    return {
      title: `Змінити прайс-лист: ${stored.name}`,
      lines: changeLines(
        name === undefined
          ? []
          : [changeLine(PRICE_LIST_NAME_LABEL, stored.name, name)],
      ),
    };
  };
}

export function priceListActivePreview(
  contract: Contract,
  subject: string,
  isActive: boolean,
): (input: { readonly id: string }, env: PreviewEnv) => Promise<ActionPreview> {
  return async (input, env) => {
    const companyId = previewCompanyScope(env.companyId, contract);
    const stored = await loadPriceList(env, companyId, input.id);
    if (!isActive) {
      rejectDefaultDeactivate(stored.isDefault);
    }
    return {
      title: `${subject}: ${stored.name}`,
      lines: [
        changeLine(
          PRICE_LIST_ACTIVE_LABEL,
          flag(stored.isActive),
          flag(isActive),
        ),
      ],
    };
  };
}

export function setDefaultPriceListPreview(
  contract: Contract,
): (
  input: { readonly priceListId: string | null },
  env: PreviewEnv,
) => Promise<ActionPreview> {
  return async (input, env) => {
    const companyId = previewCompanyScope(env.companyId, contract);
    const previous = await currentDefaultName(env, companyId);
    if (input.priceListId === null) {
      return {
        title: "Прибрати основний прайс-лист",
        lines: [
          changeLine(PRICE_LIST_DEFAULT_LABEL, previous, PRICE_LIST_NONE),
        ],
      };
    }
    const target = await loadPriceList(env, companyId, input.priceListId);
    const lines = [changeLine(PRICE_LIST_DEFAULT_LABEL, previous, target.name)];
    if (!target.isActive) {
      lines.push(
        changeLine(PRICE_LIST_ACTIVE_LABEL, flag(target.isActive), flag(true)),
      );
    }
    return {
      title: `Основний прайс-лист: ${target.name}`,
      lines,
    };
  };
}

export function deletePriceListPreview(
  contract: Contract,
): (input: { readonly id: string }, env: PreviewEnv) => Promise<ActionPreview> {
  return async (input, env) => {
    const companyId = previewCompanyScope(env.companyId, contract);
    const stored = await loadPriceList(env, companyId, input.id);
    const entries = await countEntries(env, companyId, input.id);
    return {
      title: `Видалити прайс-лист: ${stored.name}`,
      lines: [
        { label: PRICE_LIST_DEFAULT_LABEL, value: flag(stored.isDefault) },
        { label: PRICE_LIST_ACTIVE_LABEL, value: flag(stored.isActive) },
        { label: PRICE_LIST_ENTRY_COUNT_LABEL, value: String(entries) },
      ],
      notes: [DELETE_PRICE_LIST_NOTE],
    };
  };
}

export function setPriceListEntriesPreview(
  contract: Contract,
): (input: SetEntriesFields, env: PreviewEnv) => Promise<ActionPreview> {
  return async (input, env) => {
    const companyId = previewCompanyScope(env.companyId, contract);
    const list = await loadPriceList(env, companyId, input.priceListId);
    const entries = uniqueEntries(input.entries);
    const names = await loadCatalogNames(env, entries);
    const stored = await loadStoredEntries(
      env,
      companyId,
      input.priceListId,
      entries.map((entry) => entry.productId),
    );
    return {
      title: `Змінити ціни в прайс-листі: ${list.name}`,
      lines: entries.map((entry) => {
        const previous = stored.get(entryKey(entry.productId, entry.variantId));
        return changeLine(
          entryLabel(names, entry),
          previous === undefined ? null : storedPriceText(previous),
          formatMoneyMinor(entry.priceMinor, entry.currency),
        );
      }),
    };
  };
}

export function removePriceListEntriesPreview(
  contract: Contract,
): (input: RemoveEntriesFields, env: PreviewEnv) => Promise<ActionPreview> {
  return async (input, env) => {
    const companyId = previewCompanyScope(env.companyId, contract);
    const list = await loadPriceList(env, companyId, input.priceListId);
    const requested = uniqueEntries(input.entries);
    const stored = await loadStoredEntries(
      env,
      companyId,
      input.priceListId,
      requested.map((entry) => entry.productId),
    );
    const matched = requested.filter((entry) =>
      stored.has(entryKey(entry.productId, entry.variantId)),
    );
    const names = await loadCatalogNames(env, matched);
    const lines: ActionPreviewLine[] = matched.flatMap((entry) => {
      const row = stored.get(entryKey(entry.productId, entry.variantId));
      return row === undefined
        ? []
        : [{ label: entryLabel(names, entry), value: storedPriceText(row) }];
    });
    return {
      title: `Видалити ціни з прайс-листа: ${list.name}`,
      lines:
        lines.length === 0
          ? [
              {
                label: PRICE_LIST_ENTRIES_LABEL,
                value: PRICE_LIST_ENTRIES_EMPTY,
              },
            ]
          : lines,
    };
  };
}
