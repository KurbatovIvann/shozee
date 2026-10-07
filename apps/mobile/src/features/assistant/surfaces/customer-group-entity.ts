import {
  CUSTOMER_GROUP_ENTITY_DESTINATION,
  CUSTOMER_GROUP_ENTITY_PROMPT_LINE,
  CUSTOMER_GROUP_ENTITY_SURFACE_TOOLS,
  type AssistantCustomerGroupEntityData,
} from "@showzy/validation/assistant-surfaces";

import { assistantCopy } from "../../../i18n/assistant";
import { customersCopy } from "../../../i18n/customers";
import type { Locale } from "../../../i18n/locale";
import { memberCountLabel } from "../../customers/shared/member-count";
import {
  entityCardId,
  entityCardRecord,
  type AssistantEntityCardView,
} from "./entity-card-view";

export {
  CUSTOMER_GROUP_ENTITY_PROMPT_LINE,
  CUSTOMER_GROUP_ENTITY_SURFACE_TOOLS,
};

export function localizeCustomerGroupEntityCard(
  data: AssistantCustomerGroupEntityData,
  locale: Locale,
): AssistantEntityCardView {
  const cards = assistantCopy(locale).cards;
  const customers = customersCopy(locale);
  const record = entityCardRecord(
    "customerGroup",
    CUSTOMER_GROUP_ENTITY_DESTINATION,
    data.groupId,
  );
  const description = data.description ?? "";
  return {
    kind: "customer-group-entity",
    destination: record.destination,
    handoffLabel: cards.openCustomerGroup,
    id: entityCardId(data.toolCallId, `customer-group-entity:${data.groupId}`),
    recordId: data.groupId,
    href: record.href,
    title: data.name ?? data.groupId,
    detailRows: description.length > 0 ? [description] : [],
    valueLabel: null,
    statusLabel:
      data.memberCount === null
        ? null
        : memberCountLabel(data.memberCount, locale, customers.members),
    statusTone: "neutral",
    footnotes: [],
  };
}
