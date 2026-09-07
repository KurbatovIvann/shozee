/**
 * Client-side `data-choice` envelope (SHO-418). Duplicates the
 * `@showzy/ai` parser — mobile must not import that package.
 */
import { z } from "zod";

export const STAFF_ASSISTANT_NEEDS_CHOICE_STATUS = "needs_choice" as const;
export const CHOICE_OPTIONS_MAX = 20;

export const CHOICE_TRUNCATED_COPY = {
  en: "More variants exist. Reply with the exact flavour name.",
  uk: "Є ще варіанти. Напиши точну назву смаку.",
} as const;

export const CHOICE_TRUNCATED_MATCH_COPY = {
  en: "More matches exist. Reply with the exact name.",
  uk: "Є ще збіги. Напиши точну назву.",
} as const;

export const CHOICE_CLAIMED_COPY = {
  en: "This choice is already in progress. Continue to finish it.",
  uk: "Цей вибір уже в процесі. Продовжи, щоб завершити.",
} as const;

export const CHOICE_RETRY_COPY = {
  en: "Continue",
  uk: "Продовжити",
} as const;

export const staffAssistantChoiceCardEnvelopeSchema = z.strictObject({
  status: z.enum(["needs_choice", "claimed", "completed", "expired"]),
  challengeId: z.uuid(),
  reason: z
    .enum([
      "variant_required",
      "ambiguous",
      "unmatched_query",
      "no_active_variants",
    ])
    .optional(),
  choiceKind: z.enum(["variant", "product", "customer"]).optional(),
  productName: z.string().min(1).optional(),
  options: z
    .array(
      z.strictObject({
        id: z.uuid(),
        label: z.string().min(1),
      }),
    )
    .max(CHOICE_OPTIONS_MAX),
  optionsTruncated: z.boolean(),
  claimedOptionId: z.uuid().optional(),
});

export type StaffAssistantChoiceCardEnvelope = z.output<
  typeof staffAssistantChoiceCardEnvelopeSchema
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

/**
 * T8a peek returns `{ status: "expired" }` with no other fields. Expand
 * that into a non-tappable expired envelope — never a dead open picker.
 * Unreadable or HTTP/Core error bodies are not expiry: return undefined
 * so reload can peek again.
 */
export function envelopeFromChoicePeek(
  choiceId: string,
  body: unknown,
): StaffAssistantChoiceCardEnvelope | undefined {
  if (isRecord(body) && body.status === "expired") {
    return {
      status: "expired",
      challengeId: choiceId,
      options: [],
      optionsTruncated: false,
    };
  }
  const parsed = staffAssistantChoiceCardEnvelopeSchema.safeParse(body);
  if (parsed.success) {
    return parsed.data;
  }
  const stripped = choiceEnvelopeForWire(body);
  if (stripped !== undefined) {
    return stripped;
  }
  return undefined;
}

/**
 * Keep the ChoiceCard envelope and drop server-only extras
 * (`canonicalInput`, `target`, `optionMap`) if a client echoes them.
 */
export function choiceEnvelopeForWire(
  data: unknown,
): StaffAssistantChoiceCardEnvelope | undefined {
  const direct = choiceFromChatPart(data);
  if (direct !== undefined) {
    return direct;
  }
  if (!isRecord(data)) {
    return undefined;
  }
  const nested = isRecord(data.data) ? data.data : data;
  const stripped = {
    status: nested.status,
    challengeId: nested.challengeId,
    ...(typeof nested.reason === "string" ? { reason: nested.reason } : {}),
    ...(typeof nested.choiceKind === "string"
      ? { choiceKind: nested.choiceKind }
      : {}),
    ...(typeof nested.productName === "string"
      ? { productName: nested.productName }
      : {}),
    options: nested.options,
    optionsTruncated: nested.optionsTruncated,
    ...(typeof nested.claimedOptionId === "string"
      ? { claimedOptionId: nested.claimedOptionId }
      : {}),
  };
  const parsed = staffAssistantChoiceCardEnvelopeSchema.safeParse(stripped);
  return parsed.success ? parsed.data : undefined;
}

export function presentChoiceCardText(
  envelope: StaffAssistantChoiceCardEnvelope,
  locale: "uk" | "en",
): string {
  const labels = envelope.options.map((option) => option.label).join(", ");
  const name = envelope.productName ?? "";
  const kind = envelope.choiceKind ?? "variant";
  let intro: string;
  if (kind === "customer") {
    intro =
      locale === "uk"
        ? `Обери клієнта «${name}»: ${labels}.`
        : `Select a customer matching ${name}: ${labels}.`;
  } else if (kind === "product") {
    intro =
      locale === "uk"
        ? `Обери товар «${name}»: ${labels}.`
        : `Select a product matching ${name}: ${labels}.`;
  } else {
    intro =
      locale === "uk"
        ? `Обери варіант для ${name}: ${labels}.`
        : `Select a variant for ${name}: ${labels}.`;
  }
  if (envelope.optionsTruncated) {
    const truncated =
      kind === "variant"
        ? CHOICE_TRUNCATED_COPY[locale]
        : CHOICE_TRUNCATED_MATCH_COPY[locale];
    return `${intro} ${truncated}`;
  }
  return intro;
}

/**
 * Open picker, claimed recovery, or expired copy. Completed is not a
 * ChoiceCard — the later successful entity turn hydrates on its own.
 */
export function isRestorableChoiceStatus(
  status: StaffAssistantChoiceCardEnvelope["status"],
): boolean {
  return (
    status === "needs_choice" || status === "claimed" || status === "expired"
  );
}

/**
 * Opaque option the claimed recovery card may retry. Never a variant id.
 */
export function claimedRetryOptionId(
  envelope: StaffAssistantChoiceCardEnvelope,
): string | undefined {
  if (envelope.status !== "claimed") {
    return undefined;
  }
  return envelope.claimedOptionId;
}

export function claimedOptionLabel(
  envelope: StaffAssistantChoiceCardEnvelope,
): string | undefined {
  const optionId = claimedRetryOptionId(envelope);
  if (optionId === undefined) {
    return undefined;
  }
  return envelope.options.find((option) => option.id === optionId)?.label;
}
