import {
  ConflictError,
  CoreInvariantError,
  NotFoundError,
  PermissionDeniedError,
} from "@showzy/core/errors";
import { REFERENCE_CONFLICT_LABELS_MAX } from "@showzy/validation/entity-ref";
import { describe, expect, it } from "vitest";

import {
  ReferenceResolutionConflictError,
  archivedProductMessage,
  noActiveVariantsMessage,
  unmatchedVariantQueryMessage,
  variantRequiredMessage,
} from "../services/reference-resolution-conflict.js";
import { classifyExpectedLineResolutionFailure } from "../services/resolve-line-references.js";
import {
  RESOLVE_LINE_REFERENCES_MAX_LINES,
  VARIANT_AND_SELECTION_EXCLUSIVE_MESSAGE,
  VARIANT_SELECTION_OPTIONS_MAX,
  resolveLineReferencesContract,
} from "./resolve-line-references.contract.js";

const validId = "11111111-1111-4111-8111-111111111111";

describe("catalog.resolveLineReferences contract", () => {
  it("is a staff internal read with products:view", () => {
    expect(resolveLineReferencesContract.name).toBe(
      "catalog.resolveLineReferences",
    );
    expect(resolveLineReferencesContract.principal).toBe("staff");
    expect(resolveLineReferencesContract.transport).toBe("internal");
    expect(resolveLineReferencesContract.risk).toBe("read");
    expect(resolveLineReferencesContract.permissions).toEqual([
      "products:view",
    ]);
    expect(resolveLineReferencesContract.aiExposure).toBe("internal");
    expect(resolveLineReferencesContract.audit).toBe(false);
    expect(resolveLineReferencesContract.idempotent).toBe(false);
    expect(resolveLineReferencesContract.emits).toEqual([]);
    expect(resolveLineReferencesContract.timeout).toBe(5_000);
    expect(resolveLineReferencesContract.description).toContain(
      "Product query matches include active and archived rows",
    );
    expect(resolveLineReferencesContract.description).toContain(
      "Product and variant ids must be active",
    );
    expect(resolveLineReferencesContract.description).toContain(
      "reason archived, empty options",
    );
    expect(resolveLineReferencesContract.description).toContain(
      "earliest terminal failure by input lineIndex",
    );
    expect(RESOLVE_LINE_REFERENCES_MAX_LINES).toBe(100);
    expect(VARIANT_SELECTION_OPTIONS_MAX).toBe(20);
    expect(VARIANT_SELECTION_OPTIONS_MAX).toBeGreaterThan(6);
    expect(VARIANT_SELECTION_OPTIONS_MAX).not.toBe(
      REFERENCE_CONFLICT_LABELS_MAX,
    );
  });

  it("accepts 1–100 lines of EntityRef products and rejects extras", () => {
    expect(
      resolveLineReferencesContract.input.parse({
        lines: [{ product: { by: "id", id: validId } }],
      }),
    ).toEqual({
      lines: [{ product: { by: "id", id: validId } }],
    });
    expect(
      resolveLineReferencesContract.input.parse({
        lines: [
          {
            product: { by: "query", value: "  Coat  " },
            variant: { by: "query", value: "Red" },
          },
        ],
      }),
    ).toEqual({
      lines: [
        {
          product: { by: "query", value: "Coat" },
          variant: { by: "query", value: "Red" },
        },
      ],
    });
    expect(
      resolveLineReferencesContract.input.safeParse({ lines: [] }).success,
    ).toBe(false);
    expect(
      resolveLineReferencesContract.input.safeParse({
        lines: Array.from({ length: 101 }, () => ({
          product: { by: "id", id: validId },
        })),
      }).success,
    ).toBe(false);
    expect(
      resolveLineReferencesContract.input.safeParse({
        lines: [{ product: { by: "id", id: validId } }],
        companyId: validId,
      }).success,
    ).toBe(false);
  });

  it("accepts additive variantSelection and keeps legacy variant exclusive", () => {
    expect(
      resolveLineReferencesContract.input.parse({
        lines: [
          {
            product: { by: "id", id: validId },
            variantSelection: { kind: "unspecified" },
          },
          {
            product: { by: "id", id: validId },
            variantSelection: { kind: "base" },
          },
          {
            product: { by: "id", id: validId },
            variantSelection: {
              kind: "reference",
              ref: { by: "query", value: "  Lemon  " },
            },
          },
        ],
      }),
    ).toEqual({
      lines: [
        {
          product: { by: "id", id: validId },
          variantSelection: { kind: "unspecified" },
        },
        {
          product: { by: "id", id: validId },
          variantSelection: { kind: "base" },
        },
        {
          product: { by: "id", id: validId },
          variantSelection: {
            kind: "reference",
            ref: { by: "query", value: "Lemon" },
          },
        },
      ],
    });
    const both = resolveLineReferencesContract.input.safeParse({
      lines: [
        {
          product: { by: "id", id: validId },
          variant: { by: "id", id: validId },
          variantSelection: { kind: "base" },
        },
      ],
    });
    expect(both.success).toBe(false);
    if (both.success) {
      return;
    }
    expect(JSON.stringify(both.error.issues)).toContain(
      VARIANT_AND_SELECTION_EXCLUSIVE_MESSAGE,
    );
  });
});

