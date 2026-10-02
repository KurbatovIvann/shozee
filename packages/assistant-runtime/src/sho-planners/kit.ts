import type { ShoCommand, ShoRef } from "@showzy/sho-protocol";

import type { ShoPlan } from "../sho-turn.js";

export const SHO_PLAN_FALLBACK_REASONS = [
  "many_commands",
  "no_command",
  "unrecognized_shape",
  "ui_answer",
  "needs_dialogue",
  "needs_reference",
  "unsupported_action",
  "conversation_dependent",
  "low_confidence",
  "blocking_need",
  "not_whitelisted",
  "effect_mismatch",
  "unresolved_reference",
  "unsupported_param",
] as const;

export type ShoPlanFallbackReason = (typeof SHO_PLAN_FALLBACK_REASONS)[number];

export type ShoLocator =
  | { readonly by: "id"; readonly id: string }
  | { readonly by: "query"; readonly value: string };

export type ShoLocatorOutcome =
  | { readonly kind: "locator"; readonly locator: ShoLocator }
  | { readonly kind: "fallback"; readonly reason: ShoPlanFallbackReason };

export interface ShoActionPlanner {
  readonly writes: boolean;
  readonly plan: (command: ShoCommand, now: Date) => ShoPlan;
}

export type ShoActionPlanners = Readonly<Record<string, ShoActionPlanner>>;

export const shoPlanFallback = (reason: ShoPlanFallbackReason): ShoPlan => ({
  kind: "fallback",
  reason,
});

const refused = (reason: ShoPlanFallbackReason): ShoLocatorOutcome => ({
  kind: "fallback",
  reason,
});

const offersChoice = (ref: ShoRef): boolean =>
  (ref.candidates ?? []).length > 0 || (ref.nearest ?? []).length > 0;

const byQuery = (value: string): ShoLocatorOutcome =>
  value.trim().length === 0
    ? refused("unresolved_reference")
    : { kind: "locator", locator: { by: "query", value } };

export function shoLocatorFor(ref: ShoRef): ShoLocatorOutcome {
  if (
    ref.focus !== undefined ||
    ref.status === "previous" ||
    ref.status === "context"
  ) {
    return refused("conversation_dependent");
  }
  if (ref.status === "resolved") {
    return typeof ref.id === "string" && ref.id.length > 0
      ? { kind: "locator", locator: { by: "id", id: ref.id } }
      : refused("unresolved_reference");
  }
  if (ref.status === "unchecked") {
    return ref.by === "phone" || ref.by === "email"
      ? byQuery(ref.value ?? ref.text)
      : refused("unresolved_reference");
  }
  if (ref.status === "ambiguous" || ref.status === "unknown") {
    return offersChoice(ref)
      ? byQuery(ref.text)
      : refused("unresolved_reference");
  }
  return refused("unresolved_reference");
}
