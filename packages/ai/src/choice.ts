/**
 * Staff-assistant choice transport (SHO-409 / SHO-418 / SHO-410 / SHO-401 T8).
 *
 * Canonical create input, server-only target (variant line, product line, or
 * customer), and optionId → entity id mapping stay on the server. The client
 * sends `{ choiceId, optionId }` and may read only the ChoiceCard envelope.
 * Intercepts a duck-typed CONFLICT (picker reasons only) on `orders.create`
 * and opens a store record. This package must not import catalog, customers,
 * or a module barrel (`@showzy/orders/contract` is the allowed path).
 *
 * TTL is 15 minutes — deliberately longer than core `CONFIRMATION_TTL_MS`
 * (5 minutes). "Are you sure" and "which one" tolerate interruption
 * differently; keep the asymmetry.
 */
import { createHash, randomUUID } from "node:crypto";

import { CoreError } from "@showzy/core/errors";
import { createOrderInputSchema } from "@showzy/orders/contract";
import { z } from "zod";

export const STAFF_ASSISTANT_NEEDS_CHOICE_STATUS = "needs_choice" as const;

/**
 * 15 minutes. Core confirmation is 5 minutes (`CONFIRMATION_TTL_MS`).
 * Do not import core to keep this package independent of that constant.
 */
export const CHOICE_TTL_MS = 15 * 60 * 1000;

/**
 * Variant / product / customer picker cap. Not `REFERENCE_CONFLICT_LABELS_MAX`
 * (5), which would clip a normal 6-flavour product. Matches catalog
 * `VARIANT_SELECTION_OPTIONS_MAX`.
 */
export const CHOICE_OPTIONS_MAX = 20;

export const CHOICE_REDIS_KEY_PREFIX = "choice:" as const;

export function choiceRedisKey(choiceId: string): string {
  return `${CHOICE_REDIS_KEY_PREFIX}${choiceId}`;
}

export const CHOICE_RESOLUTION_REASONS = [
  "variant_required",
  "ambiguous",
  "unmatched_query",
  "no_active_variants",
  "archived",
] as const;

/** Reasons that open a picker. `archived` / `no_active_variants` never do. */
export const CHOICE_PICKER_REASONS = [
  "variant_required",
  "ambiguous",
  "unmatched_query",
] as const;

/**
 * Non-picker catalog terminals. Presenter owns the turn; never a ChoiceCard.
 */
export const CHOICE_DOMAIN_ERROR_REASONS = [
  "archived",
  "no_active_variants",
] as const;

export type ChoicePickerReason = (typeof CHOICE_PICKER_REASONS)[number];

export type ChoiceResolutionReason = (typeof CHOICE_RESOLUTION_REASONS)[number];

export type ChoiceDomainErrorReason =
  (typeof CHOICE_DOMAIN_ERROR_REASONS)[number];

export const CHOICE_KINDS = ["variant", "product", "customer"] as const;

export type ChoiceKind = (typeof CHOICE_KINDS)[number];

export const choiceKindSchema = z.enum(CHOICE_KINDS);

export const choiceResolutionReasonSchema = z.enum(CHOICE_RESOLUTION_REASONS);

/**
 * Server-side `orders.create` input stored with the draft. Same schema
 * instance as `createOrderInputSchema` so a new field cannot silently
 * break `parseChoiceRecord` (SHO-422).
 */
export const choiceCanonicalCreateInputSchema = createOrderInputSchema;

export type ChoiceCanonicalCreateInput = z.output<
  typeof choiceCanonicalCreateInputSchema
>;

