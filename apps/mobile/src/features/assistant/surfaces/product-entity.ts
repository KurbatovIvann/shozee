import {
  ASSISTANT_ENTITY_ARCHIVED_STATUS,
  PRODUCT_ENTITY_PROMPT_LINE,
  PRODUCT_ENTITY_SURFACE_TOOLS,
  type AssistantProductEntityData,
  type AssistantSurfaceDestination,
} from "@showzy/validation/assistant-surfaces";

import type { StatusPillTone } from "../../../components/ui/status-pill";
import { assistantCopy } from "../../../i18n/assistant";
import type { Locale } from "../../../i18n/locale";
import { productsCopy } from "../../../i18n/products";
import { variantCountLabel } from "../../catalog/products/shared/variant-count";
import { assistantRecordHref } from "../shared/assistant-record-hrefs";
import { formatMoneyAmount } from "./helpers";
import type { AssistantResultMarks } from "./marks";

export { PRODUCT_ENTITY_PROMPT_LINE, PRODUCT_ENTITY_SURFACE_TOOLS };

export type AssistantProductEntityCardView = {
  readonly kind: "product-entity";
  readonly destination: AssistantSurfaceDestination;
  readonly handoffLabel: string | null;
  readonly id: string;
  readonly productId: string;
  readonly href: string;
  readonly name: string | null;
  readonly goneLabel: string;
  readonly detailRows: readonly string[];
  readonly priceLabel: string | null;
  readonly statusLabel: string | null;
  readonly statusTone: StatusPillTone;
  readonly marks?: AssistantResultMarks;
};

export function localizeProductEntityCard(
  data: AssistantProductEntityData,
  locale: Locale,
): AssistantProductEntityCardView {
  const cards = assistantCopy(locale).cards;
  const products = productsCopy(locale);
  const archived = data.status === ASSISTANT_ENTITY_ARCHIVED_STATUS;
  const gone = data.name === null;
  const callId = data.toolCallId;
  return {
    kind: "product-entity",
    destination: data.destination,
    handoffLabel: gone ? null : cards.openProduct,
    id:
      callId !== undefined && callId.length > 0
        ? callId
        : `product-entity:${data.productId}`,
    productId: data.productId,
    href: assistantRecordHref("product", data.productId),
    name: data.name,
    goneLabel: cards.recordGone,
    detailRows: gone
      ? []
      : [variantCountLabel(data.variantCount, locale, products.variants)],
    priceLabel: gone ? null : formatMoneyAmount(data.basePrice),
    statusLabel: archived ? products.archivedBadge : null,
    statusTone: archived ? "attention" : "neutral",
  };
}
