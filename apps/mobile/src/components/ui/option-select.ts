export type OptionSelectItem = {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
};

export function optionSelectItems(
  items: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly description?: string | null;
  }>,
): readonly OptionSelectItem[] {
  return items.map((item) => {
    const description =
      item.description != null && item.description.length > 0
        ? item.description
        : undefined;
    if (description === undefined) {
      return { id: item.id, name: item.name };
    }
    return { id: item.id, name: item.name, description };
  });
}

export function filterOptionSelectItems(
  options: readonly OptionSelectItem[],
  query: string,
): readonly OptionSelectItem[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) {
    return options;
  }
  return options.filter((option) => {
    if (option.name.toLowerCase().includes(normalized)) {
      return true;
    }
    const description = option.description;
    if (description === undefined) {
      return false;
    }
    return description.toLowerCase().includes(normalized);
  });
}

export function visibleOptionSelectItems(args: {
  readonly options: readonly OptionSelectItem[];
  readonly query: string;
  readonly serverFiltered: boolean;
}): readonly OptionSelectItem[] {
  if (args.serverFiltered) {
    return args.options;
  }
  return filterOptionSelectItems(args.options, args.query);
}

export function flattenPages<T>(
  pages: ReadonlyArray<{ readonly items: readonly T[] }>,
): readonly T[] {
  return pages.flatMap((page) => page.items);
}