describe("classifyExpectedLineResolutionFailure", () => {
  const productId = validId;

  it("treats not-found, archived, and no_active_variants as terminals", () => {
    const missing = new NotFoundError();
    expect(classifyExpectedLineResolutionFailure(missing)).toEqual({
      kind: "terminal",
      error: missing,
    });

    const archived = new ReferenceResolutionConflictError({
      reason: "archived",
      target: {
        kind: "order_line_product",
        lineIndex: 1,
        query: "Cupcake",
        productName: "Cupcake",
      },
      options: [],
      optionsTruncated: false,
      clientMessage: archivedProductMessage("Cupcake"),
    });
    expect(classifyExpectedLineResolutionFailure(archived)).toEqual({
      kind: "terminal",
      error: archived,
    });

    const noVariants = new ReferenceResolutionConflictError({
      reason: "no_active_variants",
      target: {
        kind: "order_line_variant",
        lineIndex: 2,
        productId,
        productName: "Retired Box",
      },
      options: [],
      optionsTruncated: false,
      clientMessage: noActiveVariantsMessage("Retired Box"),
    });
    expect(classifyExpectedLineResolutionFailure(noVariants)).toEqual({
      kind: "terminal",
      error: noVariants,
    });
  });

  it("treats variant_required, ambiguous, and unmatched_query as pickers", () => {
    const required = new ReferenceResolutionConflictError({
      reason: "variant_required",
      target: {
        kind: "order_line_variant",
        lineIndex: 0,
        productId,
        productName: "Macarons",
      },
      options: [{ id: productId, label: "Lemon" }],
      optionsTruncated: false,
      clientMessage: variantRequiredMessage("Macarons"),
    });
    expect(classifyExpectedLineResolutionFailure(required)).toEqual({
      kind: "picker",
      error: required,
    });

    const ambiguous = new ReferenceResolutionConflictError({
      reason: "ambiguous",
      target: {
        kind: "order_line_product",
        lineIndex: 0,
        query: "Twin",
      },
      options: [
        { id: productId, label: "Twin (UAH)" },
        { id: productId, label: "Twin (EUR)" },
      ],
      optionsTruncated: false,
      clientMessage: 'Select a product matching "Twin".',
    });
    expect(classifyExpectedLineResolutionFailure(ambiguous)).toEqual({
      kind: "picker",
      error: ambiguous,
    });

    const unmatched = new ReferenceResolutionConflictError({
      reason: "unmatched_query",
      target: {
        kind: "order_line_variant",
        lineIndex: 0,
        productId,
        productName: "Coat",
      },
      options: [{ id: productId, label: "Red" }],
      optionsTruncated: false,
      clientMessage: unmatchedVariantQueryMessage("Purple", "Coat"),
    });
    expect(classifyExpectedLineResolutionFailure(unmatched)).toEqual({
      kind: "picker",
      error: unmatched,
    });
  });

  it("does not classify invariant, authorization, or other conflicts", () => {
    expect(
      classifyExpectedLineResolutionFailure(
        new CoreInvariantError("catalog resolve test invariant"),
      ),
    ).toBeNull();
    expect(
      classifyExpectedLineResolutionFailure(new PermissionDeniedError()),
    ).toBeNull();
    expect(
      classifyExpectedLineResolutionFailure(
        new ConflictError("other conflict"),
      ),
    ).toBeNull();
    expect(
      classifyExpectedLineResolutionFailure(new TypeError("broken row")),
    ).toBeNull();
  });
});
