import { isRecord } from "./record.js";
import type { EvalToolCall } from "./trace.js";

export interface EvalTurnTrace {
  readonly text: string;
  readonly toolCalls: readonly EvalToolCall[];
}

export interface EvalToolCallExpectation {
  readonly name: string;
  /** Deep-partial match against façade / provider args. */
  readonly args?: unknown;
  /** Nominative-ish `search` for «Катя Самбука», not the whole utterance. */
  readonly searchNominativeKatyaSambuka?: boolean;
  /**
   * `orders_list_page.customerIds` must be drawn from compact `items[].id`
   * of an earlier call with this tool name.
   */
  readonly customerIdsFromPrior?: string;
  /** Top-level string keys that must be present (e.g. `customerQuery`). */
  readonly requireKeys?: readonly string[];
  /** String keys that must appear on at least one `items[]` row. */
  readonly requireItemKeys?: readonly string[];
}

export interface EvalExpectation {
  /** Ordered subsequence (not exact equality — `tool_search` may precede). */
  readonly ordered?: readonly EvalToolCallExpectation[];
  readonly first?: string;
  readonly none?: boolean;
  readonly forbidden?: readonly string[];
  /** Values in final text (count, order number) — never phrasing. */
  readonly textIncludes?: readonly string[];
  /**
   * Require the final text to contain a value from the tool result
   * (order number, orderCount, customer name) — never presenter phrasing.
   */
  readonly textIncludesToolValues?: readonly (
    "orderNumber" | "orderCount" | "customerName"
  )[];
  readonly textExcludes?: readonly string[];
  readonly maxTextChars?: number;
}

export interface EvalMatchFailure {
  readonly ok: false;
  readonly reason: string;
}

export interface EvalMatchSuccess {
  readonly ok: true;
}

export type EvalMatchResult = EvalMatchSuccess | EvalMatchFailure;

function fail(reason: string): EvalMatchFailure {
  return { ok: false, reason };
}

function matchesPartial(expected: unknown, actual: unknown): boolean {
  if (expected === undefined) {
    return true;
  }
  if (typeof expected !== "object" || expected === null) {
    return Object.is(expected, actual);
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      return false;
    }
    return expected.every((item, index) => matchesPartial(item, actual[index]));
  }
  if (!isRecord(actual)) {
    return false;
  }
  return Object.entries(expected).every(([key, value]) =>
    matchesPartial(value, actual[key]),
  );
}

/**
 * Nominative-ish search for the Katya Sambuka proof fixture. Rejects the
 * whole utterance and genitive «Каті Самбуки».
 */
export function isNominativeKatyaSambukaSearch(search: unknown): boolean {
  if (typeof search !== "string") {
    return false;
  }
  const normalized = search.toLocaleLowerCase("uk-UA");
  if (normalized.includes("замовлення")) {
    return false;
  }
  if (normalized.includes("каті")) {
    return false;
  }
  if (normalized.includes("самбуки")) {
    return false;
  }
  return normalized.includes("катя") && normalized.includes("самбук");
}

function idsFromCustomersListResult(result: unknown): string[] {
  if (!isRecord(result) || !Array.isArray(result["items"])) {
    return [];
  }
  const ids: string[] = [];
  for (const row of result["items"]) {
    if (isRecord(row) && typeof row["id"] === "string") {
      ids.push(row["id"]);
    }
  }
  return ids;
}

function customerIdsFromArgs(args: unknown): string[] {
  if (!isRecord(args) || !Array.isArray(args["customerIds"])) {
    return [];
  }
  return args["customerIds"].filter(
    (id): id is string => typeof id === "string",
  );
}

function hasRequiredKeys(args: unknown, keys: readonly string[]): boolean {
  if (!isRecord(args)) {
    return false;
  }
  return keys.every((key) => {
    const value = args[key];
    return typeof value === "string" && value.trim() !== "";
  });
}

function hasRequiredItemKeys(args: unknown, keys: readonly string[]): boolean {
  if (!isRecord(args) || !Array.isArray(args["items"])) {
    return false;
  }
  return args["items"].some(
    (item) =>
      isRecord(item) &&
      keys.every((key) => {
        const value = item[key];
        return typeof value === "string" && value.trim() !== "";
      }),
  );
}

function toolCallMatches(
  expected: EvalToolCallExpectation,
  call: EvalToolCall,
  prior: readonly EvalToolCall[],
): boolean {
  if (call.name !== expected.name) {
    return false;
  }
  if (
    expected.args !== undefined &&
    !matchesPartial(expected.args, call.args)
  ) {
    return false;
  }
  if (
    expected.searchNominativeKatyaSambuka === true &&
    (!isRecord(call.args) ||
      !isNominativeKatyaSambukaSearch(call.args["search"]))
  ) {
    return false;
  }
  if (expected.requireKeys !== undefined) {
    if (!hasRequiredKeys(call.args, expected.requireKeys)) {
      return false;
    }
  }
  if (expected.requireItemKeys !== undefined) {
    if (!hasRequiredItemKeys(call.args, expected.requireItemKeys)) {
      return false;
    }
  }
  if (expected.customerIdsFromPrior !== undefined) {
    const priorCall = [...prior]
      .reverse()
      .find((entry) => entry.name === expected.customerIdsFromPrior);
    if (priorCall === undefined) {
      return false;
    }
    const priorIds = idsFromCustomersListResult(priorCall.result);
    const actualIds = customerIdsFromArgs(call.args);
    if (priorIds.length === 0 || actualIds.length === 0) {
      return false;
    }
    if (!actualIds.every((id) => priorIds.includes(id))) {
      return false;
    }
  }
  return true;
}