export const choiceTargetSchema = z.union([
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

export type ChoiceTarget = z.output<typeof choiceTargetSchema>;

export function choiceKindFromTarget(target: ChoiceTarget): ChoiceKind {
  if (target.kind === "customer") {
    return "customer";
  }
  if (target.kind === "order_line_product") {
    return "product";
  }
  return "variant";
}

export function choiceSubjectName(target: ChoiceTarget): string {
  if (target.kind === "customer" || target.kind === "order_line_product") {
    return target.query;
  }
  return target.productName;
}

export const choiceCardOptionSchema = z.strictObject({
  id: z.uuid(),
  label: z.string().min(1),
});

export type ChoiceCardOption = z.output<typeof choiceCardOptionSchema>;

export const choiceCardStateSchema = z.enum([
  "needs_choice",
  "claimed",
  "completed",
  "expired",
]);

export type ChoiceCardState = z.output<typeof choiceCardStateSchema>;

/**
 * Client ChoiceCard envelope. Never includes canonical input, target,
 * option mapping, actor, or company. Empty options never parse — no
 * empty picker (SHO-420). Expired HTTP peek is `{ status: "expired" }`
 * and does not go through this schema. `claimedOptionId` is the opaque
 * option already claimed (SHO-426); it is never a variant id.
 */
export const staffAssistantChoiceCardEnvelopeSchema = z.strictObject({
  status: choiceCardStateSchema,
  challengeId: z.uuid(),
  reason: choiceResolutionReasonSchema.optional(),
  choiceKind: choiceKindSchema.optional(),
  productName: z.string().min(1).optional(),
  options: z.array(choiceCardOptionSchema).min(1).max(CHOICE_OPTIONS_MAX),
  optionsTruncated: z.boolean(),
  claimedOptionId: z.uuid().optional(),
});

export type StaffAssistantChoiceCardEnvelope = z.output<
  typeof staffAssistantChoiceCardEnvelopeSchema
>;

export const staffAssistantNeedsChoiceOutputSchema = z.strictObject({
  status: z.literal(STAFF_ASSISTANT_NEEDS_CHOICE_STATUS),
  challengeId: z.uuid(),
  reason: choiceResolutionReasonSchema,
  choiceKind: choiceKindSchema.optional(),
  productName: z.string().min(1),
  options: z.array(choiceCardOptionSchema).min(1).max(CHOICE_OPTIONS_MAX),
  optionsTruncated: z.boolean(),
});

export type StaffAssistantNeedsChoiceOutput = z.output<
  typeof staffAssistantNeedsChoiceOutputSchema
>;

/**
 * Sequential `POST /assistant/choice` result (SHO-427). Additive `text`
 * is presenter output for the same view-model — not catalog
 * `clientMessage`. First-turn tool output stays the schema above.
 */
export const staffAssistantNeedsChoiceInteractionSchema =
  staffAssistantNeedsChoiceOutputSchema.extend({
    text: z.string().min(1),
  });

export type StaffAssistantNeedsChoiceInteraction = z.output<
  typeof staffAssistantNeedsChoiceInteractionSchema
>;

export const choiceBindSchema = z.strictObject({
  actorId: z.string().min(1),
  companyId: z.uuid(),
  conversationId: z.uuid(),
});

export type ChoiceBind = z.output<typeof choiceBindSchema>;

export const choiceRecordStatusSchema = z.enum([
  "open",
  "claimed",
  "completed",
]);

export type ChoiceRecordStatus = z.output<typeof choiceRecordStatusSchema>;

const optionMapSchema = z.record(z.uuid(), z.uuid());

export const choiceRecordSchema = z.strictObject({
  status: choiceRecordStatusSchema,
  choiceId: z.uuid(),
  actorId: z.string().min(1),
  companyId: z.uuid(),
  conversationId: z.uuid(),
  canonicalInput: choiceCanonicalCreateInputSchema,
  target: choiceTargetSchema,
  optionMap: optionMapSchema,
  envelope: staffAssistantChoiceCardEnvelopeSchema,
  locale: z.enum(["uk", "en"]).optional(),
  claimedOptionId: z.uuid().optional(),
});

export type ChoiceRecord = z.output<typeof choiceRecordSchema>;

export const assistantChoiceBodySchema = z.strictObject({
  conversationId: z.uuid(),
  choiceId: z.uuid(),
  optionId: z.uuid(),
});

export type AssistantChoiceBody = z.output<typeof assistantChoiceBodySchema>;

export const assistantChoiceCompletedEntitySchema = z.strictObject({
  orderId: z.uuid(),
  orderNumber: z.string().min(1),
});

export const assistantChoiceInteractionResultSchema = z.discriminatedUnion(
  "status",
  [
    z.strictObject({
      status: z.literal("completed"),
      text: z.string().min(1),
      entity: assistantChoiceCompletedEntitySchema,
    }),
    staffAssistantNeedsChoiceInteractionSchema,
    z.strictObject({
      status: z.literal("expired"),
    }),
    z.strictObject({
      status: z.literal("error"),
      code: z.string().min(1),
      message: z.string().min(1),
    }),
  ],
);

export type AssistantChoiceInteractionResult = z.output<
  typeof assistantChoiceInteractionResultSchema
>;

export type CatalogChoiceOption = {
  readonly id: string;
  readonly label: string;
};

export type BoundChoiceOptions = {
  readonly options: readonly ChoiceCardOption[];
  readonly optionMap: Readonly<Record<string, string>>;
  readonly optionsTruncated: boolean;
};

/**
 * Mint opaque optionIds. Catalog picker ids are entity UUIDs — those stay
 * in `optionMap` and never go to the client as option ids.
 * Forward `optionsTruncated` from catalog extras even when the option
 * list is at or below `CHOICE_OPTIONS_MAX` — a prefix of 2 or 20 is not
 * the full set.
 */
export function bindChoiceOptions(
  catalogOptions: readonly CatalogChoiceOption[],
  optionsTruncated: boolean,
  randomId: () => string = randomUUID,
): BoundChoiceOptions {
  const capped = catalogOptions.slice(0, CHOICE_OPTIONS_MAX);
  const truncated =
    optionsTruncated || catalogOptions.length > CHOICE_OPTIONS_MAX;
  const optionMap: Record<string, string> = {};
  const options: ChoiceCardOption[] = [];
  for (const option of capped) {
    const optionId = randomId();
    optionMap[optionId] = option.id;
    options.push({ id: optionId, label: option.label });
  }
  return { options, optionMap, optionsTruncated: truncated };
}

export function choiceCardEnvelope(input: {
  readonly challengeId: string;
  readonly status: ChoiceCardState;
  readonly reason?: ChoiceResolutionReason;
  readonly choiceKind?: ChoiceKind;
  readonly productName?: string;
  readonly options: readonly ChoiceCardOption[];
  readonly optionsTruncated: boolean;
  readonly claimedOptionId?: string;
}): StaffAssistantChoiceCardEnvelope {
  return staffAssistantChoiceCardEnvelopeSchema.parse({
    status: input.status,
    challengeId: input.challengeId,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.choiceKind !== undefined ? { choiceKind: input.choiceKind } : {}),
    ...(input.productName !== undefined
      ? { productName: input.productName }
      : {}),
    options: [...input.options],
    optionsTruncated: input.optionsTruncated,
    ...(input.claimedOptionId !== undefined
      ? { claimedOptionId: input.claimedOptionId }
      : {}),
  });
}

export function needsChoiceOutputFromRecord(
  record: ChoiceRecord,
): StaffAssistantNeedsChoiceOutput {
  const choiceKind =
    record.envelope.choiceKind ?? choiceKindFromTarget(record.target);
  return staffAssistantNeedsChoiceOutputSchema.parse({
    status: STAFF_ASSISTANT_NEEDS_CHOICE_STATUS,
    challengeId: record.choiceId,
    reason: record.envelope.reason ?? "variant_required",
    choiceKind,
    productName:
      record.envelope.productName ?? choiceSubjectName(record.target),
    options: record.envelope.options,
    optionsTruncated: record.envelope.optionsTruncated,
  });
}

export function peekEnvelopeFromRecord(
  record: ChoiceRecord,
): StaffAssistantChoiceCardEnvelope {
  const status: ChoiceCardState =
    record.status === "open"
      ? "needs_choice"
      : record.status === "claimed"
        ? "claimed"
        : "completed";
  return choiceCardEnvelope({
    challengeId: record.choiceId,
    status,
    ...(record.envelope.reason !== undefined
      ? { reason: record.envelope.reason }
      : {}),
    ...(record.envelope.choiceKind !== undefined
      ? { choiceKind: record.envelope.choiceKind }
      : {}),
    ...(record.envelope.productName !== undefined
      ? { productName: record.envelope.productName }
      : {}),
    options: record.envelope.options,
    optionsTruncated: record.envelope.optionsTruncated,
    ...(status === "claimed" && record.claimedOptionId !== undefined
      ? { claimedOptionId: record.claimedOptionId }
      : {}),
  });
}

export function bindsMatch(left: ChoiceBind, right: ChoiceBind): boolean {
  return (
    left.actorId === right.actorId &&
    left.companyId === right.companyId &&
    left.conversationId === right.conversationId
  );
}

export function recordBind(record: ChoiceRecord): ChoiceBind {
  return {
    actorId: record.actorId,
    companyId: record.companyId,
    conversationId: record.conversationId,
  };
}

/**
 * Patch the server-stored canonical create input with the mapped entity id.
 * Client-supplied target / slot / entity id is never an argument.
 */
export function applyChoiceOptionToCanonicalInput(
  input: ChoiceCanonicalCreateInput,
  target: ChoiceTarget,
  mappedId: string,
): ChoiceCanonicalCreateInput {
  if (target.kind === "customer") {
    return {
      customer: { by: "id", id: mappedId },
      items: input.items,
      ...(input.comment !== undefined ? { comment: input.comment } : {}),
    };
  }
  if (target.kind === "order_line_product") {
    const items = input.items.map((item, index) => {
      if (index !== target.lineIndex) {
        return item;
      }
      return {
        product: { by: "id" as const, id: mappedId },
        quantity: item.quantity,
        ...(item.variant !== undefined ? { variant: item.variant } : {}),
        ...(item.variantSelection !== undefined
          ? { variantSelection: item.variantSelection }
          : {}),
      };
    });
    return {
      customer: input.customer,
      items,
      ...(input.comment !== undefined ? { comment: input.comment } : {}),
    };
  }
  const lineIndex = target.lineIndex;
  const items = input.items.map((item, index) => {
    if (index !== lineIndex) {
      return item;
    }
    return {
      product: item.product,
      quantity: item.quantity,
      variantSelection: {
        kind: "reference" as const,
        ref: { by: "id" as const, id: mappedId },
      },
    };
  });
  return {
    customer: input.customer,
    items,
    ...(input.comment !== undefined ? { comment: input.comment } : {}),
  };
}

export function resolveMappedVariantId(
  optionMap: Readonly<Record<string, string>>,
  optionId: string,
): string | undefined {
  return optionMap[optionId];
}

/**
 * Deterministic successor id so a retry of a sequential `needs_choice`
 * reuses the same Redis key (SET NX) instead of minting a second draft.
 */
export function successorChoiceId(parentChoiceId: string): string {
  const bytes = createHash("sha256")
    .update(`choice:successor:${parentChoiceId}`)
    .digest()
    .subarray(0, 16);
  const copy = Uint8Array.from(bytes);
  copy[6] = ((copy[6] ?? 0) & 0x0f) | 0x40;
  copy[8] = ((copy[8] ?? 0) & 0x3f) | 0x80;
  const hex = Buffer.from(copy).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function parseChoiceRecord(raw: string): ChoiceRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  const result = choiceRecordSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

export function serializeChoiceRecord(record: ChoiceRecord): string {
  return JSON.stringify(choiceRecordSchema.parse(record));
}

export function isStaffAssistantNeedsChoiceOutput(
  value: unknown,
): value is StaffAssistantNeedsChoiceOutput {
  return staffAssistantNeedsChoiceOutputSchema.safeParse(value).success;
}

export function toolOutputRequestsChoice(value: unknown): boolean {
  return (
    isRecord(value) && value["status"] === STAFF_ASSISTANT_NEEDS_CHOICE_STATUS
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Accept the streamed `data-choice` envelope or a flattened choice object
 * a client echoes in `messages[].parts`.
 */
export function choiceFromChatPart(
  part: unknown,
): StaffAssistantChoiceCardEnvelope | undefined {
  const parsed = staffAssistantChoiceCardEnvelopeSchema.safeParse(part);
  if (parsed.success) {
    return parsed.data;
  }
  if (!isRecord(part)) {
    return undefined;
  }
  const nested = staffAssistantChoiceCardEnvelopeSchema.safeParse(part.data);
  return nested.success ? nested.data : undefined;
}

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
 * Duck-typed catalog/customers picker extras. Wire code stays CONFLICT.
 * Empty options never parse — no empty picker.
 */
export const catalogPickerConflictExtrasSchema = z.strictObject({
  reason: z.enum(CHOICE_PICKER_REASONS),
  target: catalogConflictTargetSchema,
  options: z.array(choiceCardOptionSchema).min(1),
  optionsTruncated: z.boolean(),
});

export type CatalogPickerConflictExtras = z.output<
  typeof catalogPickerConflictExtrasSchema
>;

export function catalogPickerConflictExtrasFromError(
  error: unknown,
): CatalogPickerConflictExtras | undefined {
  if (!(error instanceof CoreError) || error.code !== "CONFLICT") {
    return undefined;
  }
  const extras: {
    readonly reason: unknown;
    readonly target: unknown;
    readonly options: unknown;
    readonly optionsTruncated: unknown;
  } = {
    reason: Reflect.get(error, "reason") as unknown,
    target: Reflect.get(error, "target") as unknown,
    options: Reflect.get(error, "options") as unknown,
    optionsTruncated: Reflect.get(error, "optionsTruncated") as unknown,
  };
  const parsed = catalogPickerConflictExtrasSchema.safeParse(extras);
  return parsed.success ? parsed.data : undefined;
}

const archivedDomainErrorTargetSchema = z.strictObject({
  kind: z.literal("order_line_product"),
  lineIndex: z.number().int().nonnegative(),
  query: z.string().min(1),
  productName: z.string().min(1).optional(),
});

const noActiveVariantsDomainErrorTargetSchema = z.strictObject({
  kind: z.literal("order_line_variant").optional(),
  lineIndex: z.number().int().nonnegative(),
  productId: z.uuid(),
  productName: z.string().min(1),
});

/**
 * Narrow non-picker subject for presenter copy. Canonical productName when
 * one archived (or unsellable) product is identified; original query when
 * several archived matches share a search string.
 */
export const catalogDomainErrorSubjectSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("product_name"),
    name: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("query"),
    query: z.string().min(1),
  }),
]);

