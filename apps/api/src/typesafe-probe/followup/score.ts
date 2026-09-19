import type {
  JudgmentShadowArgValue,
  JudgmentShadowCall,
} from "@showzy/validation/assistant-judgment";
import { isInflectionOfName } from "@showzy/validation/entity-ref";

import type { ExpectedCall, FollowupCase } from "./corpus.js";

export interface CallScore {
  readonly toolCorrect: boolean;
  readonly correct: boolean;
  readonly detour: boolean;
}

export const foldText = (value: string): string =>
  value
    .normalize("NFC")
    .replaceAll(/["«»“”„]/g, "")
    .trim()
    .replaceAll(/\s+/g, " ")
    .toLowerCase();

const digits = (value: string): string => value.replaceAll(/\D/g, "");

function sameText(expected: string, observed: string): boolean {
  return (
    foldText(expected) === foldText(observed) ||
    isInflectionOfName(expected, observed) ||
    isInflectionOfName(observed, expected)
  );
}

function sameLine(expected: string, observed: string): boolean {
  const [expectedQuantity, expectedProduct] = expected.split("×");
  const [observedQuantity, observedProduct] = observed.split("×");
  return expectedProduct === undefined || observedProduct === undefined
    ? sameText(expected, observed)
    : Number(expectedQuantity) === Number(observedQuantity) &&
        sameText(expectedProduct, observedProduct);
}

function sameArg(
  name: string,
  expected: string | readonly string[],
  observed: JudgmentShadowArgValue | undefined,
): boolean {
  if (typeof expected !== "string") {
    return (
      Array.isArray(observed) &&
      observed.length === expected.length &&
      expected.every((line) => observed.some((other) => sameLine(line, other)))
    );
  }
  if (typeof observed === "number") {
    return String(observed) === expected;
  }
  if (typeof observed !== "string") {
    return false;
  }
  return name === "phone"
    ? digits(observed).endsWith(digits(expected).slice(-9))
    : sameText(expected, observed);
}

const isStated = (value: JudgmentShadowArgValue): boolean =>
  value !== null &&
  value !== "" &&
  !(Array.isArray(value) && value.length === 0);

function matches(
  expected: ExpectedCall,
  observed: JudgmentShadowCall,
): boolean {
  return (
    expected.tool === observed.tool &&
    Object.entries(expected.args).every(([name, value]) =>
      sameArg(name, value, observed.args[name]),
    ) &&
    Object.entries(observed.args).every(
      ([name, value]) => name in expected.args || !isStated(value),
    )
  );
}

export function scoreCall(
  probeCase: Pick<FollowupCase, "expected" | "alsoOk">,
  observed: JudgmentShadowCall | null,
  readTools: ReadonlySet<string> = new Set(),
): CallScore {
  if (probeCase.expected === null || observed === null) {
    const correct = probeCase.expected === null && observed === null;
    return { toolCorrect: correct, correct, detour: false };
  }
  const accepted = [probeCase.expected, ...(probeCase.alsoOk ?? [])];
  const correct = accepted.some((call) => matches(call, observed));
  return {
    toolCorrect: accepted.some((call) => call.tool === observed.tool),
    correct,
    detour:
      !correct &&
      !readTools.has(probeCase.expected.tool) &&
      readTools.has(observed.tool),
  };
}
