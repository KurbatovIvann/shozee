import { memo } from "react";

import type { AssistantOrdersAggregateCardView } from "../surfaces";
import { AssistantAggregateBlock } from "./assistant-aggregate-block";

/**
 * Live `orders_list_counts` body (SHO-370 / SHO-395 / SHO-469 / SHO-473).
 * Chrome (empty, footnotes, CTA, Card) lives on `AssistantResultFrame`.
 * Period, totals, always-on status rows, optional product/customer
 * section render through the shared aggregate `summary` layout — not a
 * chart and not the orders list screen.
 */
export const OrdersAggregateResultCard = memo(
  function OrdersAggregateResultCard(props: {
    readonly card: AssistantOrdersAggregateCardView;
    readonly onOpenHref: (href: string) => void;
  }) {
    return (
      <AssistantAggregateBlock
        aggregate={props.card.aggregate}
        onOpenHref={props.onOpenHref}
      />
    );
  },
);
