import {
  GLOBAL_HIT_CAP,
  SEARCH_ENTITY_TYPES,
  SEARCH_LABEL_MAX,
  SEARCH_LIMIT_PER_TYPE_MAX,
  SEARCH_QUERY_MAX,
  SEARCH_STATUS_MAX,
  SEARCH_SUBLABEL_MAX,
  searchQueryOutputSchema,
  type SearchGroup,
} from "@showzy/validation/search";
import { describe, expect, it } from "vitest";

import {
  clipStaffAssistantToolResult,
  STAFF_ASSISTANT_CLIPPED_STATUS,
  STAFF_ASSISTANT_CLIP_JSON_MAX,
} from "./clip-tool-result.js";
import { staffAssistantPostgresJsonbTextChars } from "./json-chars.js";

const PRODUCT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function uuidAt(typeIndex: number, hitIndex: number): string {
  return `bbbbbbbb-bbbb-4bbb-8bbb-${(typeIndex * 100 + hitIndex)
    .toString(16)
    .padStart(12, "0")}`;
}

function worstCaseHit(
  type: SearchGroup["type"],
  typeIndex: number,
  hitIndex: number,
) {
  const base = {
    id: uuidAt(typeIndex, hitIndex),
    label: "L".repeat(SEARCH_LABEL_MAX),
    sublabel: "S".repeat(SEARCH_SUBLABEL_MAX),
    status: "T".repeat(SEARCH_STATUS_MAX),
    matchedOn: "customerNameSnapshot" as const,
    exact: false,
  };
  if (type === "variant") {
    return { ...base, productId: PRODUCT_ID };
  }
  return base;
}

/**
 * Max `queryNormalized` plus max label/sublabel/status under
 * GLOBAL_HIT_CAP 40 / limitPerType 10. Four types × 10 hits fills the
 * global cap with the largest per-type pages.
 */
function worstCaseSearchQueryOutput() {
  const types = [
    "customerGroup",
    "counterparty",
    "variant",
    "priceList",
  ] as const satisfies readonly SearchGroup["type"][];
  const groups = types.map((type, typeIndex) => ({
    type,
    truncated: true,
    hits: Array.from({ length: SEARCH_LIMIT_PER_TYPE_MAX }, (_, hitIndex) =>
      worstCaseHit(type, typeIndex, hitIndex),
    ),
  }));
  return searchQueryOutputSchema.parse({
    groups,
    searchedTypes: [...SEARCH_ENTITY_TYPES],
    queryNormalized: "q".repeat(SEARCH_QUERY_MAX),
  });
}

describe("search.query clip budget (SHO-535)", () => {
  it("measures worst-case T8 output with jsonb text chars and does not clip", () => {
    const output = worstCaseSearchQueryOutput();
    const hitCount = output.groups.reduce(
      (sum, group) => sum + group.hits.length,
      0,
    );
    expect(output.queryNormalized).toHaveLength(SEARCH_QUERY_MAX);
    expect(hitCount).toBe(GLOBAL_HIT_CAP);
    expect(output.groups[0]?.hits[0]?.label).toHaveLength(SEARCH_LABEL_MAX);
    expect(output.groups[0]?.hits[0]?.sublabel).toHaveLength(
      SEARCH_SUBLABEL_MAX,
    );

    const chars = staffAssistantPostgresJsonbTextChars(output);
    expect(Number.isFinite(chars)).toBe(true);
    expect(chars).toBeLessThanOrEqual(STAFF_ASSISTANT_CLIP_JSON_MAX);

    const clipped = clipStaffAssistantToolResult(output);
    expect(clipped).toBe(output);
    expect(
      typeof clipped === "object" &&
        clipped !== null &&
        "status" in clipped &&
        clipped.status === STAFF_ASSISTANT_CLIPPED_STATUS,
    ).toBe(false);
  });
});
