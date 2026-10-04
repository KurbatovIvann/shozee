const LINES_PER_INPUT_ITEM = {
  "catalog.createProduct.variants": 1,
  "orders.create.items": 1,
  "pricing.removePriceListEntries.entries": 1,
  "pricing.setPriceListEntries.entries": 1,
} as const;

export type PreviewItemArrayPath = keyof typeof LINES_PER_INPUT_ITEM;

export const PREVIEW_CARD_LINES_PER_INPUT_ITEM: Readonly<
  Record<PreviewItemArrayPath, number>
> = LINES_PER_INPUT_ITEM;
