/**
 * JSON.stringify character length. 0 when the value cannot be serialized.
 */
export function staffAssistantJsonChars(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

/**
 * PostgreSQL `jsonb::text` inserts a space after every structural `:` and
 * `,`. Compact `JSON.stringify` is shorter, so a stringify-budgeted
 * payload can fail CHECK `length(model_trace::text) <= 22000`.
 *
 * Count extra spaces outside JSON strings. Infinity when the value cannot
 * be serialized (callers treat that as over budget).
 */
export function staffAssistantPostgresJsonbTextChars(value: unknown): number {
  let compact: string;
  try {
    compact = JSON.stringify(value);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  if (typeof compact !== "string") {
    return Number.POSITIVE_INFINITY;
  }
  return compact.length + countStructuralJsonSeparators(compact);
}

function countStructuralJsonSeparators(json: string): number {
  let extra = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < json.length; index += 1) {
    const character = json[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === ":" || character === ",") {
      extra += 1;
    }
  }
  return extra;
}