export type CatalogDomainErrorSubject = z.output<
  typeof catalogDomainErrorSubjectSchema
>;

export const catalogDomainErrorExtrasSchema = z.discriminatedUnion("reason", [
  z.strictObject({
    reason: z.literal("archived"),
    subject: catalogDomainErrorSubjectSchema,
  }),
  z.strictObject({
    reason: z.literal("no_active_variants"),
    subject: z.strictObject({
      kind: z.literal("product_name"),
      name: z.string().min(1),
    }),
  }),
]);

export type CatalogDomainErrorExtras = z.output<
  typeof catalogDomainErrorExtrasSchema
>;

export const staffAssistantDomainErrorOutputSchema = z.discriminatedUnion(
  "reason",
  [
    z.strictObject({
      status: z.literal("error"),
      code: z.string().min(1),
      message: z.string(),
      reason: z.literal("archived"),
      subject: catalogDomainErrorSubjectSchema,
    }),
    z.strictObject({
      status: z.literal("error"),
      code: z.string().min(1),
      message: z.string(),
      reason: z.literal("no_active_variants"),
      subject: z.strictObject({
        kind: z.literal("product_name"),
        name: z.string().min(1),
      }),
    }),
  ],
);

export type StaffAssistantDomainErrorOutput = z.output<
  typeof staffAssistantDomainErrorOutputSchema
