import {
  SEARCH_MATCHED_ON_PRIORITY,
  type SearchEntityType,
  type SearchMatchedOn,
} from "./constants.js";

export type SearchHitPreference = {
  readonly exact: boolean;
  readonly matchedOn: SearchMatchedOn;
};

/**
 * Keep `exact` over non-exact, then `matchedOn` priority
 * `number > phone > email > edrpou > name > customer > customerNameSnapshot`.
 * Ties keep the earlier row.
 */
export function pickPreferredSearchHit<T extends SearchHitPreference>(
  current: T,
  candidate: T,
): T {
  if (candidate.exact !== current.exact) {
    return candidate.exact ? candidate : current;
  }
  if (
    SEARCH_MATCHED_ON_PRIORITY[candidate.matchedOn] <
    SEARCH_MATCHED_ON_PRIORITY[current.matchedOn]
  ) {
    return candidate;
  }
  return current;
}

export type TypedSearchHit = SearchHitPreference & {
  readonly type: SearchEntityType;
  readonly id: string;
};

/** One row per `(type, id)`. */
export function dedupSearchHits<T extends TypedSearchHit>(
  hits: readonly T[],
): T[] {
  const best = new Map<string, T>();
  for (const hit of hits) {
    const key = `${hit.type}:${hit.id}`;
    const current = best.get(key);
    if (current === undefined) {
      best.set(key, hit);
      continue;
    }
    best.set(key, pickPreferredSearchHit(current, hit));
  }
  return [...best.values()];
}
