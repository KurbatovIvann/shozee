import { ConflictError } from "@showzy/core/errors";
import { describe, expect, it } from "vitest";

import {
  CHOICE_CREATE_OPTION_ID,
  EntityLookupConflictError,
  catalogPickerConflictExtrasFromError,
  catalogPickerConflictExtrasSchema,
} from "./choice.js";

const optionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("catalogPickerConflictExtrasSchema", () => {
  it("accepts a picker whose only answerable option is create", () => {
    const parsed = catalogPickerConflictExtrasSchema.safeParse({
      reason: "unmatched_query",
      target: { kind: "customer", query: "Катя" },
      options: [],
      optionsTruncated: false,
      create: { optionId: CHOICE_CREATE_OPTION_ID, label: 'Create "Катя"' },
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses a picker with neither record options nor a create option", () => {
    const parsed = catalogPickerConflictExtrasSchema.safeParse({
      reason: "unmatched_query",
      target: { kind: "customer", query: "Катя" },
      options: [],
      optionsTruncated: false,
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts record options with no create option", () => {
    const parsed = catalogPickerConflictExtrasSchema.safeParse({
      reason: "ambiguous",
      target: { kind: "customer", query: "Катя" },
      options: [{ id: optionId, label: "Катя Самбука (…1111)" }],
      optionsTruncated: false,
    });
    expect(parsed.success).toBe(true);
  });
});

describe("catalogPickerConflictExtrasFromError", () => {
  it("round-trips the create option off an EntityLookupConflictError", () => {
    const error = new EntityLookupConflictError({
      reason: "unmatched_query",
      target: { kind: "customer", query: "Катя" },
      options: [],
      optionsTruncated: false,
      create: { optionId: CHOICE_CREATE_OPTION_ID, label: 'Create "Катя"' },
      clientMessage: 'Nothing matches "Катя".',
    });
    expect(catalogPickerConflictExtrasFromError(error)).toEqual({
      reason: "unmatched_query",
      target: { kind: "customer", query: "Катя" },
      options: [],
      optionsTruncated: false,
      create: { optionId: CHOICE_CREATE_OPTION_ID, label: 'Create "Катя"' },
    });
  });

  it("omits create when the picker only offers records", () => {
    const error = new EntityLookupConflictError({
      reason: "ambiguous",
      target: { kind: "customer", query: "Катя" },
      options: [{ id: optionId, label: "Катя Самбука (…1111)" }],
      optionsTruncated: true,
      clientMessage: 'Select a customer matching "Катя".',
    });
    const extras = catalogPickerConflictExtrasFromError(error);
    expect(extras?.create).toBeUndefined();
    expect(extras?.target).toEqual({ kind: "customer", query: "Катя" });
    expect(extras?.optionsTruncated).toBe(true);
  });

  it("ignores a conflict that carries no picker", () => {
    expect(
      catalogPickerConflictExtrasFromError(new ConflictError("busy")),
    ).toBeUndefined();
  });
});
