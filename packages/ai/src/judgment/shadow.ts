import {
  JUDGMENT_SHADOW_ARGS_MAX,
  JUDGMENT_SHADOW_LIST_MAX,
  JUDGMENT_SHADOW_TEXT_MAX,
  type JudgmentShadow,
  type JudgmentShadowArgValue,
  type JudgmentShadowCall,
} from "@showzy/validation/assistant-judgment";
import { isInflectionOfName } from "@showzy/validation/entity-ref";

import type { StaffJudgmentSpec } from "../tool-facades/judgment-specs.js";
import type { StaffJudgmentPlan } from "./staff-planner.js";

export interface ObservedToolCall {
  readonly toolName: string;
  readonly input: unknown;
}

const clip = (value: string): string =>
  value.slice(0, JUDGMENT_SHADOW_TEXT_MAX);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function itemLine(
  value: unknown,
  items: NonNullable<StaffJudgmentSpec["items"]>,
): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const product = value[items.product];
  const quantity = value[items.quantity];
  return typeof product === "string"
    ? clip(`${typeof quantity === "string" ? quantity : "1"}×${product}`)
    : undefined;
}

function shadowValue(value: unknown): JudgmentShadowArgValue | undefined {
  if (typeof value === "string") {
    return clip(value);
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value;
  }
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return value.slice(0, JUDGMENT_SHADOW_LIST_MAX).map(clip);
  }
  return undefined;
}

export function observedShadowCall(
  observed: ObservedToolCall,
  specs: readonly StaffJudgmentSpec[],
): JudgmentShadowCall {
  const spec = specs.find((entry) => entry.tool === observed.toolName);
  const args: Record<string, JudgmentShadowArgValue> = {};
  if (spec !== undefined && isRecord(observed.input)) {
    for (const name of Object.keys(spec.args)) {
      const value = shadowValue(observed.input[name]);
      if (value !== undefined) {
        args[name] = value;
      }
    }
    const items = spec.items;
    const lines = items === undefined ? undefined : observed.input[items.arg];
    if (items !== undefined && Array.isArray(lines)) {
      args[items.arg] = lines
        .flatMap((line) => itemLine(line, items) ?? [])
        .slice(0, JUDGMENT_SHADOW_LIST_MAX);
    }
  }
  return {
    tool: clip(observed.toolName).slice(0, 100),
    args: Object.fromEntries(
      Object.entries(args).slice(0, JUDGMENT_SHADOW_ARGS_MAX),
    ),
  };
}

const fold = (value: string): string =>
  value.normalize("NFC").trim().replaceAll(/\s+/g, " ").toLowerCase();

function sameText(planned: string, observed: string): boolean {
  return (
    fold(planned) === fold(observed) || isInflectionOfName(planned, observed)
  );
}

function sameValue(
  planned: JudgmentShadowArgValue,
  observed: JudgmentShadowArgValue | undefined,
): boolean {
  if (typeof planned === "string") {
    return typeof observed === "string" && sameText(planned, observed);
  }
  if (Array.isArray(planned)) {
    return (
      Array.isArray(observed) &&
      planned.length === observed.length &&
      planned.every((line) => observed.some((other) => sameText(line, other)))
    );
  }
  return planned === observed;
}

export function judgmentShadowOf(
  plan: StaffJudgmentPlan,
  observed: ObservedToolCall | undefined,
  specs: readonly StaffJudgmentSpec[],
  isWrite: (spec: StaffJudgmentSpec) => boolean,
): JudgmentShadow {
  const modelFirstCall =
    observed === undefined ? null : observedShadowCall(observed, specs);
  const spec = specs.find((entry) => entry.tool === plan.call?.tool);
  const toolAgrees =
    plan.refusal === undefined
      ? (plan.call?.tool ?? null) === (modelFirstCall?.tool ?? null)
      : null;
  const planned = plan.call;
  return {
    version: 1,
    model: plan.model.slice(0, 64),
    latencyMs: plan.latencyMs,
    ...(plan.refusal === undefined ? {} : { refusal: plan.refusal }),
    ...(plan.kind === undefined ? {} : { kind: plan.kind }),
    ...(plan.kindConfidence === undefined
      ? {}
      : { kindConfidence: plan.kindConfidence }),
    ...(planned === undefined || spec === undefined
      ? {}
      : {
          plan: {
            tool: planned.tool,
            args: planned.args,
            risk: isWrite(spec) ? ("write" as const) : ("read" as const),
            minConfidence: planned.minConfidence,
          },
        }),
    wouldTake: planned !== undefined && plan.declinedBecause === undefined,
    ...(plan.declinedBecause === undefined
      ? {}
      : { declinedBecause: plan.declinedBecause }),
    modelFirstCall,
    toolAgrees,
    argsAgree:
      toolAgrees === true && planned !== undefined && modelFirstCall !== null
        ? Object.entries(planned.args).every(([name, value]) =>
            sameValue(value, modelFirstCall.args[name]),
          )
        : null,
  };
}
