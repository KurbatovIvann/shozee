/**
 * Shared collection (table) descriptor for list-shaped assistant
 * surfaces (SHO-472). Orders-list and customers-list parse into this
 * type; they do not share a row cap. A third list is a new descriptor,
 * not a new block.
 *
 * `label` on columns is unlocalized at parse (empty or a stable id).
 * Cards localize before the block renders.
 */
export type AssistantCollectionColumnAlignment = "start" | "end";

export type AssistantCollectionColumnWidth = "flex" | "auto";

export type AssistantCollectionSurface = "inset" | "plain";

export type AssistantCollectionColumn = {
  readonly id: string;
  readonly label: string;
  readonly width: AssistantCollectionColumnWidth;
  readonly alignment: AssistantCollectionColumnAlignment;
};

export type AssistantCollectionRow = {
  readonly id: string;
  readonly title: string;
  readonly badge: string | null;
  readonly meta: string | null;
  readonly cells: readonly string[];
  readonly href: string | null;
};

export type AssistantCollectionDescriptor = {
  readonly columns: readonly AssistantCollectionColumn[];
  readonly rows: readonly AssistantCollectionRow[];
  readonly surface: AssistantCollectionSurface;
  readonly rowCap: number;
  readonly truncated: boolean;
};

export function capCollectionRows<T>(
  rows: readonly T[],
  rowCap: number,
): {
  readonly rows: readonly T[];
  readonly truncatedByCap: boolean;
} {
  if (rows.length <= rowCap) {
    return { rows, truncatedByCap: false };
  }
  return { rows: rows.slice(0, rowCap), truncatedByCap: true };
}

export function assistantCollectionDescriptor(args: {
  readonly columns: readonly AssistantCollectionColumn[];
  readonly rows: readonly AssistantCollectionRow[];
  readonly surface: AssistantCollectionSurface;
  readonly rowCap: number;
  readonly truncated: boolean;
}): AssistantCollectionDescriptor {
  return {
    columns: args.columns,
    rows: args.rows,
    surface: args.surface,
    rowCap: args.rowCap,
    truncated: args.truncated,
  };
}
