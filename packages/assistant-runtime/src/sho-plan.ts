import {
  shoAsksDialogueModel,
  shoBlockingNeeds,
  SHO_UNRECOGNIZED,
  type ShoCommand,
  type ShoNeed,
  type ShoRef,
  type ShoResult,
} from "@showzy/sho-protocol";

import type { ShoPlanner } from "./sho-engine.js";
import type { ShoPlan } from "./sho-turn.js";

export const SHO_ACTION_CONFIDENCE_FLOOR = 0.95;

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
] as const;

export type ShoPlanFallbackReason = (typeof SHO_PLAN_FALLBACK_REASONS)[number];

export type ShoNeedRoute = "card" | "dialogue";

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

export const SHO_ACTION_PLANNERS: ShoActionPlanners = {};

export interface ShoPlannerDeps {
  readonly actions: readonly string[];
  readonly planners?: ShoActionPlanners;
}

const fallback = (reason: ShoPlanFallbackReason): ShoPlan => ({
  kind: "fallback",
  reason,
});

const refused = (reason: ShoPlanFallbackReason): ShoLocatorOutcome => ({
  kind: "fallback",
  reason,
});

export function shoNeedRoute(need: ShoNeed): ShoNeedRoute {
  return need.reason === "ambiguous" || need.reason === "unknown"
    ? "card"
    : "dialogue";
}

export function shoWrites(command: ShoCommand): boolean {
  return (
    command.kind === "write" ||
    command.kind === "high" ||
    command.effect === "write" ||
    command.effect === "destructive" ||
    command.confirm !== "none"
  );
}

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

function shapeIsKnown(command: ShoCommand): boolean {
  return (
    command.kind !== SHO_UNRECOGNIZED &&
    command.effect !== SHO_UNRECOGNIZED &&
    command.confirm !== SHO_UNRECOGNIZED
  );
}

function gate(command: ShoCommand): ShoPlanFallbackReason | null {
  if (!shapeIsKnown(command)) {
    return "unrecognized_shape";
  }
  if (command.kind === "none" || command.action === "none") {
    return "no_command";
  }
  if (command.kind === "ui") {
    return "ui_answer";
  }
  if (shoAsksDialogueModel(command)) {
    return "needs_dialogue";
  }
  if (
    command.needs.some(
      (need) =>
        need.reason === "reference" || need.reason === "check_reference",
    )
  ) {
    return "needs_reference";
  }
  if (
    command.needs.some(
      (need) => need.reason === "unsupported" && need.path === "action",
    )
  ) {
    return "unsupported_action";
  }
  if (
    command.refines !== undefined ||
    Object.keys(command.refPrevious).length > 0
  ) {
    return "conversation_dependent";
  }
  if (command.confidence.action < SHO_ACTION_CONFIDENCE_FLOOR) {
    return "low_confidence";
  }
  const blocking = shoBlockingNeeds(command);
  if (!command.ready && blocking.length === 0) {
    return "blocking_need";
  }
  return blocking.some((need) => shoNeedRoute(need) === "dialogue")
    ? "blocking_need"
    : null;
}

function planFor(
  result: ShoResult,
  now: Date,
  allowed: ReadonlySet<string>,
  planners: ShoActionPlanners,
): ShoPlan {
  if (result.tooMany || result.commands.length > 1) {
    return fallback("many_commands");
  }
  const command = result.commands[0];
  if (command === undefined) {
    return fallback("no_command");
  }
  const refusal = gate(command);
  if (refusal !== null) {
    return fallback(refusal);
  }
  const planner = allowed.has(command.action)
    ? planners[command.action]
    : undefined;
  if (planner === undefined) {
    return fallback("not_whitelisted");
  }
  return planner.writes === shoWrites(command)
    ? planner.plan(command, now)
    : fallback("effect_mismatch");
}

export function createShoPlanner(deps: ShoPlannerDeps): ShoPlanner {
  const planners = deps.planners ?? SHO_ACTION_PLANNERS;
  const allowed = new Set(deps.actions);
  return (result, now) => planFor(result, now, allowed, planners);
}
