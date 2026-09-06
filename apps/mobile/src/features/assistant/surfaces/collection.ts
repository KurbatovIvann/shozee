/**
 * Localized collection view for list-shaped assistant surfaces
 * (SHO-472). Parse descriptors stay unlocalized; this is what the
 * collection block renders.
 */
import type {
  AssistantCollectionColumnAlignment,
  AssistantCollectionColumnWidth,
  AssistantCollectionDescriptor,
  AssistantCollectionSurface,
} from "@showzy/validation/assistant-surfaces";

import type { StatusPillTone } from "../../../components/ui/status-pill";

export type AssistantCollectionColumnView = {
  readonly id: string;
  readonly label: string;
  readonly width: AssistantCollectionColumnWidth;
  readonly alignment: AssistantCollectionColumnAlignment;
};

export type AssistantCollectionRowView = {
  readonly id: string;
  readonly title: string;
  readonly badge: string | null;
  readonly badgeTone: StatusPillTone;
  readonly meta: string | null;
  readonly cells: readonly string[];
  readonly href: string | null;
};

export type AssistantCollectionView = {
  readonly columns: readonly AssistantCollectionColumnView[];
  readonly rows: readonly AssistantCollectionRowView[];
  readonly surface: AssistantCollectionSurface;
  readonly rowCap: number;
  readonly truncated: boolean;
};

export function localizeAssistantCollection(
  descriptor: AssistantCollectionDescriptor,
  rows: readonly AssistantCollectionRowView[],
): AssistantCollectionView {
  return {
    columns: descriptor.columns.map((column) => ({
      id: column.id,
      label: column.label,
      width: column.width,
      alignment: column.alignment,
    })),
    rows,
    surface: descriptor.surface,
    rowCap: descriptor.rowCap,
    truncated: descriptor.truncated,
  };
}
