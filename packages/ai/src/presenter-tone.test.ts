import { describe, expect, it } from "vitest";

import {
  CHOICE_TRUNCATED_COPY,
  CHOICE_TRUNCATED_MATCH_COPY,
  STAFF_ASSISTANT_CATALOG_DOMAIN_ERROR_COPY,
  STAFF_ASSISTANT_CHOICE_INTRO_COPY,
  STAFF_ASSISTANT_ORDER_STATUS_LABELS,
  STAFF_ASSISTANT_PRESENTER_COPY,
} from "./presenter.js";
import {
  STAFF_ASSISTANT_EMPTY_SPOKEN_FALLBACK,
  STAFF_ASSISTANT_SUCCESS_SPOKEN_FALLBACK,
  STAFF_ASSISTANT_TOOL_ERROR_FALLBACK,
} from "./spoken-reply.js";

/** Formal 2pl Ukrainian imperative endings («Напишіть», «Оберіть»). */
const FORMAL_IMPERATIVE_ENDING = /(іть|йте)\b/;

/**
 * Words that legitimately end with іть/йте but are not Ви-form
 * imperatives. Empty until a real exception appears in the tables.
 */
const FORMAL_IMPERATIVE_EXCEPTIONS: readonly string[] = [];

function stringLeaves(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(stringLeaves);
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(stringLeaves);
  }
  return [];
}

describe("staff assistant uk presenter/HITL copy tone", () => {
  it("has no formal Ви-form imperative endings", () => {
    const ukLeaves = [
      ...stringLeaves(STAFF_ASSISTANT_PRESENTER_COPY.uk),
      ...stringLeaves(STAFF_ASSISTANT_ORDER_STATUS_LABELS.uk),
      CHOICE_TRUNCATED_COPY.uk,
      CHOICE_TRUNCATED_MATCH_COPY.uk,
      ...stringLeaves(STAFF_ASSISTANT_CATALOG_DOMAIN_ERROR_COPY.uk),
      ...stringLeaves(STAFF_ASSISTANT_CHOICE_INTRO_COPY.uk),
      STAFF_ASSISTANT_SUCCESS_SPOKEN_FALLBACK.uk,
      STAFF_ASSISTANT_TOOL_ERROR_FALLBACK.uk,
      STAFF_ASSISTANT_EMPTY_SPOKEN_FALLBACK.uk,
    ];
    expect(ukLeaves.length).toBeGreaterThan(0);
    const unexpected = ukLeaves.filter((text) => {
      if (FORMAL_IMPERATIVE_EXCEPTIONS.includes(text)) {
        return false;
      }
      return FORMAL_IMPERATIVE_ENDING.test(text);
    });
    expect(unexpected).toEqual([]);
  });
});
