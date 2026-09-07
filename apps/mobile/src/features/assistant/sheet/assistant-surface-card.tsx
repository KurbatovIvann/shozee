import { memo, type ReactElement } from "react";

import type { AssistantSurface } from "../surfaces";
import { AssistantCollectionBlock } from "./assistant-collection-block";
import {
  assistantResultCta,
  assistantResultMarks,
  type AssistantResultAction,
  type AssistantResultChip,
} from "./assistant-result-chrome";
import { AssistantResultFrame } from "./assistant-result-frame";
import { OrderEntityCard } from "./order-entity-card";
import { OrdersAggregateResultCard } from "./orders-aggregate-result-card";

/**
 * SHO-469 / SHO-472 / SHO-473: one frame plus a block switch for
 * registered result-card kinds. List-shaped kinds share
 * `AssistantCollectionBlock`. Aggregate kinds share
 * `AssistantAggregateBlock` (`summary` | `breakdown`). Timeline and
 * HITL stay in the message row; HITL chrome uses the same frame with
 * no block.
 */
export const AssistantSurfaceCard = memo(function AssistantSurfaceCard(props: {
  readonly surface: AssistantSurface;
  readonly onOpenHref: (href: string) => void;
}) {
  const { surface, onOpenHref } = props;
  const marks = assistantResultMarks(surface);
  const empty = surfaceEmpty(surface);
  return (
    <AssistantResultFrame
      chips={surfaceChips(surface)}
      emptyTitle={empty.title}
      emptyDescription={empty.description}
      footnotes={surfaceFootnotes(surface)}
      actions={surfaceActions(surface, onOpenHref)}
      destination={surface.destination}
      handoffLabel={surface.handoffLabel}
      onOpenHref={onOpenHref}
      provisional={marks.provisional}
      origin={marks.origin}
      originLabel={marks.originLabel}
    >
      <AssistantSurfaceBlock surface={surface} onOpenHref={onOpenHref} />
    </AssistantResultFrame>
  );
});

/**
 * SHO-498: the switch that decides whether a card appears at all. The
 * declared return type plus the `never` assignment below make an
 * unhandled `surface.kind` a compile error, not an empty frame. Both
 * list kinds call `AssistantCollectionBlock` directly — there is one
 * spelling of that call, not a per-list pass-through wrapper.
 */
const AssistantSurfaceBlock = memo(function AssistantSurfaceBlock(props: {
  readonly surface: AssistantSurface;
  readonly onOpenHref: (href: string) => void;
}): ReactElement | null {
  const { surface, onOpenHref } = props;
  switch (surface.kind) {
    case "orders-list":
    case "customers-list":
      return surface.emptyTitle !== null ? null : (
        <AssistantCollectionBlock
          collection={surface.collection}
          onOpenHref={onOpenHref}
        />
      );
    case "orders-aggregate":
      return (
        <OrdersAggregateResultCard card={surface} onOpenHref={onOpenHref} />
      );
    case "order-entity":
      return <OrderEntityCard card={surface} onOpenHref={onOpenHref} />;
  }
  const unhandledSurfaceKind: never = surface;
  return unhandledSurfaceKind;
});

function surfaceChips(
  surface: AssistantSurface,
): readonly AssistantResultChip[] {
  if (surface.kind !== "orders-list" || surface.chips.length === 0) {
    return [];
  }
  return surface.chips.map((chip) => ({
    key: chip.status,
    label: chip.label,
    tone: chip.tone,
  }));
}

function surfaceEmpty(surface: AssistantSurface): {
  readonly title: string | null;
  readonly description: string | null;
} {
  if (surface.kind === "order-entity") {
    return { title: null, description: null };
  }
  return {
    title: surface.emptyTitle,
    description: surface.emptyDescription,
  };
}

function surfaceFootnotes(surface: AssistantSurface): readonly string[] {
  if (surface.kind === "order-entity" || surface.footnotes.length === 0) {
    return [];
  }
  return surface.footnotes;
}

function surfaceActions(
  surface: AssistantSurface,
  onOpenHref: (href: string) => void,
): readonly AssistantResultAction[] {
  if (surface.kind === "order-entity") {
    return [];
  }
  return secondaryCta(
    surface.ctaLabel,
    surface.ctaHref,
    surface.destination,
    onOpenHref,
  );
}

function secondaryCta(
  label: string | null,
  href: string | null,
  destination: AssistantSurface["destination"],
  onOpenHref: (href: string) => void,
): readonly AssistantResultAction[] {
  const cta = assistantResultCta(label, href, destination);
  if (cta === null) {
    return [];
  }
  return [
    {
      id: "cta",
      label: cta.label,
      variant: "secondary",
      fullWidth: true,
      onPress: () => {
        onOpenHref(cta.href);
      },
    },
  ];
}
