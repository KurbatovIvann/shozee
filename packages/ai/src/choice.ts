/**
 * Turning a catalog picker conflict into something a person can answer.
 *
 * All that is left of what this file was. It held the whole choice protocol —
 * card envelopes, record states, bind tokens, resolution reasons, resume
 * payloads — because the previous runtime carried a picker's state through the
 * database and back. The protocol now lives in `@showzy/assistant-kit`, and what
 * a question looks like on the wire lives in `@showzy/validation/assistant-chat`.
 *
 * What remains is domain knowledge that belongs to neither: how the catalog
 * reports an ambiguity, and which of its refusals are a choice rather than a
 * dead end. `archived` and `no_active_variants` are terminals — there is nothing
 * to pick between, so they are explained rather than offered.
 */
import { ConflictError, CoreError } from "@showzy/core/errors";
import { z } from "zod";

/** Reasons that open a picker. `archived` / `no_active_variants` never do. */
export const CHOICE_PICKER_REASONS = [
  "variant_required",
  "ambiguous",
  "unmatched_query",
] as const;

export type ChoicePickerReason = (typeof CHOICE_PICKER_REASONS)[number];

export const choiceCardOptionSchema = z.strictObject({
  id: z.uuid(),
  label: z.string().min(1),
});

export type ChoiceCardOption = z.output<typeof choiceCardOptionSchema>;

/**
 * Where the chosen id belongs once the ambiguity is settled. Mirrors what the
 * domain reports, which is why the variant case carries a product rather than a
 * query: by then the product is already resolved.
 */
const catalogConflictTargetSchema = z.union([
  z.strictObject({
    kind: z.literal("customer"),
    query: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("order_line_product"),
    lineIndex: z.number().int().nonnegative(),
    query: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("order_line_variant").optional(),
    lineIndex: z.number().int().nonnegative(),
    productId: z.uuid(),
    productName: z.string().min(1),
  }),
]);

/**
 * Duck-typed picker extras on a `CONFLICT`. The wire code stays `CONFLICT`:
 * this is a domain refusal that happens to be answerable, not a new error class.
 */
export const CHOICE_CREATE_OPTION_ID = "create";

export const choiceCreateOptionSchema = z.strictObject({
  optionId: z.string().min(1).max(128),
});

export type ChoiceCreateOption = z.output<typeof choiceCreateOptionSchema>;

export const CHOICE_PICKER_NEEDS_AN_ANSWERABLE_OPTION =
  "a picker needs a record option or a create option";

export const catalogPickerConflictExtrasSchema = z
  .strictObject({
    reason: z.enum(CHOICE_PICKER_REASONS),
    target: catalogConflictTargetSchema,
    options: z.array(choiceCardOptionSchema),
    optionsTruncated: z.boolean(),
    create: choiceCreateOptionSchema.optional(),
  })
  .refine(
    (extras) => extras.options.length > 0 || extras.create !== undefined,
    { message: CHOICE_PICKER_NEEDS_AN_ANSWERABLE_OPTION },
  );

export type CatalogPickerConflictExtras = z.output<
  typeof catalogPickerConflictExtrasSchema
>;

/**
 * `undefined` for every conflict that is not a picker — a terminal, or any
 * other `CONFLICT` the domain raises. The caller then reports it as an error
 * the model explains, which is the correct outcome for a refusal nobody can
 * answer.
 */
export function catalogPickerConflictExtrasFromError(
  error: unknown,
): CatalogPickerConflictExtras | undefined {
  if (!(error instanceof CoreError) || error.code !== "CONFLICT") {
    return undefined;
  }
  const create: unknown = Reflect.get(error, "create");
  const parsed = catalogPickerConflictExtrasSchema.safeParse({
    reason: Reflect.get(error, "reason") as unknown,
    target: Reflect.get(error, "target") as unknown,
    options: Reflect.get(error, "options") as unknown,
    optionsTruncated: Reflect.get(error, "optionsTruncated") as unknown,
    ...(create === undefined ? {} : { create }),
  });
  return parsed.success ? parsed.data : undefined;
}

export type EntityLookupTarget = {
  readonly kind: "customer";
  readonly query: string;
};

export class EntityLookupConflictError extends ConflictError {
  readonly reason: ChoicePickerReason;
  readonly target: EntityLookupTarget;
  readonly options: readonly ChoiceCardOption[];
  readonly optionsTruncated: boolean;
  readonly create?: ChoiceCreateOption;

  constructor(args: {
    readonly reason: ChoicePickerReason;
    readonly target: EntityLookupTarget;
    readonly options: readonly ChoiceCardOption[];
    readonly optionsTruncated: boolean;
    readonly create?: ChoiceCreateOption;
    readonly clientMessage: string;
  }) {
    super(args.clientMessage);
    this.reason = args.reason;
    this.target = args.target;
    this.options = args.options;
    this.optionsTruncated = args.optionsTruncated;
    if (args.create !== undefined) {
      this.create = args.create;
    }
  }
}
