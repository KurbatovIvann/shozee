/**
 * Completed-turn spoken presenter (SHO-402 / SHO-401 T1).
 *
 * When a turn produced a registered result surface, persist the same
 * view the client registry would show — not model `{ spoken }`. Copy is
 * duplicated here so `@showzy/ai` does not import `apps/mobile`.
 */
import { z } from "zod";

import { toProviderToolName } from "./action-tool.js";
import {
  catalogDomainErrorExtrasFromToolOutput,
  isStaffAssistantNeedsChoiceOutput,
  needsChoiceOutputFromRecord,
  staffAssistantNeedsChoiceInteractionSchema,
  type CatalogDomainErrorExtras,
  type ChoiceRecord,
  type StaffAssistantNeedsChoiceInteraction,
  type StaffAssistantNeedsChoiceOutput,
} from "./choice.js";
import { STAFF_ASSISTANT_CLIPPED_STATUS } from "./clip-tool-result.js";
import { isStaffAssistantConfirmationOutput } from "./confirmation.js";
import {
  lastStaffAssistantTypedToolErrorMessage,
  spokenTurnText,
} from "./spoken-reply.js";
import { ORDERS_CREATE_TOOL_NAME } from "./tool-facades/orders-create.js";
import {
  ORDERS_LIST_COUNTS_TOOL_NAME,
  ORDERS_LIST_PAGE_ASSISTANT_MAX_LIMIT,
  ORDERS_LIST_PAGE_TOOL_NAME,
} from "./tool-facades/orders-list.js";

export const STAFF_ASSISTANT_LOCALES = ["uk", "en"] as const;
export type StaffAssistantLocale = (typeof STAFF_ASSISTANT_LOCALES)[number];
export const STAFF_ASSISTANT_DEFAULT_LOCALE: StaffAssistantLocale = "uk";

export const CHOICE_TRUNCATED_COPY: Record<StaffAssistantLocale, string> = {
  en: "More variants exist. Reply with the exact flavour name.",
  uk: "Є ще варіанти. Напишіть точну назву смаку.",
};

export const CHOICE_TRUNCATED_MATCH_COPY: Record<StaffAssistantLocale, string> =
  {
    en: "More matches exist. Reply with the exact name.",
    uk: "Є ще збіги. Напишіть точну назву.",
  };

function quoteProductName(name: string, locale: StaffAssistantLocale): string {
  return locale === "uk" ? `«${name}»` : `"${name}"`;
}

export function presentCatalogDomainError(options: {
  readonly locale: StaffAssistantLocale;
  readonly extras: CatalogDomainErrorExtras;
}): string {
  const { locale, extras } = options;
  if (extras.reason === "no_active_variants") {
    const quoted = quoteProductName(extras.subject.name, locale);
    return locale === "uk"
      ? `${quoted} не має активних варіантів, в замовлення його додати не можна. Напишіть інший товар або повторіть замовлення без нього.`
      : `${quoted} has no active variants and cannot be added to an order. Name a different product, or repeat the order without it.`;
  }
  if (extras.subject.kind === "product_name") {
    const quoted = quoteProductName(extras.subject.name, locale);
    return locale === "uk"
      ? `${quoted} в архіві, в замовлення його додати не можна. Напишіть інший товар або повторіть замовлення без нього.`
      : `${quoted} is archived and cannot be added to an order. Name a different product, or repeat the order without it.`;
  }
  const quoted = quoteProductName(extras.subject.query, locale);
  return locale === "uk"
    ? `За запитом ${quoted} знайдено лише товари в архіві, в замовлення їх додати не можна. Напишіть інший товар або повторіть замовлення без них.`
    : `No sellable product matched ${quoted}; matching products are archived and cannot be added to an order. Name a different product, or repeat the order without them.`;
}

export function presentDomainErrorStaffAssistantTurn(options: {
  readonly locale: StaffAssistantLocale;
  readonly toolResults: readonly StaffAssistantPresentedToolResult[];
}): string | undefined {
  for (let index = options.toolResults.length - 1; index >= 0; index -= 1) {
    const result = options.toolResults[index];
    if (result === undefined) {
      continue;
    }
    const extras = catalogDomainErrorExtrasFromToolOutput(result.output);
    if (extras !== undefined) {
      return presentCatalogDomainError({
        locale: options.locale,
        extras,
      });
    }
  }
  return undefined;
}

