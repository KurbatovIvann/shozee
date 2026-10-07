import {
  resolveAssistantSurfaceDestination,
  type AssistantSurfaceDestination,
  type AssistantSurfaceDestinationDeclaration,
} from "@showzy/validation/assistant-surfaces";

import type { StatusPillTone } from "../../../components/ui/status-pill";
import {
  assistantRecordHref,
  type AssistantRecordKind,
} from "../shared/assistant-record-hrefs";
import type { AssistantResultMarks } from "./marks";

export type AssistantEntityCardView = {
  readonly kind:
    | "customer-entity"
    | "product-entity"
    | "price-list-entity"
    | "customer-group-entity";
  readonly destination: AssistantSurfaceDestination;
  readonly handoffLabel: string;
  readonly id: string;
  readonly recordId: string;
  readonly href: string;
  readonly title: string;
  readonly detailRows: readonly string[];
  readonly valueLabel: string | null;
  readonly statusLabel: string | null;
  readonly statusTone: StatusPillTone;
  readonly footnotes: readonly string[];
  readonly marks?: AssistantResultMarks;
};

export function entityCardRecord(
  kind: AssistantRecordKind,
  declaration: AssistantSurfaceDestinationDeclaration,
  recordId: string,
): {
  readonly href: string;
  readonly destination: AssistantSurfaceDestination;
} {
  const href = assistantRecordHref(kind, recordId);
  return {
    href,
    destination: resolveAssistantSurfaceDestination(declaration, href),
  };
}

export function entityCardId(
  toolCallId: string | undefined,
  fallback: string,
): string {
  return toolCallId !== undefined && toolCallId.length > 0
    ? toolCallId
    : fallback;
}
