import {
  assistantSurfaceHandoffHref,
  type AssistantSurfaceDestination,
} from "@showzy/validation/assistant-surfaces";

import type { StatusPillTone } from "../../../components/ui/status-pill";

/**
 * Shared assistant result chrome (SHO-469 / SHO-470). Canvas CardFrame
 * slots, not a new surface kind. Provenance marks read optional fields
 * when present (SHO-464); absent columns render nothing. Destination
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

export type AssistantResultMarks = {
  readonly provisional: boolean;
  readonly origin: boolean;
  readonly originLabel: string | null;
};

/** Canvas origin sparkle. Optical, not a hit target (iconSize.sm is 18). */
export const ORIGIN_MARK_ICON_SIZE = 12;

const EMPTY_MARKS: AssistantResultMarks = {
  provisional: false,
  origin: false,
  originLabel: null,
};

/**
 * Read unvouched fill / origin mark from whatever the surface (or a
 * later SHO-464 column) already carries. Unknown objects without those
 * keys are not provisional and have no origin mark.
 */
export function assistantResultMarks(value: object): AssistantResultMarks {
  const provisional = "provisional" in value && value.provisional === true;
  const origin = "origin" in value && value.origin === true;
  if (
    "originLabel" in value &&
    typeof value.originLabel === "string" &&
    value.originLabel.length > 0
  ) {
    return {
      provisional,
      origin,
      originLabel: value.originLabel,
    };
  }
  return {
    provisional,
    origin,
    originLabel: null,
  };
}

export function assistantResultMarksFromUnknown(
  value: unknown,
): AssistantResultMarks {
  if (typeof value !== "object" || value === null) {
    return EMPTY_MARKS;
  }
  return assistantResultMarks(value);
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
