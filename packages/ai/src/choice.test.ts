import { CONFIRMATION_TTL_MS } from "@showzy/core";
import { ConflictError } from "@showzy/core/errors";
import {
  CREATE_ORDER_COMMENT_MAX,
  createOrderInputSchema,
} from "@showzy/orders/contract";
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  applyChoiceOptionToCanonicalInput,
  assistantChoiceBodySchema,
  assistantChoiceInteractionResultSchema,
  bindChoiceOptions,
  catalogDomainErrorExtrasFromError,
  catalogDomainErrorExtrasFromToolOutput,
  catalogPickerConflictExtrasFromError,
  CHOICE_DOMAIN_ERROR_REASONS,
  CHOICE_OPTIONS_MAX,
  CHOICE_PICKER_REASONS,
  CHOICE_RESOLUTION_REASONS,
  CHOICE_TTL_MS,
  choiceCanonicalCreateInputSchema,
  choiceCardEnvelope,
  choiceRedisKey,
  needsChoiceFromOrdersCreateConflict,
  parseChoiceRecord,
  peekEnvelopeFromRecord,
  serializeChoiceRecord,
  staffAssistantChoiceCardEnvelopeSchema,
  staffAssistantNeedsChoiceOutputSchema,
  successorChoiceId,
  type ChoiceCanonicalCreateInput,
  type ChoiceRecord,
} from "./choice.js";

const conversationId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const choiceId = "33333333-3333-4333-8333-333333333333";
const productId = "44444444-4444-4444-8444-444444444444";
const variantLemon = "55555555-5555-4555-8555-555555555555";
const variantVanilla = "66666666-6666-4666-8666-666666666666";
const customerId = "77777777-7777-4777-8777-777777777777";
const optionLemon = "88888888-8888-4888-8888-888888888888";
const optionVanilla = "99999999-9999-4999-8999-999999999999";

const canonical: ChoiceCanonicalCreateInput = {
  customer: { by: "id", id: customerId },
  items: [
    {
      product: { by: "id", id: productId },
      variantSelection: { kind: "unspecified" },
      quantity: { milli: "1000" },
    },
  ],
};

function sampleRecord(status: ChoiceRecord["status"] = "open"): ChoiceRecord {
  return {
    status,
    choiceId,
    actorId: "anna",
    companyId,
    conversationId,
    canonicalInput: canonical,
    target: {
      lineIndex: 0,
      productId,
      productName: "Macarons",
    },
    optionMap: {
      [optionLemon]: variantLemon,
      [optionVanilla]: variantVanilla,
    },
    envelope: {
      status: "needs_choice",
      challengeId: choiceId,
      reason: "variant_required",
      productName: "Macarons",
      options: [
        { id: optionLemon, label: "Lemon" },
        { id: optionVanilla, label: "Vanilla" },
      ],
      optionsTruncated: false,
    },
    ...(status === "claimed" || status === "completed"
      ? { claimedOptionId: optionLemon }
      : {}),
  };
}

