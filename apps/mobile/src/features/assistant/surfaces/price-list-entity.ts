import {
  PRICE_LIST_ENTITY_DESTINATION,
  PRICE_LIST_ENTITY_PROMPT_LINE,
  PRICE_LIST_ENTITY_SURFACE_TOOLS,
  type AssistantPriceListEntityData,
} from "@showzy/validation/assistant-surfaces";

import { assistantCopy } from "../../../i18n/assistant";
import type { Locale } from "../../../i18n/locale";
import { pricingCopy } from "../../../i18n/pricing";
import { entryCountLabel } from "../../pricing/shared/entry-count";
import type { StatusPillTone } from "../../../components/ui/status-pill";
import {
  entityCardId,
  entityCardRecord,
  type AssistantEntityCardView,
} from "./entity-card-view";

export { PRICE_LIST_ENTITY_PROMPT_LINE, PRICE_LIST_ENTITY_SURFACE_TOOLS };

function entityBadge(
  data: AssistantPriceListEntityData,
  pricing: ReturnType<typeof pricingCopy>,
): { readonly label: string | null; readonly tone: StatusPillTone } {
  if (data.isActive === false) {
    return { label: pricing.inactiveBadge, tone: "attention" };
  }
  if (data.isDefault === true) {
    return { label: pricing.defaultBadge, tone: "success" };
  }
  return { label: null, tone: "neutral" };
}

export function localizePriceListEntityCard(
  data: AssistantPriceListEntityData,
  locale: Locale,
): AssistantEntityCardView {
  const cards = assistantCopy(locale).cards;
  const pricing = pricingCopy(locale);
  const badge = entityBadge(data, pricing);
  const record = entityCardRecord(
    "priceList",
    PRICE_LIST_ENTITY_DESTINATION,
    data.priceListId,
  );
  return {
    kind: "price-list-entity",
    destination: record.destination,
    handoffLabel: cards.openPriceList,
    id: entityCardId(data.toolCallId, `price-list-entity:${data.priceListId}`),
    recordId: data.priceListId,
    href: record.href,
    title: data.name ?? data.priceListId,
    detailRows:
      data.entryCount === null
        ? []
        : [entryCountLabel(data.entryCount, locale, pricing.prices)],
    valueLabel: null,
    statusLabel: badge.label,
    statusTone: badge.tone,
    footnotes: [],
  };
}