function collectStringField(rows: readonly unknown[], key: string): string[] {
  const values: string[] = [];
  for (const row of rows) {
    if (!isRecord(row)) {
      continue;
    }
    const value = row[key];
    if (typeof value === "string" && value.trim() !== "") {
      values.push(value);
    } else if (typeof value === "number" && Number.isFinite(value)) {
      values.push(String(value));
    }
  }
  return values;
}

function arrayField(result: unknown, key: string): unknown[] {
  if (!isRecord(result) || !Array.isArray(result[key])) {
    return [];
  }
  return result[key];
}

function toolValuesOfKind(
  kind: "orderNumber" | "orderCount" | "customerName",
  calls: readonly EvalToolCall[],
): string[] {
  const values: string[] = [];
  for (const call of calls) {
    const result = call.result;
    if (kind === "orderNumber") {
      values.push(
        ...collectStringField(arrayField(result, "rows"), "orderNumber"),
      );
      values.push(
        ...collectStringField(arrayField(result, "items"), "orderNumber"),
      );
      if (isRecord(result) && typeof result["orderNumber"] === "string") {
        const number = result["orderNumber"].trim();
        if (number !== "") {
          values.push(number);
        }
      }
    } else if (kind === "orderCount") {
      if (isRecord(result)) {
        const count = result["orderCount"];
        if (typeof count === "number" && Number.isFinite(count)) {
          values.push(String(count));
        } else if (typeof count === "string" && count.trim() !== "") {
          values.push(count.trim());
        }
      }
    } else {
      values.push(...collectStringField(arrayField(result, "items"), "name"));
      values.push(...collectStringField(arrayField(result, "rows"), "name"));
    }
  }
  return values;
}

function matchTextIncludesToolValues(
  kinds: readonly ("orderNumber" | "orderCount" | "customerName")[],
  trace: EvalTurnTrace,
): EvalMatchResult {
  for (const kind of kinds) {
    const values = toolValuesOfKind(kind, trace.toolCalls);
    if (values.length === 0) {
      return fail(`no ${kind} in tool results`);
    }
    if (!values.some((value) => trace.text.includes(value))) {
      return fail(`final text missing tool value ${kind}`);
    }
  }
  return { ok: true };
}

function matchOrdered(
  expected: readonly EvalToolCallExpectation[],
  actual: readonly EvalToolCall[],
): EvalMatchResult {
  let actualIndex = 0;
  for (const step of expected) {
    let found = -1;
    for (let index = actualIndex; index < actual.length; index += 1) {
      const call = actual[index];
      if (call === undefined) {
        continue;
      }
      if (toolCallMatches(step, call, actual.slice(0, index))) {
        found = index;
        break;
      }
    }
    if (found === -1) {
      return fail(`missing ordered tool ${step.name}`);
    }
    actualIndex = found + 1;
  }
  return { ok: true };
}

export function matchEvalExpectation(
  expectation: EvalExpectation,
  trace: EvalTurnTrace,
): EvalMatchResult {
  const calls = trace.toolCalls;
  if (expectation.none === true && calls.length > 0) {
    return fail(
      `expected no tool calls, got ${calls.map((call) => call.name).join(", ")}`,
    );
  }
  if (expectation.first !== undefined) {
    const first = calls[0];
    if (first === undefined || first.name !== expectation.first) {
      return fail(
        `expected first tool ${expectation.first}, got ${first?.name ?? "none"}`,
      );
    }
  }
  if (expectation.forbidden !== undefined) {
    for (const name of expectation.forbidden) {
      if (calls.some((call) => call.name === name)) {
        return fail(`forbidden tool ${name}`);
      }
    }
  }
  if (expectation.ordered !== undefined) {
    const ordered = matchOrdered(expectation.ordered, calls);
    if (!ordered.ok) {
      return ordered;
    }
  }
  if (expectation.textIncludes !== undefined) {
    for (const snippet of expectation.textIncludes) {
      if (!trace.text.includes(snippet)) {
        return fail(`final text missing value ${snippet}`);
      }
    }
  }
  if (expectation.textIncludesToolValues !== undefined) {
    const toolValues = matchTextIncludesToolValues(
      expectation.textIncludesToolValues,
      trace,
    );
    if (!toolValues.ok) {
      return toolValues;
    }
  }
  if (expectation.textExcludes !== undefined) {
    for (const snippet of expectation.textExcludes) {
      if (trace.text.includes(snippet)) {
        return fail(`final text contains excluded value ${snippet}`);
      }
    }
  }
  if (
    expectation.maxTextChars !== undefined &&
    trace.text.length > expectation.maxTextChars
  ) {
    return fail(
      `final text length ${String(trace.text.length)} exceeds ${String(expectation.maxTextChars)}`,
    );
  }
  return { ok: true };
}