describe("choice transport (SHO-409)", () => {
  it("uses a 15-minute TTL longer than confirmation's 5 minutes", () => {
    expect(CHOICE_TTL_MS).toBe(15 * 60 * 1000);
    expect(CHOICE_TTL_MS).toBeGreaterThan(CONFIRMATION_TTL_MS);
    expect(CONFIRMATION_TTL_MS).toBe(5 * 60 * 1000);
    expect(CHOICE_OPTIONS_MAX).toBe(20);
  });

  it("names Redis keys choice:{choiceId}", () => {
    expect(choiceRedisKey(choiceId)).toBe(`choice:${choiceId}`);
  });

  it("rejects extra client fields on the resume body", () => {
    const parsed = assistantChoiceBodySchema.safeParse({
      conversationId,
      choiceId,
      optionId: optionLemon,
      target: { lineIndex: 9, productId, productName: "tamper" },
      variantId: variantLemon,
      slot: "line-0",
    });
    expect(parsed.success).toBe(false);
    expect(
      assistantChoiceBodySchema.parse({
        conversationId,
        choiceId,
        optionId: optionLemon,
      }),
    ).toEqual({
      conversationId,
      choiceId,
      optionId: optionLemon,
    });
  });

  it("mints opaque option ids and keeps variant ids only in the map", () => {
    const bound = bindChoiceOptions(
      [
        { id: variantLemon, label: "Lemon" },
        { id: variantVanilla, label: "Vanilla" },
      ],
      false,
      (() => {
        let n = 0;
        return () => {
          n += 1;
          return n === 1 ? optionLemon : optionVanilla;
        };
      })(),
    );
    expect(bound.options.map((option) => option.id)).toEqual([
      optionLemon,
      optionVanilla,
    ]);
    expect(bound.optionMap[optionLemon]).toBe(variantLemon);
    expect(JSON.stringify(bound.options)).not.toContain(variantLemon);
  });

  it("forwards catalog optionsTruncated when the list is at or below the cap", () => {
    const two = bindChoiceOptions(
      [
        { id: variantLemon, label: "Lemon" },
        { id: variantVanilla, label: "Vanilla" },
      ],
      true,
    );
    expect(two.options).toHaveLength(2);
    expect(two.optionsTruncated).toBe(true);
    const twentyIds = Array.from({ length: CHOICE_OPTIONS_MAX }, (_, index) => {
      const suffix = String(index).padStart(12, "0");
      return {
        id: `55555555-5555-4555-8555-${suffix}`,
        label: `V${String(index)}`,
      };
    });
    const twenty = bindChoiceOptions(twentyIds, true);
    expect(twenty.options).toHaveLength(CHOICE_OPTIONS_MAX);
    expect(twenty.optionsTruncated).toBe(true);
    expect(
      bindChoiceOptions(
        [
          { id: variantLemon, label: "Lemon" },
          { id: variantVanilla, label: "Vanilla" },
        ],
        false,
      ).optionsTruncated,
    ).toBe(false);
  });

  it("patches the server target line and ignores a leftover variant field", () => {
    const withLegacyVariant: ChoiceCanonicalCreateInput = {
      customer: canonical.customer,
      items: [
        {
          product: { by: "id", id: productId },
          variant: { by: "query", value: "client-slot" },
          variantSelection: { kind: "unspecified" },
          quantity: { milli: "1000" },
        },
        {
          product: { by: "query", value: "Other" },
          variantSelection: { kind: "unspecified" },
          quantity: { decimal: "2" },
        },
      ],
    };
    const patched = applyChoiceOptionToCanonicalInput(
      withLegacyVariant,
      {
        lineIndex: 0,
        productId,
        productName: "Macarons",
      },
      variantLemon,
    );
    expect(patched.items[0]).toEqual({
      product: { by: "id", id: productId },
      quantity: { milli: "1000" },
      variantSelection: {
        kind: "reference",
        ref: { by: "id", id: variantLemon },
      },
    });
    expect(patched.items[0]).not.toHaveProperty("variant");
    expect(patched.items[1]).toEqual(withLegacyVariant.items[1]);
  });

  it("patches a customer or product target without stripping later variant selection", () => {
    const input: ChoiceCanonicalCreateInput = {
      customer: { by: "query", value: "Katya" },
      items: [
        {
          product: { by: "query", value: "макаронс" },
          variantSelection: { kind: "unspecified" },
          quantity: { milli: "1000" },
        },
      ],
    };
    const afterCustomer = applyChoiceOptionToCanonicalInput(
      input,
      { kind: "customer", query: "Katya" },
      customerId,
    );
    expect(afterCustomer.customer).toEqual({ by: "id", id: customerId });
    expect(afterCustomer.items).toEqual(input.items);
    const afterProduct = applyChoiceOptionToCanonicalInput(
      afterCustomer,
      {
        kind: "order_line_product",
        lineIndex: 0,
        query: "макаронс",
      },
      productId,
    );
    expect(afterProduct.items[0]).toEqual({
      product: { by: "id", id: productId },
      quantity: { milli: "1000" },
      variantSelection: { kind: "unspecified" },
    });
  });

  it("peek envelope omits canonical input, target, mapping, actor, and company", () => {
    const envelope = peekEnvelopeFromRecord(sampleRecord("open"));
    expect(envelope).toEqual({
      status: "needs_choice",
      challengeId: choiceId,
      reason: "variant_required",
      productName: "Macarons",
      options: [
        { id: optionLemon, label: "Lemon" },
        { id: optionVanilla, label: "Vanilla" },
      ],
      optionsTruncated: false,
    });
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain("canonicalInput");
    expect(serialized).not.toContain("lineIndex");
    expect(serialized).not.toContain(productId);
    expect(serialized).not.toContain(variantLemon);
    expect(serialized).not.toContain("optionMap");
    expect(serialized).not.toContain("actorId");
    expect(serialized).not.toContain(companyId);
    expect(
      staffAssistantChoiceCardEnvelopeSchema.safeParse({
        ...envelope,
        target: { lineIndex: 0, productId, productName: "Macarons" },
      }).success,
    ).toBe(false);
  });

  it("claimed peek includes only the opaque claimedOptionId, not a variant id", () => {
    const envelope = peekEnvelopeFromRecord(sampleRecord("claimed"));
    expect(envelope.status).toBe("claimed");
    expect(envelope.claimedOptionId).toBe(optionLemon);
    expect(envelope.options.map((option) => option.id)).toContain(optionLemon);
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain("canonicalInput");
    expect(serialized).not.toContain("lineIndex");
    expect(serialized).not.toContain(productId);
    expect(serialized).not.toContain(variantLemon);
    expect(serialized).not.toContain(variantVanilla);
    expect(serialized).not.toContain("optionMap");
    expect(serialized).not.toContain("actorId");
    expect(serialized).not.toContain(companyId);
    expect(envelope.claimedOptionId).not.toBe(variantLemon);
  });

  it("completed peek is not a claimed recovery envelope", () => {
    const envelope = peekEnvelopeFromRecord(sampleRecord("completed"));
    expect(envelope.status).toBe("completed");
    expect(envelope.claimedOptionId).toBeUndefined();
  });

  it("reuses createOrderInputSchema as the stored canonical input (SHO-422)", () => {
    expect(choiceCanonicalCreateInputSchema).toBe(createOrderInputSchema);

    const canonicalInput = createOrderInputSchema.parse({
      customer: { by: "id", id: customerId },
      items: [
        {
          product: { by: "id", id: productId },
          variantSelection: { kind: "unspecified" },
          quantity: { milli: "1000" },
        },
      ],
      comment: "c".repeat(CREATE_ORDER_COMMENT_MAX),
    });
    const raw = serializeChoiceRecord({
      ...sampleRecord("open"),
      canonicalInput,
    });
    expect(parseChoiceRecord(raw)?.canonicalInput).toEqual(canonicalInput);

    expect(
      parseChoiceRecord(
        JSON.stringify({
          ...sampleRecord("open"),
          canonicalInput: {
            ...canonical,
            comment: "c".repeat(CREATE_ORDER_COMMENT_MAX + 1),
          },
        }),
      ),
    ).toBeUndefined();
    expect(
      parseChoiceRecord(
        JSON.stringify({
          ...sampleRecord("open"),
          canonicalInput: {
            customer: canonical.customer,
            items: [
              {
                product: { by: "id", id: productId },
                variantSelection: { kind: "unspecified" },
                quantity: { milli: "not-a-quantity" },
              },
            ],
          },
        }),
      ),
    ).toBeUndefined();
  });

  it("does not keep duplicated contract copies in packages/ai/src (SHO-422)", () => {
    const srcRoot = dirname(fileURLToPath(import.meta.url));
    const files = readdirSync(srcRoot, { recursive: true, encoding: "utf8" });
    const duplicatedPrefix = "Duplicated ";
    const needles = [`${duplicatedPrefix}so`, `${duplicatedPrefix}from`];
    const hits: string[] = [];
    for (const file of files) {
      if (!file.endsWith(".ts")) {
        continue;
      }
      const source = readFileSync(join(srcRoot, file), "utf8");
      if (needles.some((needle) => source.includes(needle))) {
        hits.push(file);
      }
    }
    expect(hits).toEqual([]);
  });

  it("round-trips a stored record and derives a stable successor id", () => {
    const raw = serializeChoiceRecord(sampleRecord("claimed"));
    expect(parseChoiceRecord(raw)?.choiceId).toBe(choiceId);
    expect(successorChoiceId(choiceId)).toBe(successorChoiceId(choiceId));
    expect(successorChoiceId(choiceId)).not.toBe(choiceId);
    expect(
      choiceCardEnvelope({
        challengeId: choiceId,
        status: "expired",
        options: [
          { id: optionLemon, label: "Lemon" },
          { id: optionVanilla, label: "Vanilla" },
        ],
        optionsTruncated: false,
      }).status,
    ).toBe("expired");
  });

  it("refuses to construct an envelope or needs_choice output with empty options", () => {
    expect(
      staffAssistantChoiceCardEnvelopeSchema.safeParse({
        status: "needs_choice",
        challengeId: choiceId,
        reason: "variant_required",
        productName: "Macarons",
        options: [],
        optionsTruncated: false,
      }).success,
    ).toBe(false);
    expect(
      staffAssistantNeedsChoiceOutputSchema.safeParse({
        status: "needs_choice",
        challengeId: choiceId,
        reason: "variant_required",
        productName: "Macarons",
        options: [],
        optionsTruncated: false,
      }).success,
    ).toBe(false);
    expect(() =>
      choiceCardEnvelope({
        challengeId: choiceId,
        status: "needs_choice",
        reason: "variant_required",
        productName: "Macarons",
        options: [],
        optionsTruncated: false,
      }),
    ).toThrow();
  });

  it("requires presenter text on the sequential needs_choice interaction result", () => {
    const view = {
      status: "needs_choice" as const,
      challengeId: choiceId,
      reason: "variant_required" as const,
      productName: "Еклери",
      options: [
        { id: optionLemon, label: "Кава" },
        { id: optionVanilla, label: "Шоколад" },
      ],
      optionsTruncated: false,
    };
    expect(staffAssistantNeedsChoiceOutputSchema.safeParse(view).success).toBe(
      true,
    );
    expect(assistantChoiceInteractionResultSchema.safeParse(view).success).toBe(
      false,
    );
    const presented = "Оберіть варіант для Еклери: Кава, Шоколад.";
    const parsed = assistantChoiceInteractionResultSchema.parse({
      ...view,
      text: presented,
    });
    expect(parsed).toMatchObject({ status: "needs_choice", text: presented });
    if (parsed.status !== "needs_choice") {
      return;
    }
    expect(parsed.text).toBe(presented);
    expect(parsed.productName).toBe("Еклери");
    expect(parsed.options.map((option) => option.label)).toEqual([
      "Кава",
      "Шоколад",
    ]);
    expect(JSON.stringify(parsed)).not.toContain("canonicalInput");
    expect(JSON.stringify(parsed)).not.toContain("optionMap");
    expect(JSON.stringify(parsed)).not.toContain(productId);
  });
});