export const staffAssistantLocaleSchema = z.enum(STAFF_ASSISTANT_LOCALES);

const ORDERS_GET_TOOL_NAME = toProviderToolName("orders.get");
const ORDERS_GET_TOOLS = new Set(["orders.get", ORDERS_GET_TOOL_NAME]);
const ORDERS_CREATE_TOOLS = new Set(["orders.create", ORDERS_CREATE_TOOL_NAME]);

const ORDER_STATUSES = [
  "new",
  "confirmed",
  "in_progress",
  "done",
  "canceled",
] as const;
type OrderStatus = (typeof ORDER_STATUSES)[number];

const UNLINKED_CUSTOMER_NAME_SNAPSHOT = "unlinked";

const STATUS_LABELS: Record<
  StaffAssistantLocale,
  Record<OrderStatus, string>
> = {
  en: {
    new: "New",
    confirmed: "Confirmed",
    in_progress: "In progress",
    done: "Done",
    canceled: "Canceled",
  },
  uk: {
    new: "Нове",
    confirmed: "Підтверджено",
    in_progress: "В роботі",
    done: "Виконано",
    canceled: "Скасовано",
  },
};

const COPY: Record<
  StaffAssistantLocale,
  {
    readonly empty: string;
    readonly listPrefix: string;
    readonly hasMore: string;
    readonly customerMatchTruncated: string;
    readonly missingCustomer: string;
    readonly entityPrefix: string;
    readonly orderCount: {
      readonly one: string;
      readonly few: string;
      readonly many: string;
    };
  }
> = {
  en: {
    empty: "No orders.",
    listPrefix: "Latest orders",
    hasMore: "There are more orders.",
    customerMatchTruncated:
      "Customer name matches were truncated. Refine the search or open the list.",
    missingCustomer: "Deleted customer",
    entityPrefix: "Order",
    orderCount: {
      one: "{{count}} order",
      few: "{{count}} orders",
      many: "{{count}} orders",
    },
  },
  uk: {
    empty: "Немає замовлень.",
    listPrefix: "Останні замовлення",
    hasMore: "Є ще замовлення.",
    customerMatchTruncated:
      "Збіги за імʼям клієнта обрізано. Уточніть запит або відкрийте список.",
    missingCustomer: "Клієнт видалений",
    entityPrefix: "Замовлення",
    orderCount: {
      one: "{{count}} замовлення",
      few: "{{count}} замовлення",
      many: "{{count}} замовлень",
    },
  },
};

export type StaffAssistantPresentedToolResult = {
  readonly toolName: string;
  readonly output: unknown;
};

type SpokenTurnRun = {
  readonly outcome:
    "success" | "error" | "confirmation_required" | "choice_required";
};

type PresentedSurface = {
  readonly index: number;
  readonly spoken: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTypedToolError(value: unknown): boolean {
  return (
    isRecord(value) &&
    value["status"] === "error" &&
    typeof value["code"] === "string"
  );
}

function isSuccessfulToolOutput(output: unknown): boolean {
  if (output === undefined) {
    return false;
  }
  if (isTypedToolError(output)) {
    return false;
  }
  if (isStaffAssistantConfirmationOutput(output)) {
    return false;
  }
  if (isStaffAssistantNeedsChoiceOutput(output)) {
    return false;
  }
  return true;
}

function unwrapToolOutput(output: unknown): {
  readonly payload: unknown;
  readonly clipped: boolean;
} {
  if (isRecord(output) && output["status"] === STAFF_ASSISTANT_CLIPPED_STATUS) {
    return { payload: output["preview"], clipped: true };
  }
  return { payload: output, clipped: false };
}

function isOrderStatus(value: unknown): value is OrderStatus {
  return (
    typeof value === "string" &&
    (ORDER_STATUSES as readonly string[]).includes(value)
  );
}

function interpolate(template: string, count: number): string {
  return template.replaceAll("{{count}}", String(count));
}

function countPluralForm(
  count: number,
  locale: StaffAssistantLocale,
): "one" | "few" | "many" {
  if (locale !== "uk") {
    return count === 1 ? "one" : "many";
  }
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return "one";
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return "few";
  }
  return "many";
}

function orderCountSpoken(count: number, locale: StaffAssistantLocale): string {
  const form = countPluralForm(count, locale);
  return interpolate(COPY[locale].orderCount[form], count);
}

