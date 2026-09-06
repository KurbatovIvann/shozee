import { memo } from "react";

import type { AssistantSurface } from "../surfaces";
import {
  assistantResultMarks,
  type AssistantResultAction,
  type AssistantResultChip,
} from "./assistant-result-chrome";
import { AssistantResultFrame } from "./assistant-result-frame";
import { OrderEntityCard } from "./order-entity-card";
import { OrdersAggregateResultCard } from "./orders-aggregate-result-card";
import { OrdersListResultCard } from "./orders-list-result-card";

/**
 * SHO-469: one frame plus a block switch for registered result-card
 * kinds. Timeline and HITL stay in the message row; HITL chrome uses
 * the same frame with no block.
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

const AssistantSurfaceBlock = memo(function AssistantSurfaceBlock(props: {
  readonly surface: AssistantSurface;
  readonly onOpenHref: (href: string) => void;
}) {
  const { surface, onOpenHref } = props;
  switch (surface.kind) {
    case "orders-list":
      return surface.emptyTitle !== null ? null : (
        <OrdersListResultCard card={surface} onOpenHref={onOpenHref} />
      );
    case "orders-aggregate":
      return <OrdersAggregateResultCard card={surface} />;
    case "order-entity":
      return <OrderEntityCard card={surface} onOpenHref={onOpenHref} />;
  }
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
  if (surface.kind === "orders-list") {
    return secondaryCta(surface.ctaLabel, surface.ctaHref, onOpenHref);
  }
  return [
    {
      id: "cta",
      label: surface.ctaLabel,
      variant: "secondary",
      fullWidth: true,
      onPress: () => {
        onOpenHref(surface.ctaHref);
      },
    },
  ];
}

function secondaryCta(
  label: string | null,
  href: string | null,
  onOpenHref: (href: string) => void,
): readonly AssistantResultAction[] {
  if (label === null || href === null) {
    return [];
  }
  return [
    {
      id: "cta",
      label,
      variant: "secondary",
      fullWidth: true,
      onPress: () => {
        onOpenHref(href);
      },
    },
  ];
}
