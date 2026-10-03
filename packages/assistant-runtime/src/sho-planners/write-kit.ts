import type { ShoCommand, ShoNeed, ShoParam } from "@showzy/sho-protocol";

import {
  shoPlanFallback,
  shoRefused,
  type ShoActionPlan,
  type ShoActionPlanner,
  type ShoActionPlanners,
  type ShoPlanFallbackReason,
} from "./kit.js";

export type ShoWriteFields = Record<string, unknown>;

export type ShoWriteMapped = ShoWriteFields | ShoPlanFallbackReason;

export type ShoWriteParamMapper = (
  param: ShoParam,
  command: ShoCommand,
) => ShoWriteMapped;

export interface ShoWritePlan {
  readonly toolName: string;
  readonly reply: string;
  readonly params: Readonly<Record<string, ShoWriteParamMapper>>;
  readonly required: readonly string[];
  readonly oneOf?: readonly (readonly string[])[];
  readonly notes?: Readonly<Record<string, string>>;
}

export type ShoWritePlans = Readonly<Record<string, ShoWritePlan>>;

export function shoSpokenText(param: ShoParam): string | null {
  if (Array.isArray(param)) {
    return null;
  }
  const said =
    "value" in param && typeof param.value === "string"
      ? param.value
      : "text" in param
        ? param.text
        : null;
  const text = said?.trim() ?? "";
  return text.length === 0 ? null : text;
}

function noteOf(prefix: string, need: ShoNeed): string {
  const span = need.span?.text.trim() ?? "";
  return span.length === 0 ? `${prefix}.` : `${prefix}: «${span}».`;
}

export function shoWriteNotes(
  command: ShoCommand,
  notes: Readonly<Record<string, string>>,
): readonly string[] {
  return command.needs.flatMap((need) => {
    const prefix = need.blocking ? undefined : notes[need.reason];
    return prefix === undefined ? [] : [noteOf(prefix, need)];
  });
}

function inputFor(plan: ShoWritePlan, command: ShoCommand): ShoWriteMapped {
  const input: ShoWriteFields = {};
  for (const [name, param] of Object.entries(command.params)) {
    const mapper = plan.params[name];
    if (mapper === undefined) {
      return "unsupported_param";
    }
    const mapped = mapper(param, command);
    if (shoRefused(mapped)) {
      return mapped;
    }
    for (const [field, value] of Object.entries(mapped)) {
      if (field in input) {
        return "unsupported_param";
      }
      input[field] = value;
    }
  }
  const said = (name: string): boolean => name in command.params;
  return plan.required.every(said) &&
    (plan.oneOf ?? []).every((names) => names.some(said))
    ? input
    : "blocking_need";
}

export function shoWritePlanner(plan: ShoWritePlan): ShoActionPlanner {
  return {
    writes: true,
    plan: (command): ShoActionPlan => {
      const input = inputFor(plan, command);
      if (shoRefused(input)) {
        return shoPlanFallback(input);
      }
      const notes = shoWriteNotes(command, plan.notes ?? {});
      return {
        kind: "call",
        toolName: plan.toolName,
        input,
        reply: plan.reply,
        ...(notes.length === 0 ? {} : { notes }),
      };
    },
  };
}

export const shoWritePlanners = (plans: ShoWritePlans): ShoActionPlanners =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(plans).map(([action, plan]) => [
        action,
        shoWritePlanner(plan),
      ]),
    ),
  );

export const shoWriteActions = (plans: ShoWritePlans): readonly string[] =>
  Object.freeze(Object.keys(plans));

export const shoWritePlannerParams = (
  plans: ShoWritePlans,
): Readonly<Record<string, readonly string[]>> =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(plans).map(([action, plan]) => [
        action,
        Object.freeze(Object.keys(plan.params)),
      ]),
    ),
  );
