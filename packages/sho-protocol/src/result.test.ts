import { describe, expect, it } from "vitest";

import {
  SHO_RESULT_SCHEMA,
  SHO_UNRECOGNIZED,
  shoAsksDialogueModel,
  shoBlockingNeeds,
  shoCommandSchema,
  shoParamSchema,
  shoRefSchema,
  shoResultSchema,
} from "./result.js";

const confidence = { action: 0.98, margin: 0.9, certainty: 0.95, spans: 0.87 };

const command = (overrides: Record<string, unknown> = {}) => ({
  text: "додай 2 кави Софії",
  action: "orders.create",
  kind: "write",
  effect: "write",
  confirm: "card",
  params: {},
  needs: [],
  ready: true,
  catalogued: true,
  confidence,
  ...overrides,
});

const result = (overrides: Record<string, unknown> = {}) => ({
  schema: SHO_RESULT_SCHEMA,
  raw: "orders.create",
  text: "додай 2 кави Софії",
  segments: ["додай 2 кави Софії"],
  tooMany: false,
  commands: [command()],
  first: command(),
  context: { version: 2, revision: "rev-7" },
  ...overrides,
});

describe("shoResultSchema", () => {
  it("round-trips a v3.5-shaped result with every param kind", () => {
    const params = {
      customer: {
        text: "Софії",
        status: "resolved",
        id: "cus_1",
        name: "Софія Мельник",
        match: "form",
        confidence: 0.91,
      },
      contact: {
        text: "067 123 45 67",
        status: "unchecked",
        by: "phone",
        value: "0671234567",
      },
      items: [
        {
          product: {
            text: "кави",
            status: "resolved",
            id: "prd_1",
            name: "Кава",
          },
          attrs: [{ text: "250 г", variantIds: ["var_1"] }],
          variant: { status: "resolved", id: "var_1", name: "250 г" },
          quantity: {
            text: "2",
            said: ["2"],
            value: 2,
            unit: "pcs",
            unitText: null,
          },
        },
      ],
      variant: {
        status: "ambiguous",
        text: "чорна",
        attrs: [{ text: "чорна", variantIds: null }],
        candidates: [{ id: "var_2", name: "чорна 1 кг" }],
      },
      payment_method: {
        value: "mixed",
        parts: [{ method: "cash", minor: 50_000, currency: "UAH" }],
      },
      total: { text: "500 грн", value: { minor: 50_000, currency: "UAH" } },
      tax: ["single_tax", "military_levy"],
    };

    const parsed = shoResultSchema.parse(
      result({ commands: [command({ params })] }),
    );

    const only = parsed.commands[0];
    expect(only?.params["customer"]).toMatchObject({
      status: "resolved",
      name: "Софія Мельник",
    });
    expect(only?.params["contact"]).toMatchObject({
      by: "phone",
      value: "0671234567",
    });
    expect(only?.params["items"]).toHaveLength(1);
    expect(only?.params["variant"]).toMatchObject({
      status: "ambiguous",
      attrs: [{ text: "чорна", variantIds: null }],
    });
    expect(only?.params["payment_method"]).toMatchObject({ value: "mixed" });
    expect(only?.params["total"]).toMatchObject({ text: "500 грн" });
    expect(only?.params["tax"]).toEqual(["single_tax", "military_levy"]);
  });

  it("keeps the D95 blocking unparsed need", () => {
    const parsed = shoResultSchema.parse(
      result({
        commands: [
          command({
            ready: false,
            needs: [
              {
                path: "text",
                reason: "unparsed",
                blocking: true,
                span: { text: "і ще торт" },
              },
            ],
          }),
        ],
      }),
    );

    const only = parsed.commands[0];
    expect(only?.ready).toBe(false);
    expect(shoBlockingNeeds(only ?? parsed.first)).toHaveLength(1);
  });

  it("keeps the D97 how_to need and routes the turn to the dialogue model", () => {
    const parsed = shoCommandSchema.parse(
      command({
        action: "none",
        kind: "none",
        effect: "none",
        confirm: "none",
        confidence: { ...confidence, action: 0 },
        needs: [
          {
            path: "text",
            reason: "how_to",
            blocking: false,
            span: { text: "як мені додати товар" },
          },
        ],
      }),
    );

    expect(parsed.needs[0]?.reason).toBe("how_to");
    expect(shoAsksDialogueModel(parsed)).toBe(true);
    expect(shoBlockingNeeds(parsed)).toHaveLength(0);
  });

  it("maps an unknown action, kind, effect, confirmation and need reason to the unrecognized branch", () => {
    const parsed = shoCommandSchema.parse(
      command({
        action: "delivery.quoteFromTheFuture",
        kind: "telepathy",
        effect: "teleport",
        confirm: "wink",
        needs: [{ path: "action", reason: "newly_invented", blocking: true }],
      }),
    );

    expect(parsed.action).toBe("delivery.quoteFromTheFuture");
    expect(parsed.kind).toBe(SHO_UNRECOGNIZED);
    expect(parsed.effect).toBe(SHO_UNRECOGNIZED);
    expect(parsed.confirm).toBe(SHO_UNRECOGNIZED);
    expect(parsed.needs[0]?.reason).toBe(SHO_UNRECOGNIZED);
    expect(parsed.needs[0]?.blocking).toBe(true);
  });

  it("maps an unknown ref status, match and contact kind to the unrecognized branch", () => {
    const parsed = shoRefSchema.parse({
      text: "Софії",
      status: "half-resolved",
      match: "vibes",
      by: "telegram",
      value: "@sofia",
    });

    expect(parsed.status).toBe(SHO_UNRECOGNIZED);
    expect(parsed.match).toBe(SHO_UNRECOGNIZED);
    expect(parsed.by).toBe(SHO_UNRECOGNIZED);
    expect(parsed.value).toBe("@sofia");
  });

  it("reads a ref before a span param and a span param before an enum param", () => {
    expect(
      shoParamSchema.parse({ text: "Софії", status: "resolved", id: "cus_1" }),
    ).toMatchObject({ status: "resolved" });
    expect(shoParamSchema.parse({ text: "500 грн", value: "500" })).toEqual({
      text: "500 грн",
      value: "500",
    });
    expect(shoParamSchema.parse({ value: "cash" })).toEqual({ value: "cash" });
  });

  it("rejects a result whose required fields are missing", () => {
    expect(
      shoResultSchema.safeParse({ schema: SHO_RESULT_SCHEMA }).success,
    ).toBe(false);
    expect(
      shoCommandSchema.safeParse(command({ confidence: undefined })).success,
    ).toBe(false);
  });
});
