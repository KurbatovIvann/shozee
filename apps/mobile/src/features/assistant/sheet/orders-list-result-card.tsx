import { memo } from "react";

import type { AssistantOrdersListCardView } from "../surfaces";
import { AssistantCollectionBlock } from "./assistant-collection-block";

/**
 * Live `orders_list_page` rows (SHO-369 / SHO-469 / SHO-472). Chrome
 * (chips, empty, footnotes, CTA, Card) lives on `AssistantResultFrame`.
 * Row tree is the shared collection block — not an independent list
 * implementation.
 */
export const OrdersListResultCard = memo(function OrdersListResultCard(props: {
  readonly card: AssistantOrdersListCardView;
  readonly onOpenHref: (href: string) => void;
}) {
  return (
    <AssistantCollectionBlock
      collection={props.card.collection}
      onOpenHref={props.onOpenHref}
    />
  );
});
