import {
  ASSISTANT_ENTITY_ARCHIVED_STATUS,
  PRODUCT_ENTITY_DESTINATION,
  PRODUCT_ENTITY_PROMPT_LINE,
  PRODUCT_ENTITY_SURFACE_TOOLS,
  type AssistantProductEntityData,
} from "@showzy/validation/assistant-surfaces";

import { assistantCopy } from "../../../i18n/assistant";
import type { Locale } from "../../../i18n/locale";
import { productsCopy } from "../../../i18n/products";
import { variantCountLabel } from "../../catalog/products/shared/variant-count";
import {
  entityCardId,
  entityCardRecord,
  type AssistantEntityCardView,
} from "./entity-card-view";
import { formatMoneyAmount } from "./helpers";

export { PRODUCT_ENTITY_PROMPT_LINE, PRODUCT_ENTITY_SURFACE_TOOLS };

export function localizeProductEntityCard(
  data: AssistantProductEntityData,
  locale: Locale,
): AssistantEntityCardView {
  const cards = assistantCopy(locale).cards;
  const products = productsCopy(locale);
  const archived = data.status === ASSISTANT_ENTITY_ARCHIVED_STATUS;
  const record = entityCardRecord(
    "product",
    PRODUCT_ENTITY_DESTINATION,
    data.productId,
  );
  return {
    kind: "product-entity",
    destination: record.destination,
    handoffLabel: cards.openProduct,
    id: entityCardId(data.toolCallId, `product-entity:${data.productId}`),
    recordId: data.productId,
    href: record.href,
    title: data.name ?? data.productId,
    detailRows:
      data.variantCount === null
        ? []
        : [variantCountLabel(data.variantCount, locale, products.variants)],
    valueLabel: formatMoneyAmount(data.basePrice),
    statusLabel: archived ? products.archivedBadge : null,
    statusTone: archived ? "attention" : "neutral",
    footnotes: data.variantsClipped ? [cards.variantsClipped] : [],
  };
}
