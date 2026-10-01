import { CoreError } from "@showzy/core/errors";
import { ENTITY_REF_QUERY_MAX } from "@showzy/validation/entity-ref";
import { z } from "zod";

import {
  CHOICE_CREATE_OPTION_ID,
  EntityLookupConflictError,
  type EntityLookupTarget,
} from "../choice.js";

export const ENTITY_LOOKUP_QUERY_MAX = ENTITY_REF_QUERY_MAX;

export const entityLookupQuerySchema = z
  .string()
  .trim()
  .min(1)
  .max(ENTITY_LOOKUP_QUERY_MAX);

export const EXACTLY_ONE_REFERENCE_MESSAGE =
  "Provide exactly one of the id or the query.";

export function isNotFound(error: unknown): boolean {
  return error instanceof CoreError && error.code === "NOT_FOUND";
}

export function createOptionLabel(query: string): string {
  return `Create "${query}"`;
}

export function nothingMatchedConflict(
  target: EntityLookupTarget,
): EntityLookupConflictError {
  return new EntityLookupConflictError({
    reason: "unmatched_query",
    target,
    options: [],
    optionsTruncated: false,
    create: {
      optionId: CHOICE_CREATE_OPTION_ID,
      label: createOptionLabel(target.query),
    },
    clientMessage: `Nothing matches "${target.query}".`,
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
