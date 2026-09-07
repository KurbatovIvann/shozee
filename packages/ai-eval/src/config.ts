import { StaffAssistantNotConfiguredError } from "@showzy/ai";
import type { ServerConfig } from "@showzy/config";

/** Default N for live and reported pass-rate. 2/3 is a flake, not green. */
export const DEFAULT_EVAL_RUNS = 3;

const RUNS_MIN = 1;
const RUNS_MAX = 20;

export class EvalRunsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalRunsConfigError";
  }
}

/**
 * Parse `--runs` / `--runs=N` from argv. Does not read `process.env`.
 * Invalid values fail typed rather than silently falling back.
 */
export function parseEvalRuns(
  argv: readonly string[],
  fallback: number = DEFAULT_EVAL_RUNS,
): number {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--runs") {
      return parseRunsValue(argv[index + 1]);
    }
    if (arg !== undefined && arg.startsWith("--runs=")) {
      return parseRunsValue(arg.slice("--runs=".length));
    }
  }
  return fallback;
}

function parseRunsValue(raw: string | undefined): number {
  if (raw === undefined || raw === "") {
    throw new EvalRunsConfigError("Expected a positive integer after --runs.");
  }
  const parsed = Number.parseInt(raw, 10);
  if (
    !Number.isInteger(parsed) ||
    parsed < RUNS_MIN ||
    parsed > RUNS_MAX ||
    String(parsed) !== raw
  ) {
    throw new EvalRunsConfigError(
      `Eval --runs must be an integer from ${String(RUNS_MIN)} to ${String(RUNS_MAX)}.`,
    );
  }
  return parsed;
}

/**
 * Live-entry helper: the eval CLI injects `--runs` as a string because
 * Vitest workers do not see the original argv. Still parsed as argv —
 * this function does not read `process.env`.
 */
export function evalRunsFromInjectedFlag(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_EVAL_RUNS;
  }
  return parseEvalRuns(["--runs", raw]);
}

/**
 * Fail closed when Anthropic is unset. Uses the same typed error as the
 * HTTP mount. The key never appears in the error message or stack.
 */
export function requireStaffAssistantApiKey(ai: ServerConfig["ai"]): string {
  const key = ai.anthropicApiKey;
  if (key === undefined || key === "") {
    throw new StaffAssistantNotConfiguredError();
  }
  return key;
}