>;

function catalogDomainErrorExtrasFromDuckTyped(
  reason: unknown,
  target: unknown,
): CatalogDomainErrorExtras | undefined {
  if (reason === "archived") {
    const parsedTarget = archivedDomainErrorTargetSchema.safeParse(target);
    if (!parsedTarget.success) {
      return undefined;
    }
    const subject =
      parsedTarget.data.productName !== undefined
        ? {
            kind: "product_name" as const,
            name: parsedTarget.data.productName,
          }
        : { kind: "query" as const, query: parsedTarget.data.query };
    return catalogDomainErrorExtrasSchema.parse({
      reason: "archived",
      subject,
    });
  }
  if (reason === "no_active_variants") {
    const parsedTarget =
      noActiveVariantsDomainErrorTargetSchema.safeParse(target);
    if (!parsedTarget.success) {
      return undefined;
    }
    return catalogDomainErrorExtrasSchema.parse({
      reason: "no_active_variants",
      subject: {
        kind: "product_name",
        name: parsedTarget.data.productName,
      },
    });
  }
  return undefined;
}

/**
 * Duck-typed catalog extras for presenter-owned terminals. Picker reasons
 * and malformed targets return undefined — never invent an archived
 * explanation from English `clientMessage`.
 */
export function catalogDomainErrorExtrasFromError(
  error: unknown,
): CatalogDomainErrorExtras | undefined {
  if (!(error instanceof CoreError) || error.code !== "CONFLICT") {
    return undefined;
  }
  return catalogDomainErrorExtrasFromDuckTyped(
    Reflect.get(error, "reason") as unknown,
    Reflect.get(error, "target") as unknown,
  );
}

