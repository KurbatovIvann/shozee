import {
  assistantSurfaceHandoffHref,
  type AssistantSurfaceDestination,
} from "@showzy/validation/assistant-surfaces";

import type { StatusPillTone } from "../../../components/ui/status-pill";
import type {
  AssistantResultMarks,
  AssistantResultMarksCarrier,
} from "../surfaces";

/**
 * Shared assistant result chrome (SHO-469 / SHO-470). Canvas CardFrame
 * slots, not a new surface kind. Provenance marks read the `marks` field
 * a card view declares (`../surfaces/marks.ts`, SHO-497); no surface
 * declares one yet and an absent field renders nothing. Destination
 * handoff is screen-only; terminal is declared, never defaulted.
 */

export type AssistantResultPill = {
  readonly label: string;
  readonly tone: StatusPillTone;
};

export type AssistantResultChip = {
  readonly key: string;
  readonly label: string;
  readonly tone: StatusPillTone;
};

export type AssistantResultAction = {
  readonly id: string;
  readonly label: string;
  readonly variant?: "primary" | "secondary" | "ghost" | "danger";
  readonly fullWidth?: boolean;
  readonly onPress: () => void;
};

/** Canvas origin sparkle. Optical, not a hit target (iconSize.sm is 18). */
export const ORIGIN_MARK_ICON_SIZE = 12;

const EMPTY_MARKS: AssistantResultMarks = {
  provisional: false,
  origin: false,
  originLabel: null,
};

/**
 * Unvouched fill / origin mark for one card. Reads the field the view
 * declares — see `../surfaces/marks.ts` for the shape, why nothing fills
 * it yet, and what the producer will have to do. A view without `marks`
 * is not provisional and has no origin mark.
 */
export function assistantResultMarks(
  view: AssistantResultMarksCarrier,
): AssistantResultMarks {
  return view.marks ?? EMPTY_MARKS;
}

/**
 * Frame handoff for a declared destination (SHO-470). `screen` yields
 * the route. `terminal` / `document` / absent yield nothing — never
 * default missing to terminal.
 */
export function assistantResultHandoff(
  destination: AssistantSurfaceDestination | null | undefined,
): { readonly href: string } | null {
  if (destination === null || destination === undefined) {
    return null;
  }
  const href = assistantSurfaceHandoffHref(destination);
  if (href === null) {
    return null;
  }
  return { href };
}

/**
 * T1 secondary CTA. Omitted when it would open the same screen as the
 * destination handoff — two identical doors (SHO-470).
 */
export function assistantResultCta(
  label: string | null,
  href: string | null,
  destination: AssistantSurfaceDestination | null | undefined,
): { readonly label: string; readonly href: string } | null {
  if (label === null || href === null || label.length === 0) {
    return null;
  }
  const handoff = assistantResultHandoff(destination);
  if (handoff !== null && handoff.href === href) {
    return null;
  }
  return { label, href };
}
