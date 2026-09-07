/**
 * Clip large tool results before they are fed back into the model within
 * a turn (SHO-341 / SHO-346). ADR-0034 `model_trace` persists this same
 * post-clip façade output, not the unclipped registry payload. Result
 * ids still come from wrapExecute's registry output. Oversized previews
 * keep identity fields, never `{ truncated: true }` alone.
 */
import {
  ASSISTANT_TOOL_CLIPPED_STATUS,
  type AssistantClippedToolEnvelope,
} from "@showzy/validation/assistant-surfaces";

import { isStaffAssistantNeedsChoiceOutput } from "./choice.js";
import { isStaffAssistantConfirmationOutput } from "./confirmation.js";
import { staffAssistantPostgresJsonbTextChars } from "./json-chars.js";

/**
 * Array backstop after façade compact maps. Matches
 * `LIST_ORDERS_SUMMARY_MAX_LIMIT` / `orders_list_page` max (SHO-403) so a
 * completed 50-row page is not sliced while `nextCursor` stays null.
 */
export const STAFF_ASSISTANT_CLIP_ARRAY_MAX = 50;
/**
 * JSON backstop after façade compact maps. SHO-403: a max-name
 * `orders_list_page` completed view of 50 compact rows plus an 80-char
 * cursor is 20_176 bytes. **22_000** is the mechanical budget so handler
 * `nextCursor` matches visible rows. Length is PostgreSQL `jsonb::text`
 * (spaces after `:` / `,`) so a clipped payload cannot fail the
 * `model_trace` CHECK. Do not treat `{ truncated: true }` as the page.
 */
export const STAFF_ASSISTANT_CLIP_JSON_MAX = 22_000;
export const STAFF_ASSISTANT_CLIPPED_STATUS = ASSISTANT_TOOL_CLIPPED_STATUS;
export const STAFF_ASSISTANT_CLIP_SHRINK_ARRAY_MAX = 3;

/**
 * Identifier / name / status keys kept when shrinking a clipped preview.
 * `itemId` is the line-item id (orders.get / documents.get rows).
 * `basePriceMinor` / `currency` are catalog list money snapshots (SHO-357)
 * so a clipped compact page can still fill a markup.
 * `phone` / `email` / `groupId` / `priceListId` are CRM list contacts
 * (SHO-381); identity shrink must not drop them.
 * `requestedLimit` / `hasMore` are the SHO-403 completed list view.
 */
export const STAFF_ASSISTANT_CLIP_IDENTITY_KEYS = [
  "id",
  "itemId",
  "orderId",
  "orderNumber",
  "customerId",
  "documentId",
  "name",
  "titleSnapshot",
  "status",
  "nextCursor",
  "itemCount",
  "basePriceMinor",
  "currency",
  "phone",
  "email",
  "groupId",
  "priceListId",
  "requestedLimit",
  "hasMore",
] as const;

const IDENTITY_KEY_SET = new Set<string>(STAFF_ASSISTANT_CLIP_IDENTITY_KEYS);

export type StaffAssistantClippedResult = AssistantClippedToolEnvelope;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTypedToolError(value: unknown): boolean {
  return (
    isRecord(value) &&
    value["status"] === "error" &&
    typeof value["code"] === "string" &&
    typeof value["message"] === "string"
  );
}

function jsonLength(value: unknown): number {
  const chars = staffAssistantPostgresJsonbTextChars(value);
  return Number.isFinite(chars) ? chars : STAFF_ASSISTANT_CLIP_JSON_MAX + 1;
}

function pickIdentityFields(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of STAFF_ASSISTANT_CLIP_IDENTITY_KEYS) {
    if (key in record) {
      picked[key] = record[key];
    }
  }
  return picked;
}

function compactIdentity(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .slice(0, STAFF_ASSISTANT_CLIP_SHRINK_ARRAY_MAX)
      .map((entry) => compactIdentity(entry));
  }
  if (!isRecord(value)) {
    return value;
  }
  const picked = pickIdentityFields(value);
  for (const [key, entry] of Object.entries(value)) {
    if (key in picked) {
      continue;
    }
    if (Array.isArray(entry) && entry.some((row) => isRecord(row))) {
      picked[key] = compactIdentity(entry);
    }
  }
  return picked;
}

function clipUnknown(value: unknown): { preview: unknown; omitted: number } {
  if (Array.isArray(value)) {
    const extra = Math.max(0, value.length - STAFF_ASSISTANT_CLIP_ARRAY_MAX);
    const kept =
      extra > 0 ? value.slice(0, STAFF_ASSISTANT_CLIP_ARRAY_MAX) : value;
    let omitted = extra;
    const preview: unknown[] = [];
    for (const entry of kept) {
      const clipped = clipUnknown(entry);
      preview.push(clipped.preview);
      omitted += clipped.omitted;
    }
    return { preview, omitted };
  }
  if (isRecord(value)) {
    const preview: Record<string, unknown> = {};
    let omitted = 0;
    for (const [key, entry] of Object.entries(value)) {
      const clipped = clipUnknown(entry);
      preview[key] = clipped.preview;
      omitted += clipped.omitted;
    }
    return { preview, omitted };
  }
  return { preview: value, omitted: 0 };
}

function shrinkRow(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const identity = pickIdentityFields(value);
  if (Object.keys(identity).length > 0) {
    return identity;
  }
  return value;
}

export function shrinkStaffAssistantTracePreview(value: unknown): unknown {
  return shrinkPreview(value);
}

export function compactStaffAssistantTraceIdentity(value: unknown): unknown {
  return compactIdentity(value);
}

function shrinkPreview(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .slice(0, STAFF_ASSISTANT_CLIP_SHRINK_ARRAY_MAX)
      .map((entry) => shrinkRow(entry));
  }
  if (!isRecord(value)) {
    return value;
  }
  const shrunk: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (IDENTITY_KEY_SET.has(key)) {
      shrunk[key] = entry;
      continue;
    }
    if (Array.isArray(entry)) {
      shrunk[key] = entry
        .slice(0, STAFF_ASSISTANT_CLIP_SHRINK_ARRAY_MAX)
        .map((row) => shrinkRow(row));
      continue;
    }
    if (isRecord(entry)) {
      shrunk[key] = shrinkRow(entry);
      continue;
    }
    if (
      typeof entry === "number" ||
      typeof entry === "boolean" ||
      entry === null
    ) {
      shrunk[key] = entry;
    }
  }
  return shrunk;
}

export function clipStaffAssistantToolResult(output: unknown): unknown {
  if (
    isStaffAssistantConfirmationOutput(output) ||
    isStaffAssistantNeedsChoiceOutput(output) ||
    isTypedToolError(output)
  ) {
    return output;
  }

  const clipped = clipUnknown(output);
  let preview = clipped.preview;
  let omitted = clipped.omitted;

  if (jsonLength(preview) > STAFF_ASSISTANT_CLIP_JSON_MAX) {
    preview = shrinkStaffAssistantTracePreview(preview);
    omitted = Math.max(omitted, 1);
  }
  if (jsonLength(preview) > STAFF_ASSISTANT_CLIP_JSON_MAX) {
    preview = compactStaffAssistantTraceIdentity(preview);
    omitted = Math.max(omitted, 1);
  }

  if (omitted === 0) {
    return output;
  }

  return {
    status: STAFF_ASSISTANT_CLIPPED_STATUS,
    preview,
    omitted,
  };
}