function customerNameFromPayload(
  payload: Record<string, unknown>,
  missingCustomer: string,
): string | null {
  const customer = payload["customer"];
  if (!isRecord(customer)) {
    return null;
  }
  const nameSnapshot = customer["nameSnapshot"];
  if (typeof nameSnapshot !== "string" || nameSnapshot.length === 0) {
    return missingCustomer;
  }
  if (nameSnapshot === UNLINKED_CUSTOMER_NAME_SNAPSHOT) {
    return missingCustomer;
  }
  return nameSnapshot;
}

function formatOrderNumber(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? `#${value}` : "";
}

function lastSuccessfulIndex(
  results: readonly StaffAssistantPresentedToolResult[],
  matches: (toolName: string) => boolean,
): number {
  let found = -1;
  for (const [index, result] of results.entries()) {
    if (!matches(result.toolName) || !isSuccessfulToolOutput(result.output)) {
      continue;
    }
    found = index;
  }
  return found;
}

function pageRows(payload: unknown): unknown[] {
  if (!isRecord(payload)) {
    return [];
  }
  if (Array.isArray(payload["rows"])) {
    return payload["rows"];
  }
  if (Array.isArray(payload["items"])) {
    return payload["items"];
  }
  return [];
}

function pageHasMore(payload: unknown, clipped: boolean): boolean {
  if (clipped) {
    return true;
  }
  if (isRecord(payload) && typeof payload["hasMore"] === "boolean") {
    return payload["hasMore"];
  }
  return (
    isRecord(payload) &&
    typeof payload["nextCursor"] === "string" &&
    payload["nextCursor"].length > 0
  );
}

function presentListSurface(
  pageOutput: unknown,
  locale: StaffAssistantLocale,
): string {
  const copy = COPY[locale];
  const { payload, clipped } = unwrapToolOutput(pageOutput);
  const items = pageRows(payload);
  const customerMatchTruncated =
    isRecord(payload) && payload["customerMatchTruncated"] === true;
  const labels: string[] = [];
  for (const row of items) {
    if (labels.length >= ORDERS_LIST_PAGE_ASSISTANT_MAX_LIMIT) {
      break;
    }
    if (!isRecord(row)) {
      continue;
    }
    const numberLabel = formatOrderNumber(row["orderNumber"]);
    const status = isOrderStatus(row["status"])
      ? STATUS_LABELS[locale][row["status"]]
      : null;
    const numberPart = numberLabel.length > 0 ? numberLabel : null;
    if (numberPart !== null && status !== null) {
      labels.push(`${numberPart} (${status})`);
    } else if (numberPart !== null) {
      labels.push(numberPart);
    } else if (status !== null) {
      labels.push(status);
    }
  }
  const footnotes: string[] = [];
  if (customerMatchTruncated) {
    footnotes.push(copy.customerMatchTruncated);
  }
  if (pageHasMore(payload, clipped)) {
    footnotes.push(copy.hasMore);
  }
  const main =
    labels.length === 0
      ? copy.empty
      : `${copy.listPrefix}: ${labels.join(", ")}.`;
  if (footnotes.length === 0) {
    return main;
  }
  return [main, ...footnotes].join(" ");
}

function presentAggregateSurface(
  countsOutput: unknown,
  locale: StaffAssistantLocale,
): string {
  const copy = COPY[locale];
  const { payload, clipped } = unwrapToolOutput(countsOutput);
  if (!isRecord(payload) || payload["kind"] !== "aggregate") {
    return copy.empty;
  }
  const orderCount =
    typeof payload["orderCount"] === "number" ? payload["orderCount"] : 0;
  const rawBuckets = payload["buckets"];
  const buckets = Array.isArray(rawBuckets) ? rawBuckets : [];
  const byStatus = new Map<OrderStatus, number>();
  for (const bucket of buckets) {
    if (!isRecord(bucket)) {
      continue;
    }
    const identity = bucket["identity"];
    if (!isRecord(identity) || identity["kind"] !== "status") {
      continue;
    }
    if (!isOrderStatus(identity["status"])) {
      continue;
    }
    const count =
      typeof bucket["orderCount"] === "number" ? bucket["orderCount"] : 0;
    byStatus.set(identity["status"], count);
  }
  const chipParts: string[] = [];
  for (const status of ORDER_STATUSES) {
    const count = byStatus.get(status);
    if (count === undefined) {
      continue;
    }
    chipParts.push(`${STATUS_LABELS[locale][status]} · ${String(count)}`);
  }
  const footnotes: string[] = [];
  if (payload["customerMatchTruncated"] === true) {
    footnotes.push(copy.customerMatchTruncated);
  }
  if (clipped) {
    footnotes.push(copy.hasMore);
  }
  const empty = chipParts.length === 0 && orderCount === 0;
  const main = empty
    ? copy.empty
    : chipParts.length === 0
      ? `${orderCountSpoken(orderCount, locale)}.`
      : `${orderCountSpoken(orderCount, locale)}. ${chipParts.join(", ")}.`;
  if (footnotes.length === 0) {
    return main;
  }
  return [main, ...footnotes].join(" ");
}