class DuckTypedPickerConflict extends ConflictError {
  readonly reason: string;
  readonly target: {
    readonly kind: "order_line_variant";
    readonly lineIndex: number;
    readonly productId: string;
    readonly productName: string;
  };
  readonly options: readonly { readonly id: string; readonly label: string }[];
  readonly optionsTruncated: boolean;

  constructor(args: {
    readonly reason: string;
    readonly options: readonly {
      readonly id: string;
      readonly label: string;
    }[];
    readonly optionsTruncated?: boolean;
  }) {
    super('Select a variant for "Macarons".');
    this.reason = args.reason;
    this.target = {
      kind: "order_line_variant",
      lineIndex: 0,
      productId,
      productName: "Macarons",
    };
    this.options = args.options;
    this.optionsTruncated = args.optionsTruncated ?? false;
  }
}

class DuckTypedArchivedConflict extends ConflictError {
  readonly reason = "archived" as const;
  readonly target: {
    readonly kind: "order_line_product";
    readonly lineIndex: number;
    readonly query: string;
    readonly productName?: string;
  };
  readonly options: readonly { readonly id: string; readonly label: string }[];
  readonly optionsTruncated = false;

  constructor(args: {
    readonly query?: string;
    readonly productName?: string;
    readonly options?: readonly {
      readonly id: string;
      readonly label: string;
    }[];
  }) {
    super(
      args.productName !== undefined
        ? `"${args.productName}" is archived.`
        : `No active product matched "${args.query ?? "cupcake"}"; matching products are archived.`,
    );
    this.target =
      args.productName === undefined
        ? {
            kind: "order_line_product",
            lineIndex: 0,
            query: args.query ?? "cupcake",
          }
        : {
            kind: "order_line_product",
            lineIndex: 0,
            query: args.query ?? args.productName,
            productName: args.productName,
          };
    this.options = args.options ?? [];
  }
}