export function catalogDomainErrorExtrasFromToolOutput(
  output: unknown,
): CatalogDomainErrorExtras | undefined {
  const parsed = staffAssistantDomainErrorOutputSchema.safeParse(output);
  if (!parsed.success) {
    return undefined;
  }
  if (parsed.data.reason === "archived") {
    return {
      reason: "archived",
      subject: parsed.data.subject,
    };
  }
  return {
    reason: "no_active_variants",
    subject: parsed.data.subject,
  };
}

export function staffAssistantTypedDomainErrorOutput(
  error: CoreError,
): StaffAssistantDomainErrorOutput | undefined {
  const extras = catalogDomainErrorExtrasFromError(error);
  if (extras === undefined) {
    return undefined;
  }
  return staffAssistantDomainErrorOutputSchema.parse({
    status: "error",
    code: error.code,
    message: error.clientMessage,
    reason: extras.reason,
    subject: extras.subject,
  });
}

export function choiceRecordFromPickerConflict(args: {
  readonly choiceId: string;
  readonly bind: ChoiceBind;
  readonly canonicalInput: ChoiceCanonicalCreateInput;
  readonly extras: CatalogPickerConflictExtras;
  readonly locale?: "uk" | "en";
  readonly randomId?: () => string;
}): ChoiceRecord | undefined {
  const bound = bindChoiceOptions(
    args.extras.options,
    args.extras.optionsTruncated,
    args.randomId,
  );
  if (bound.options.length === 0) {
    return undefined;
  }
  const target = choiceTargetSchema.parse(args.extras.target);
  const choiceKind = choiceKindFromTarget(target);
  const envelope = choiceCardEnvelope({
    challengeId: args.choiceId,
    status: STAFF_ASSISTANT_NEEDS_CHOICE_STATUS,
    reason: args.extras.reason,
    choiceKind,
    productName: choiceSubjectName(target),
    options: bound.options,
    optionsTruncated: bound.optionsTruncated,
  });
  return choiceRecordSchema.parse({
    status: "open",
    choiceId: args.choiceId,
    actorId: args.bind.actorId,
    companyId: args.bind.companyId,
    conversationId: args.bind.conversationId,
    canonicalInput: args.canonicalInput,
    target,
    optionMap: { ...bound.optionMap },
    envelope,
    ...(args.locale !== undefined ? { locale: args.locale } : {}),
  });
}

