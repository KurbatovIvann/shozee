import { shouldBlockDeactivateDefault } from "./price-lists-list.presenter";

export type PriceListOptionsChrome = {
  readonly visible: boolean;
  readonly listId: string | null;
};

export const IDLE_PRICE_LIST_OPTIONS: PriceListOptionsChrome = {
  visible: false,
  listId: null,
};

export function openPriceListOptions(listId: string): PriceListOptionsChrome {
  return { visible: true, listId };
}

/** Start close. Keep the selected row until `onHidden`. */
export function hidePriceListOptions(
  state: PriceListOptionsChrome,
): PriceListOptionsChrome {
  return { visible: false, listId: state.listId };
}

/**
 * Drop the selected row after the Modal is gone. A late `onHidden` from a
 * previous close must not clear a sheet that was reopened (`visible`).
 */
export function priceListOptionsHidden(
  state: PriceListOptionsChrome,
): PriceListOptionsChrome {
  if (state.visible) {
    return state;
  }
  return IDLE_PRICE_LIST_OPTIONS;
}

export type PriceListOptionsFollowUp =
  | { readonly kind: "setDefault" }
  | { readonly kind: "toggleActive" }
  | { readonly kind: "blockDeactivateDefault" }
  | { readonly kind: "delete" };

export function planPriceListOptionsFollowUp(args: {
  readonly action: "setDefault" | "toggleActive" | "delete";
  readonly isDefault: boolean;
  readonly isActive: boolean;
}): PriceListOptionsFollowUp {
  if (args.action === "delete") {
    return { kind: "delete" };
  }
  if (args.action === "setDefault") {
    return { kind: "setDefault" };
  }
  if (
    shouldBlockDeactivateDefault({
      isDefault: args.isDefault,
      isActive: args.isActive,
    })
  ) {
    return { kind: "blockDeactivateDefault" };
  }
  return { kind: "toggleActive" };
}

export function optionsFollowUpWaitsForHidden(
  followUp: PriceListOptionsFollowUp,
): boolean {
  return (
    followUp.kind === "delete" || followUp.kind === "blockDeactivateDefault"
  );
}

type OptionsSheetHiddenPorts = {
  readonly waitHidden: () => Promise<void>;
  readonly hide: () => void;
};

export type PriceListDeleteFollowUpPorts = OptionsSheetHiddenPorts & {
  readonly kind: "delete";
  readonly deleteOnServerCard: () => Promise<void>;
};

export type PriceListBlockDeactivateFollowUpPorts = OptionsSheetHiddenPorts & {
  readonly kind: "blockDeactivateDefault";
  readonly setBanner: (message: string) => void;
  readonly message: string;
};

export type PriceListOptionsFollowUpPorts =
  PriceListDeleteFollowUpPorts | PriceListBlockDeactivateFollowUpPorts;

export async function runPriceListOptionsFollowUp(
  args: PriceListOptionsFollowUpPorts,
): Promise<void> {
  const hidden = args.waitHidden();
  args.hide();
  await hidden;
  if (args.kind === "delete") {
    await args.deleteOnServerCard();
    return;
  }
  args.setBanner(args.message);
}