describe("duck-typed catalog CONFLICT extras (SHO-418)", () => {
  it("does not import catalog, customers, a module barrel, or @showzy/db", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "choice.ts"),
      "utf8",
    );
    expect(source).not.toContain("@showzy/catalog");
    expect(source).not.toContain("@showzy/customers");
    expect(source).not.toMatch(/from ["']@showzy\/orders["']/);
    expect(source).not.toContain("@showzy/db");
    expect(source).toContain('from "@showzy/orders/contract"');
  });

  it("parses picker extras and ignores no_active_variants", () => {
    const picker = new DuckTypedPickerConflict({
      reason: "variant_required",
      options: [
        { id: variantLemon, label: "Lemon" },
        { id: variantVanilla, label: "Vanilla" },
      ],
    });
    expect(catalogPickerConflictExtrasFromError(picker)?.reason).toBe(
      "variant_required",
    );
    expect(
      catalogPickerConflictExtrasFromError(
        new DuckTypedPickerConflict({
          reason: "no_active_variants",
          options: [],
        }),
      ),
    ).toBeUndefined();
    expect(
      catalogPickerConflictExtrasFromError(
        new DuckTypedArchivedConflict({
          productName: "Old Widget",
          options: [{ id: variantLemon, label: "Old Widget" }],
        }),
      ),
    ).toBeUndefined();
    expect(
      catalogPickerConflictExtrasFromError(
        new DuckTypedArchivedConflict({
          productName: "Old Widget",
          options: [],
        }),
      ),
    ).toBeUndefined();
    expect(
      catalogPickerConflictExtrasFromError(new ConflictError("plain conflict")),
    ).toBeUndefined();
  });

  it("façade extras predicate agrees on every CHOICE_RESOLUTION_REASONS value", () => {
    const lemon = [{ id: variantLemon, label: "Lemon" }];
    for (const reason of CHOICE_RESOLUTION_REASONS) {
      const withOptions = catalogPickerConflictExtrasFromError(
        new DuckTypedPickerConflict({ reason, options: lemon }),
      );
      const empty = catalogPickerConflictExtrasFromError(
        new DuckTypedPickerConflict({ reason, options: [] }),
      );
      const isPicker = (CHOICE_PICKER_REASONS as readonly string[]).includes(
        reason,
      );
      expect({
        reason,
        extras: withOptions !== undefined,
      }).toEqual({ reason, extras: isPicker });
      expect(empty).toBeUndefined();
    }
    expect(CHOICE_RESOLUTION_REASONS).toEqual([
      "variant_required",
      "ambiguous",
      "unmatched_query",
      "no_active_variants",
      "archived",
    ]);
    expect(CHOICE_PICKER_REASONS).not.toContain("archived");
    expect(CHOICE_PICKER_REASONS).not.toContain("no_active_variants");
    expect(CHOICE_DOMAIN_ERROR_REASONS).toEqual([
      "archived",
      "no_active_variants",
    ]);
  });

  it("opens needs_choice from orders.create CONFLICT and skips empty options", async () => {
    const opened: ChoiceRecord[] = [];
    const output = await needsChoiceFromOrdersCreateConflict({
      actionName: "orders.create",
      input: canonical,
      error: new DuckTypedPickerConflict({
        reason: "ambiguous",
        options: [{ id: variantLemon, label: "Lemon" }],
      }),
      bind: {
        actorId: "anna",
        companyId,
        conversationId,
      },
      openChoice: (record) => {
        opened.push(record);
        return Promise.resolve(true);
      },
      mintChoiceId: () => choiceId,
    });
    expect(output?.status).toBe("needs_choice");
    expect(output?.choiceKind).toBe("variant");
    expect(output?.options).toHaveLength(1);
    expect(opened).toHaveLength(1);
    expect(JSON.stringify(output)).not.toContain("canonicalInput");
    expect(JSON.stringify(output)).not.toContain(productId);

    const empty = await needsChoiceFromOrdersCreateConflict({
      actionName: "orders.create",
      input: canonical,
      error: new DuckTypedPickerConflict({
        reason: "no_active_variants",
        options: [],
      }),
      bind: {
        actorId: "anna",
        companyId,
        conversationId,
      },
      openChoice: () => Promise.resolve(true),
    });
    expect(empty).toBeUndefined();
  });

  it("keeps optionsTruncated true on a short picker list", async () => {
    const output = await needsChoiceFromOrdersCreateConflict({
      actionName: "orders.create",
      input: canonical,
      error: new DuckTypedPickerConflict({
        reason: "variant_required",
        options: [
          { id: variantLemon, label: "Lemon" },
          { id: variantVanilla, label: "Vanilla" },
        ],
        optionsTruncated: true,
      }),
      mintChoiceId: () => choiceId,
    });
    expect(output?.options).toHaveLength(2);
    expect(output?.optionsTruncated).toBe(true);
  });

  it("returns undefined when openChoice SET NX fails", async () => {
    const opened: ChoiceRecord[] = [];
    const output = await needsChoiceFromOrdersCreateConflict({
      actionName: "orders.create",
      input: canonical,
      error: new DuckTypedPickerConflict({
        reason: "variant_required",
        options: [{ id: variantLemon, label: "Lemon" }],
      }),
      bind: {
        actorId: "anna",
        companyId,
        conversationId,
      },
      openChoice: (record) => {
        opened.push(record);
        return Promise.resolve(false);
      },
      mintChoiceId: () => choiceId,
    });
    expect(opened).toHaveLength(1);
    expect(output).toBeUndefined();
  });

  it("ignores archived extras for needs_choice even when options are present", async () => {
    const output = await needsChoiceFromOrdersCreateConflict({
      actionName: "orders.create",
      input: canonical,
      error: new DuckTypedArchivedConflict({
        productName: "Old Widget",
        options: [{ id: variantLemon, label: "Old Widget" }],
      }),
      bind: {
        actorId: "anna",
        companyId,
        conversationId,
      },
      openChoice: () => Promise.resolve(true),
    });
    expect(output).toBeUndefined();
  });
});

