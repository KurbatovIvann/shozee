import type { ShoCommand, ShoParam, ShoRef } from "@showzy/sho-protocol";

import type { ShoToolCall } from "../sho-turn.js";

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

export interface ShoPlanRefusal {
  readonly kind: "fallback";
  readonly reason: ShoPlanFallbackReason;
}

export type ShoActionPlan =
  ({ readonly kind: "call" } & Omit<ShoToolCall, "writes">) | ShoPlanRefusal;

export interface ShoActionPlanner {
  readonly writes: boolean;
  readonly plan: (command: ShoCommand, now: Date) => ShoActionPlan;
}

export type ShoActionPlanners = Readonly<Record<string, ShoActionPlanner>>;

export const shoPlanFallback = (
  reason: ShoPlanFallbackReason,
): ShoPlanRefusal => ({
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

export const SHO_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function shoIsRef(param: ShoParam): param is ShoRef {
  return !Array.isArray(param) && "status" in param && !("attrs" in param);
}

export function shoLocatorFor(ref: ShoRef): ShoLocatorOutcome {
  if (ref.status === "context") {
    return typeof ref.id === "string" && ref.id.length > 0
      ? { kind: "locator", locator: { by: "id", id: ref.id } }
      : refused("conversation_dependent");
  }
  if (ref.focus !== undefined || ref.status === "previous") {
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

export function shoRefLocator(
  param: ShoParam,
): ShoLocator | ShoPlanFallbackReason {
  if (!shoIsRef(param)) {
    return "unsupported_param";
  }
  const outcome = shoLocatorFor(param);
  if (outcome.kind === "fallback") {
    return outcome.reason;
  }
  const locator = outcome.locator;
  return locator.by === "id" && !SHO_UUID.test(locator.id)
    ? "unsupported_param"
    : locator;
}

export const shoRefused = (mapped: unknown): mapped is ShoPlanFallbackReason =>
  typeof mapped === "string";
