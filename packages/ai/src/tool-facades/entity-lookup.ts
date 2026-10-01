import { CoreError } from "@showzy/core/errors";
import { ASSISTANT_CHOICE_OPTIONS_MAX } from "@showzy/validation/assistant-chat";
import {
  ENTITY_REF_EXACTLY_ONE_MESSAGE,
  entityRefQuerySchema,
} from "@showzy/validation/entity-ref";
import { z } from "zod";

import {
  CHOICE_CREATE_OPTION_ID,
  EntityLookupConflictError,
  choiceCardOptionSchema,
  type EntityLookupTarget,
} from "../choice.js";

export const entityLookupQuerySchema = entityRefQuerySchema;

export const EXACTLY_ONE_REFERENCE_MESSAGE = ENTITY_REF_EXACTLY_ONE_MESSAGE;

export const ENTITY_LOOKUP_RECORD_OPTIONS_MAX =
  ASSISTANT_CHOICE_OPTIONS_MAX - 1;

const unmatchedRefusalSchema = z.strictObject({
  reason: z.literal("unmatched_query"),
  options: z.array(choiceCardOptionSchema),
  optionsTruncated: z.boolean(),
});

export function nearestChoiceFromError(
  error: unknown,
  target: EntityLookupTarget,
): EntityLookupConflictError | undefined {
  if (!(error instanceof CoreError) || error.code !== "NOT_FOUND") {
    return undefined;
  }
  const parsed = unmatchedRefusalSchema.safeParse({
    reason: Reflect.get(error, "reason") as unknown,
    options: Reflect.get(error, "options") as unknown,
    optionsTruncated: Reflect.get(error, "optionsTruncated") as unknown,
  });
  if (!parsed.success) {
    return undefined;
  }
  const nearest = parsed.data.options.slice(
    0,
    ENTITY_LOOKUP_RECORD_OPTIONS_MAX,
  );
  return new EntityLookupConflictError({
    reason: "unmatched_query",
    target,
    options: nearest,
    optionsTruncated:
      parsed.data.optionsTruncated ||
      nearest.length < parsed.data.options.length,
    create: { optionId: CHOICE_CREATE_OPTION_ID },
    clientMessage: error.clientMessage,
  });
}