describe("duck-typed catalog domain-error extras (SHO-442)", () => {
  it("parses a unique archived product name and a multi-match query", () => {
    expect(
      catalogDomainErrorExtrasFromError(
        new DuckTypedArchivedConflict({ productName: "Old Widget" }),
      ),
    ).toEqual({
      reason: "archived",
      subject: { kind: "product_name", name: "Old Widget" },
    });
    expect(
      catalogDomainErrorExtrasFromError(
        new DuckTypedArchivedConflict({ query: "ZzzArchiveTwin" }),
      ),
    ).toEqual({
      reason: "archived",
      subject: { kind: "query", query: "ZzzArchiveTwin" },
    });
  });

  it("parses no_active_variants from a variant target productName", () => {
    expect(
      catalogDomainErrorExtrasFromError(
        new DuckTypedPickerConflict({
          reason: "no_active_variants",
          options: [],
        }),
      ),
    ).toEqual({
      reason: "no_active_variants",
      subject: { kind: "product_name", name: "Macarons" },
    });
  });

  it("does not classify archived from English clientMessage or a variant target", () => {
    expect(
      catalogDomainErrorExtrasFromError(
        new ConflictError('"Cupcake" is archived.'),
      ),
    ).toBeUndefined();
    expect(
      catalogDomainErrorExtrasFromError(
        new DuckTypedPickerConflict({
          reason: "archived",
          options: [],
        }),
      ),
    ).toBeUndefined();
    expect(
      catalogDomainErrorExtrasFromError(
        new DuckTypedPickerConflict({
          reason: "variant_required",
          options: [{ id: variantLemon, label: "Lemon" }],
        }),
      ),
    ).toBeUndefined();
  });

  it("rejects malformed domain-error metadata instead of fabricating a subject", () => {
    class MissingQueryArchived extends ConflictError {
      readonly reason = "archived" as const;
      readonly target = {
        kind: "order_line_product" as const,
        lineIndex: 0,
      };
    }
    class QueryNoActiveVariants extends ConflictError {
      readonly reason = "no_active_variants" as const;
      readonly target = {
        kind: "order_line_product" as const,
        lineIndex: 0,
        query: "Macarons",
      };
    }
    expect(
      catalogDomainErrorExtrasFromError(new MissingQueryArchived("archived")),
    ).toBeUndefined();
    expect(
      catalogDomainErrorExtrasFromError(
        new QueryNoActiveVariants("no variants"),
      ),
    ).toBeUndefined();
    expect(
      catalogDomainErrorExtrasFromToolOutput({
        status: "error",
        code: "CONFLICT",
        message: '"Cupcake" is archived.',
      }),
    ).toBeUndefined();
    expect(
      catalogDomainErrorExtrasFromToolOutput({
        status: "error",
        code: "CONFLICT",
        message: "nope",
        reason: "archived",
        subject: { kind: "query" },
      }),
    ).toBeUndefined();
  });
});

