/**
 * Pure picker helpers for the counterparty form (SHO-196). Keep an
 * already-linked (possibly archived) customer in the sheet even when
 * `listCustomers` defaults to active.
 */
import type { OptionSelectItem } from "../shared/option-select";

/**
 * Linked-client display name: edit uses `getCounterparty.customerName`;
 * create-from-client uses `getCustomer.name` until (or instead of) the
 * active `listCustomers` drain.
 */
export function linkedCustomerName(args: {
  readonly fromCounterparty: string | null | undefined;
  readonly fromPrefillCustomer: string | null | undefined;
}): string | null {
  const fromCounterparty = args.fromCounterparty;
  if (fromCounterparty != null && fromCounterparty.length > 0) {
    return fromCounterparty;
  }
  const fromPrefill = args.fromPrefillCustomer;
  if (fromPrefill != null && fromPrefill.length > 0) {
    return fromPrefill;
  }
  return null;
}

/**
 * Seed the picker name map with `getCustomer.name` when the prefill
 * id is missing from the active `listCustomers` drain (still paging,
 * or archived).
 */
export function mergePrefillCustomerName(
  names: ReadonlyMap<string, string>,
  prefillCustomerId: string | null,
  prefillCustomerName: string | null,
): ReadonlyMap<string, string> {
  if (
    prefillCustomerId === null ||
    prefillCustomerName === null ||
    names.has(prefillCustomerId)
  ) {
    return names;
  }
  const next = new Map(names);
  next.set(prefillCustomerId, prefillCustomerName);
  return next;
}

export function pickedCustomerSnapshot(
  id: string | null,
  options: readonly OptionSelectItem[],
): { readonly id: string; readonly name: string } | null {
  if (id === null) {
    return null;
  }
  const option = options.find((row) => row.id === id);
  return option === undefined ? null : { id, name: option.name };
}

export function ensureLinkedCustomerOption(args: {
  readonly options: readonly OptionSelectItem[];
  readonly customerId: string | null;
  readonly customerName: string | null;
  readonly unnamedFallback: string;
}): readonly OptionSelectItem[] {
  const customerId = args.customerId;
  if (customerId === null) {
    return args.options;
  }
  if (args.options.some((option) => option.id === customerId)) {
    return args.options;
  }
  const name =
    args.customerName != null && args.customerName.length > 0
      ? args.customerName
      : args.unnamedFallback;
  return [{ id: customerId, name }, ...args.options];
}
