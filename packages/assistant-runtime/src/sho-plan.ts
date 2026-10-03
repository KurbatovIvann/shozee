import {
  shoAsksDialogueModel,
  shoBlockingNeeds,
  SHO_UNRECOGNIZED,
  type ShoCommand,
  type ShoNeed,
  type ShoResult,
} from "@showzy/sho-protocol";

import type { ShoPlanner } from "./sho-engine.js";
import type { ShoPlan } from "./sho-turn.js";

import {
  shoPlanFallback,
  type ShoActionPlanners,
  type ShoPlanFallbackReason,
} from "./sho-planners/kit.js";
import { SHO_CUSTOMER_WRITE_PLANNERS } from "./sho-planners/customers-writes.js";
import { SHO_WRITE_PLANNERS } from "./sho-planners/orders-writes.js";
import { SHO_READ_PLANNERS } from "./sho-planners/reads.js";

export {
  shoLocatorFor,
  shoPlanFallback,
  shoRefLocator,
  SHO_PLAN_FALLBACK_REASONS,
  type ShoActionPlan,
  type ShoActionPlanner,
  type ShoActionPlanners,
  type ShoLocator,
  type ShoLocatorOutcome,
  type ShoPlanFallbackReason,
} from "./sho-planners/kit.js";

export const SHO_ACTION_CONFIDENCE_FLOOR = 0.95;

export type ShoNeedRoute = "card" | "dialogue";

export const SHO_ACTION_PLANNERS: ShoActionPlanners = Object.freeze({
  ...SHO_READ_PLANNERS,
  ...SHO_WRITE_PLANNERS,
  ...SHO_CUSTOMER_WRITE_PLANNERS,
});

export interface ShoPlannerDeps {
  readonly actions: readonly string[];
  readonly planners?: ShoActionPlanners;
}

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
    return shoPlanFallback("many_commands");
  }
  const command = result.commands[0];
  if (command === undefined) {
    return shoPlanFallback("no_command");
  }
  const refusal = gate(command);
  if (refusal !== null) {
    return shoPlanFallback(refusal);
  }
  const planner = allowed.has(command.action)
    ? planners[command.action]
    : undefined;
  if (planner === undefined) {
    return shoPlanFallback("not_whitelisted");
  }
  if (planner.writes !== shoWrites(command)) {
    return shoPlanFallback("effect_mismatch");
  }
  const planned = planner.plan(command, now);
  return planned.kind === "call"
    ? { ...planned, writes: planner.writes }
    : planned;
}

export function createShoPlanner(deps: ShoPlannerDeps): ShoPlanner {
  const planners = deps.planners ?? SHO_ACTION_PLANNERS;
  const allowed = new Set(deps.actions);
  return (result, now) => planFor(result, now, allowed, planners);
}