class DuckTypedProductConflict extends ConflictError {
  readonly reason = "ambiguous" as const;
  readonly target: {
    readonly kind: "order_line_product";
    readonly lineIndex: number;
    readonly query: string;
  };
  readonly options: readonly { readonly id: string; readonly label: string }[];
  readonly optionsTruncated: boolean;

  constructor(args: {
    readonly query: string;
    readonly options: readonly {
      readonly id: string;
      readonly label: string;
    }[];
  }) {
    super(`Select a product matching "${args.query}".`);
    this.target = {
      kind: "order_line_product",
      lineIndex: 0,
      query: args.query,
    };
    this.options = args.options;
    this.optionsTruncated = false;
  }
}

class DuckTypedCustomerConflict extends ConflictError {
  readonly reason = "ambiguous" as const;
  readonly target: { readonly kind: "customer"; readonly query: string };
  readonly options: readonly { readonly id: string; readonly label: string }[];
  readonly optionsTruncated: boolean;

  constructor(args: {
    readonly query: string;
    readonly options: readonly {
      readonly id: string;
      readonly label: string;
    }[];
  }) {
    super(`Select a customer matching "${args.query}".`);
    this.target = { kind: "customer", query: args.query };
    this.options = args.options;
    this.optionsTruncated = false;
  }
}