function presentEntitySurface(
  output: unknown,
  locale: StaffAssistantLocale,
): string | null {
  const copy = COPY[locale];
  const { payload } = unwrapToolOutput(output);
  if (!isRecord(payload)) {
    return null;
  }
  const orderId = payload["orderId"];
  if (typeof orderId !== "string" || orderId.length === 0) {
    return null;
  }
  const numberLabel = formatOrderNumber(payload["orderNumber"]);
  const status = isOrderStatus(payload["status"])
    ? STATUS_LABELS[locale][payload["status"]]
    : null;
  const customer = customerNameFromPayload(payload, copy.missingCustomer);
  const bits: string[] = [];
  if (numberLabel.length > 0) {
    bits.push(numberLabel);
  }
  if (customer !== null) {
    bits.push(customer);
  }
  if (status !== null) {
    bits.push(status);
  }
  if (bits.length === 0) {
    return `${copy.entityPrefix}.`;
  }
  return `${copy.entityPrefix} ${bits.join(", ")}.`;
}

/**
 * Same surfaces as the mobile result-card registry: page (+ optional
 * counts) → one list; counts-only → one aggregate; N entities from
 * get/create. Fragments follow tool-result order.
 */
export function presentCompletedStaffAssistantTurn(options: {
  readonly locale: StaffAssistantLocale;
  readonly toolResults: readonly StaffAssistantPresentedToolResult[];
}): string | undefined {
  const { locale, toolResults } = options;
  const pageIndex = lastSuccessfulIndex(
    toolResults,
    (name) => name === ORDERS_LIST_PAGE_TOOL_NAME,
  );
  const countsIndex = lastSuccessfulIndex(
    toolResults,
    (name) => name === ORDERS_LIST_COUNTS_TOOL_NAME,
  );
  const surfaces: PresentedSurface[] = [];
  if (pageIndex >= 0) {
    const page = toolResults[pageIndex];
    if (page !== undefined) {
      surfaces.push({
        index: pageIndex,
        spoken: presentListSurface(page.output, locale),
      });
    }
  } else if (countsIndex >= 0) {
    const counts = toolResults[countsIndex];
    if (counts !== undefined) {
      surfaces.push({
        index: countsIndex,
        spoken: presentAggregateSurface(counts.output, locale),
      });
    }
  }
  for (const [index, result] of toolResults.entries()) {
    if (!isSuccessfulToolOutput(result.output)) {
      continue;
    }
    if (
      !ORDERS_GET_TOOLS.has(result.toolName) &&
      !ORDERS_CREATE_TOOLS.has(result.toolName)
    ) {
      continue;
    }
    const spoken = presentEntitySurface(result.output, locale);
    if (spoken !== null) {
      surfaces.push({ index, spoken });
    }
  }
  if (surfaces.length === 0) {
    return undefined;
  }
  surfaces.sort((left, right) => left.index - right.index);
  return surfaces.map((surface) => surface.spoken).join("\n");
}

function presentChoiceIntro(
  output: StaffAssistantNeedsChoiceOutput,
  locale: StaffAssistantLocale,
): string {
  const labels = output.options.map((option) => option.label).join(", ");
  const kind = output.choiceKind ?? "variant";
  if (kind === "customer") {
    return locale === "uk"
      ? `Оберіть клієнта «${output.productName}»: ${labels}.`
      : `Select a customer matching ${output.productName}: ${labels}.`;
  }
  if (kind === "product") {
    return locale === "uk"
      ? `Оберіть товар «${output.productName}»: ${labels}.`
      : `Select a product matching ${output.productName}: ${labels}.`;
  }
  return locale === "uk"
    ? `Оберіть варіант для ${output.productName}: ${labels}.`
    : `Select a variant for ${output.productName}: ${labels}.`;
}