export async function needsChoiceFromOrdersCreateConflict(args: {
  readonly actionName: string;
  readonly input: unknown;
  readonly error: unknown;
  readonly bind?: ChoiceBind;
  readonly locale?: "uk" | "en";
  readonly openChoice?: (record: ChoiceRecord) => Promise<boolean>;
  readonly mintChoiceId?: () => string;
}): Promise<StaffAssistantNeedsChoiceOutput | undefined> {
  if (args.actionName !== "orders.create") {
    return undefined;
  }
  const extras = catalogPickerConflictExtrasFromError(args.error);
  if (extras === undefined) {
    return undefined;
  }
  const canonical = choiceCanonicalCreateInputSchema.safeParse(args.input);
  if (!canonical.success) {
    return undefined;
  }
  const choiceId = (args.mintChoiceId ?? randomUUID)();
  if (args.bind !== undefined) {
    const record = choiceRecordFromPickerConflict({
      choiceId,
      bind: args.bind,
      canonicalInput: canonical.data,
      extras,
      ...(args.locale !== undefined ? { locale: args.locale } : {}),
    });
    if (record === undefined) {
      return undefined;
    }
    if (args.openChoice !== undefined) {
      const opened = await args.openChoice(record);
      if (!opened) {
        return undefined;
      }
    }
    return needsChoiceOutputFromRecord(record);
  }
  const bound = bindChoiceOptions(extras.options, extras.optionsTruncated);
  if (bound.options.length === 0) {
    return undefined;
  }
  const target = choiceTargetSchema.parse(extras.target);
  return staffAssistantNeedsChoiceOutputSchema.parse({
    status: STAFF_ASSISTANT_NEEDS_CHOICE_STATUS,
    challengeId: choiceId,
    reason: extras.reason,
    choiceKind: choiceKindFromTarget(target),
    productName: choiceSubjectName(target),
    options: bound.options,
    optionsTruncated: bound.optionsTruncated,
  });
}