describe("duck-typed product and customer CONFLICT extras (SHO-410)", () => {
  it("opens a one-option product ChoiceCard and never maps Multiple matches prose", async () => {
    const opened: ChoiceRecord[] = [];
    const output = await needsChoiceFromOrdersCreateConflict({
      actionName: "orders.create",
      input: {
        customer: { by: "id", id: customerId },
        items: [
          {
            product: { by: "query", value: "макаронс" },
            variantSelection: { kind: "unspecified" },
            quantity: { milli: "1000" },
          },
        ],
      },
      error: new DuckTypedProductConflict({
        query: "макаронс",
        options: [{ id: productId, label: "Макаронси" }],
      }),
      bind: {
        actorId: "anna",
        companyId,
        conversationId,
      },
      openChoice: (record) => {
        opened.push(record);
        return Promise.resolve(true);
      },
      mintChoiceId: () => choiceId,
    });
    expect(output?.status).toBe("needs_choice");
    expect(output?.choiceKind).toBe("product");
    expect(output?.reason).toBe("ambiguous");
    expect(output?.productName).toBe("макаронс");
    expect(output?.options).toHaveLength(1);
    expect(output?.options[0]?.label).toBe("Макаронси");
    expect(JSON.stringify(output)).not.toContain("Multiple matches");
    expect(JSON.stringify(output)).not.toContain(productId);
    expect(opened[0]?.target).toEqual({
      kind: "order_line_product",
      lineIndex: 0,
      query: "макаронс",
    });
  });

  it("opens a customer ChoiceCard from two matching names", async () => {
    const twinA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const twinB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const output = await needsChoiceFromOrdersCreateConflict({
      actionName: "orders.create",
      input: {
        customer: { by: "query", value: "Katya" },
        items: canonical.items,
      },
      error: new DuckTypedCustomerConflict({
        query: "Katya",
        options: [
          { id: twinA, label: "Katya (…2233)" },
          { id: twinB, label: "Katya (…5566)" },
        ],
      }),
      mintChoiceId: () => choiceId,
    });
    expect(output?.choiceKind).toBe("customer");
    expect(output?.productName).toBe("Katya");
    expect(output?.options).toHaveLength(2);
    expect(JSON.stringify(output)).not.toContain("Multiple matches");
    expect(JSON.stringify(output)).not.toContain(twinA);
  });
});