function presentChoiceSurface(
  output: StaffAssistantNeedsChoiceOutput,
  locale: StaffAssistantLocale,
): string {
  const intro = presentChoiceIntro(output, locale);
  const kind = output.choiceKind ?? "variant";
  if (output.optionsTruncated) {
    const truncated =
      kind === "variant"
        ? CHOICE_TRUNCATED_COPY[locale]
        : CHOICE_TRUNCATED_MATCH_COPY[locale];
    return `${intro} ${truncated}`;
  }
  return intro;
}

export function presentChoiceStaffAssistantTurn(options: {
  readonly locale: StaffAssistantLocale;
  readonly toolResults: readonly StaffAssistantPresentedToolResult[];
}): string | undefined {
  for (let index = options.toolResults.length - 1; index >= 0; index -= 1) {
    const result = options.toolResults[index];
    if (
      result !== undefined &&
      isStaffAssistantNeedsChoiceOutput(result.output)
    ) {
      return presentChoiceSurface(result.output, options.locale);
    }
  }
  return undefined;
}

/**
 * Sequential ChoiceCard speech from the successor record's view-model
 * (SHO-427). Same copy as `presentChoiceStaffAssistantTurn` — not catalog
 * `clientMessage`. Persist this string and return it as `text`.
 */
export function presentChoiceStaffAssistantNeedsChoice(options: {
  readonly locale: StaffAssistantLocale;
  readonly record: ChoiceRecord;
}): StaffAssistantNeedsChoiceInteraction {
  const output = needsChoiceOutputFromRecord(options.record);
  return staffAssistantNeedsChoiceInteractionSchema.parse({
    ...output,
    text: presentChoiceSurface(output, options.locale),
  });
}

/**
 * True when the live bubble and persist body must come from the completed
 * presenter, not model `{ spoken }`. HITL confirmation still uses the
 * spoken flatten.
 */
export function staffAssistantTurnUsesCompletedPresenter(options: {
  readonly locale: StaffAssistantLocale;
  readonly toolResults: readonly StaffAssistantPresentedToolResult[];
  readonly runs: readonly SpokenTurnRun[];
}): boolean {
  if (options.runs.some((run) => run.outcome === "confirmation_required")) {
    return false;
  }
  if (
    presentChoiceStaffAssistantTurn({
      locale: options.locale,
      toolResults: options.toolResults,
    }) !== undefined
  ) {
    return true;
  }
  if (
    presentDomainErrorStaffAssistantTurn({
      locale: options.locale,
      toolResults: options.toolResults,
    }) !== undefined
  ) {
    return true;
  }
  if (options.runs.some((run) => run.outcome === "choice_required")) {
    return false;
  }
  return (
    presentCompletedStaffAssistantTurn({
      locale: options.locale,
      toolResults: options.toolResults,
    }) !== undefined
  );
}

/**
 * Visible bubble and persist body: presenter when a registered completed
 * surface exists, otherwise model `{ spoken }`. HITL confirmation still wins.
 */
export function staffAssistantPersistedTurnText(options: {
  readonly locale: StaffAssistantLocale;
  readonly toolResults: readonly StaffAssistantPresentedToolResult[];
  readonly parsedSpoken: string | undefined;
  readonly rawText: string;
  readonly runs: readonly SpokenTurnRun[];
}): string {
  if (staffAssistantTurnUsesCompletedPresenter(options)) {
    const choice = presentChoiceStaffAssistantTurn({
      locale: options.locale,
      toolResults: options.toolResults,
    });
    if (choice !== undefined) {
      return choice;
    }
    const domainError = presentDomainErrorStaffAssistantTurn({
      locale: options.locale,
      toolResults: options.toolResults,
    });
    if (domainError !== undefined) {
      return domainError;
    }
    const presented = presentCompletedStaffAssistantTurn({
      locale: options.locale,
      toolResults: options.toolResults,
    });
    if (presented !== undefined) {
      return presented;
    }
  }
  const toolErrorMessage = lastStaffAssistantTypedToolErrorMessage(
    options.toolResults.map((result) => result.output),
  );
  return spokenTurnText({
    parsedSpoken: options.parsedSpoken,
    rawText: options.rawText,
    runs: options.runs,
    ...(toolErrorMessage !== undefined ? { toolErrorMessage } : {}),
  });
}
