import { createProcessLogger, REDACTED, redactUnknown } from "@showzy/config";

import { isRecord } from "./record.js";

/**
 * Extra keys the eval runner must never echo, on top of
 * `redactUnknown` (API keys, tokens, PII). System prompt and raw
 * request bodies are not in the shared denylist.
 */
const EVAL_DENY_KEYS = new Set([
  "system",
  "systemprompt",
  "prompt",
  "body",
  "requestbody",
  "rawbody",
  "messages",
  "apikey",
  "anthropicapikey",
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replaceAll(/[-_[\]]/g, "");
}

function stripEvalDeny(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return REDACTED;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => stripEvalDeny(entry, seen));
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = EVAL_DENY_KEYS.has(normalizeKey(key))
      ? REDACTED
      : stripEvalDeny(entry, seen);
  }
  return output;
}

/**
 * Redact secrets then strip eval-specific keys (system prompt, request
 * bodies, messages). Safe to pass to the process logger.
 */
export function scrubEvalLogValue(value: unknown): unknown {
  return stripEvalDeny(redactUnknown(value), new WeakSet<object>());
}

export type EvalLogger = ReturnType<typeof createProcessLogger>;

export function createEvalLogger(destination?: {
  write(chunk: string): void;
}): EvalLogger {
  return createProcessLogger({
    name: "ai-eval",
    ...(destination !== undefined ? { destination } : {}),
  });
}

export function logEvalInfo(
  logger: EvalLogger,
  fields: Record<string, unknown>,
  message: string,
): void {
  const scrubbed = scrubEvalLogValue(fields);
  if (isRecord(scrubbed)) {
    logger.info(scrubbed, message);
    return;
  }
  logger.info({}, message);
}
