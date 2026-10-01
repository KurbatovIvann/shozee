import { interpolate } from "@showzy/copy/locale";
import { countPluralForm } from "@showzy/copy/plural";
import {
  CUSTOMER_ENTITY_PROMPT_LINE,
  CUSTOMER_ENTITY_SURFACE_TOOLS,
  PRODUCT_ENTITY_PROMPT_LINE,
  PRODUCT_ENTITY_SURFACE_TOOLS,
  type AssistantCustomerEntityData,
  type AssistantProductEntityData,
  type AssistantSurfaceDestination,
} from "@showzy/validation/assistant-surfaces";

import type { StatusPillTone } from "../../../components/ui/status-pill";
import { assistantCopy } from "../../../i18n/assistant";
import { customersCopy } from "../../../i18n/customers";
import type { Locale } from "../../../i18n/locale";
import { productsCopy } from "../../../i18n/products";
import { productPhotoHref } from "../../catalog/products/shared/product-hrefs";
import { customerEditorHref } from "../../customers/shared/customer-hrefs";
import { formatMoneyAmount } from "./helpers";
import type { AssistantResultMarks } from "./marks";

export {
  CUSTOMER_ENTITY_PROMPT_LINE,
  CUSTOMER_ENTITY_SURFACE_TOOLS,
  PRODUCT_ENTITY_PROMPT_LINE,
  PRODUCT_ENTITY_SURFACE_TOOLS,
};

export type AssistantEntityCardView = {
  readonly kind: "customer-entity" | "product-entity";
  readonly destination: AssistantSurfaceDestination;
  readonly handoffLabel: string;
  readonly id: string;
  readonly entityId: string;
  readonly href: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly statusLabel: string | null;
  readonly statusTone: StatusPillTone;
  readonly detailLabel: string | null;
  readonly marks?: AssistantResultMarks;
};

function joinMeta(parts: readonly (string | null)[]): string | null {
  const joined = parts
    .filter((part): part is string => part !== null && part.length > 0)
    .join(" · ");
  return joined.length > 0 ? joined : null;
}

function cardId(toolCallId: string | undefined, fallback: string): string {
  return toolCallId !== undefined && toolCallId.length > 0
    ? toolCallId
    : fallback;
}

export function localizeCustomerEntityCard(
  data: AssistantCustomerEntityData,
  locale: Locale,
): AssistantEntityCardView {
  const archived = data.status === "archived";
  return {
    kind: "customer-entity",
    destination: data.destination,
    handoffLabel: assistantCopy(locale).cards.openCustomer,
    id: cardId(data.toolCallId, `customer-entity:${data.customerId}`),
    entityId: data.customerId,
    href: customerEditorHref(data.customerId),
    title: data.name,
    subtitle: joinMeta([data.phone, data.email]),
    statusLabel: archived ? customersCopy(locale).archivedBadge : null,
    statusTone: archived ? "attention" : "neutral",
    detailLabel: null,
  };
}

export function localizeProductEntityCard(
  data: AssistantProductEntityData,
  locale: Locale,
): AssistantEntityCardView {
  const archived = data.status === "archived";
  const products = productsCopy(locale);
  return {
    kind: "product-entity",
    destination: data.destination,
    handoffLabel: assistantCopy(locale).cards.openProduct,
    id: cardId(data.toolCallId, `product-entity:${data.productId}`),
    entityId: data.productId,
    href: productPhotoHref(data.productId),
    title: data.name,
    subtitle:
      data.variantCount > 0
        ? interpolate(
            products.variants[countPluralForm(data.variantCount, locale)],
            { count: String(data.variantCount) },
          )
        : null,
    statusLabel: archived ? products.archivedBadge : null,
    statusTone: archived ? "attention" : "neutral",
    detailLabel: formatMoneyAmount(data.basePrice),
  };
}
