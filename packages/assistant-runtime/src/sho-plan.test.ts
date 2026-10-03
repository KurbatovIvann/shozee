import {
  shoNeedSchema,
  shoRefSchema,
  shoResultSchema,
  type ShoRef,
  type ShoResult,
} from "@showzy/sho-protocol";
import { describe, expect, it } from "vitest";

import {
  createShoPlanner,
  shoLocatorFor,
  shoNeedRoute,
  shoWrites,
  SHO_ACTION_CONFIDENCE_FLOOR,
  type ShoActionPlanners,
} from "./sho-plan.js";
import type { ShoPlan } from "./sho-turn.js";

const NOW = new Date("2026-10-02T09:00:00.000Z");

interface RecordedNeed {
  readonly path: string;
  readonly reason: string;
  readonly blocking?: boolean;
}

interface Recorded {
  readonly text: string;
  readonly action: string;
  readonly kind?: string;
  readonly effect?: string;
  readonly confirm?: string;
  readonly confidence?: number;
  readonly needs?: readonly RecordedNeed[];
  readonly ready?: boolean;
  readonly refines?: string;
  readonly refPrevious?: Readonly<Record<string, number>>;
  readonly tooMany?: boolean;
  readonly commands?: number;
}

function resultOf(recorded: Recorded): ShoResult {
  const needs = (recorded.needs ?? []).map((need) => ({
    path: need.path,
    reason: need.reason,
    blocking: need.blocking ?? true,
  }));
  const command = {
    text: recorded.text,
    action: recorded.action,
    kind: recorded.kind ?? "read",
    effect: recorded.effect ?? "read",
    confirm: recorded.confirm ?? "none",
    params: {},
    needs,
    ready: recorded.ready ?? needs.length === 0,
    catalogued: true,
    confidence: {
      action: recorded.confidence ?? 0.99,
      margin: 0.8,
      certainty: 0.9,
      spans: 0.9,
    },
    refPrevious: recorded.refPrevious ?? {},
    ...(recorded.refines === undefined ? {} : { refines: recorded.refines }),
  };
  return shoResultSchema.parse({
    schema: "sho-result/2",
    raw: null,
    text: recorded.text,
    segments: [recorded.text],
    tooMany: recorded.tooMany ?? false,
    commands: Array.from({ length: recorded.commands ?? 1 }, () => command),
    first: command,
    context: { version: 1, revision: null },
  });
}

const readPlanner = (toolName: string): ShoActionPlanners[string] => ({
  writes: false,
  plan: (command): ShoPlan => ({
    kind: "call",
    toolName,
    input: { said: command.text },
    reply: "Ось вони.",
  }),
});

const writePlanner = (toolName: string): ShoActionPlanners[string] => ({
  writes: true,
  plan: (): ShoPlan => ({
    kind: "call",
    toolName,
    input: {},
    reply: "Готово.",
  }),
});

const READS: ShoActionPlanners = {
  "orders.list": readPlanner("orders_list_page"),
};

const planner = createShoPlanner({ actions: [], planners: READS });

const reasonOf = (plan: ShoPlan): string =>
  plan.kind === "fallback" ? plan.reason : `call:${plan.toolName}`;

describe("createShoPlanner routes to the dialogue model", () => {
  const cases: readonly (Recorded & { readonly expected: string })[] = [
    {
      text: "покажи замовлення за минулий тиждень і додай торт Каті",
      action: "orders.list",
      commands: 2,
      expected: "many_commands",
    },
    {
      text: "стільки всього сьогодні",
      action: "orders.list",
      tooMany: true,
      expected: "many_commands",
    },
    {
      text: "дякую, ти супер",
      action: "none",
      kind: "none",
      effect: "none",
      expected: "no_command",
    },
    {
      text: "Да давай",
      action: "ui.confirm",
      kind: "ui",
      effect: "ui",
      confidence: 0.998_012_580_028_933_4,
      expected: "ui_answer",
    },
    {
      text: "як мені скасувати замовлення?",
      action: "orders.cancel",
      kind: "write",
      effect: "write",
      confirm: "card",
      needs: [{ path: "action", reason: "how_to" }],
      expected: "needs_dialogue",
    },
    {
      text: "do you speak english",
      action: "orders.list",
      needs: [{ path: "action", reason: "language" }],
      expected: "needs_dialogue",
    },
    {
      text: "те саме для Олі",
      action: "orders.list",
      needs: [{ path: "customer", reason: "reference" }],
      expected: "blocking_need",
    },
    {
      text: "Ручку, стрілочку наверху. Создай мне.",
      action: "catalog.createProduct",
      kind: "write",
      effect: "write",
      confirm: "card",
      confidence: 0.995_626_421_921_109_8,
      needs: [{ path: "action", reason: "unsupported" }],
      expected: "unsupported_action",
    },
    {
      text: "ні, за вчора",
      action: "orders.list",
      refines: "orders.list",
      expected: "conversation_dependent",
    },
    {
      text: "і Петру теж",
      action: "orders.list",
      refPrevious: { customer: 0 },
      expected: "conversation_dependent",
    },
    {
      text: "Як мені скасувати чек, якщо клієнт передумав?",
      action: "delivery.cancelShipment",
      kind: "write",
      effect: "write",
      confirm: "card",
      confidence: 0.580_012_229_627_282_9,
      expected: "low_confidence",
    },
    {
      text: "створи замовлення для",
      action: "orders.create",
      kind: "write",
      effect: "write",
      confirm: "card",
      confidence: 0.967_752_702_323_826_4,
      needs: [{ path: "customer", reason: "missing" }],
      expected: "blocking_need",
    },
    {
      text: "додай два пончики",
      action: "orders.create",
      kind: "write",
      effect: "write",
      confirm: "card",
      ready: false,
      expected: "blocking_need",
    },
    {
      text: "знайди Катю",
      action: "orders.list",
      needs: [{ path: "action", reason: "read_as_find" }],
      expected: "blocking_need",
    },
    {
      text: "покажи замовлення Каті",
      action: "orders.list",
      kind: "mystery",
      expected: "unrecognized_shape",
    },
    {
      text: "покажи замовлення за минулий тиждень",
      action: "orders.list",
      confidence: 0.993_636_731_542_415_7,
      expected: "not_whitelisted",
    },
  ];

  it.each(cases)("$text → $expected", (recorded) => {
    expect(reasonOf(planner(resultOf(recorded), NOW))).toBe(recorded.expected);
  });
});

describe("the SHO-740 wrong-write recordings never become a write", () => {
  const wrongWrites: readonly Recorded[] = [
    {
      text: "Замовлення Оксани я вже підтвердила ще зранку, не хвилюйся.",
      action: "orders.confirm",
      kind: "write",
      effect: "write",
      confirm: "card",
      confidence: 0.998_525_675_409_462_8,
    },
    {
      text: "Да давай",
      action: "ui.confirm",
      kind: "ui",
      effect: "ui",
      confidence: 0.998_012_580_028_933_4,
    },
    {
      text: "Ну давай роби",
      action: "ui.confirm",
      kind: "ui",
      effect: "ui",
      confidence: 0.997_823_911_824_797_6,
    },
    {
      text: "Ручку, стрілочку наверху. Создай мне.",
      action: "catalog.createProduct",
      kind: "write",
      effect: "write",
      confirm: "card",
      confidence: 0.995_626_421_921_109_8,
      needs: [{ path: "action", reason: "unsupported" }],
    },
    {
      text: "створи замовлення для",
      action: "orders.create",
      kind: "write",
      effect: "write",
      confirm: "card",
      confidence: 0.967_752_702_323_826_4,
      needs: [{ path: "customer", reason: "missing" }],
    },
    {
      text: "Кафе на углу треба виставити онлайн оплату на 2 800.",
      action: "orders.list",
      kind: "write",
      effect: "read",
      confidence: 0.995_999_219_067_958_9,
    },
    {
      text: "Надішли Каті Самбуці посилання на оплату. Сума 1350.",
      action: "payments.createLink",
      kind: "write",
      effect: "write",
      confirm: "card",
      confidence: 0.994_811_485_733_253_2,
    },
    {
      text: "У замовленні 174 змінив варіант пончика з ванільного на карамельний.",
      action: "orders.update",
      kind: "write",
      effect: "write",
      confirm: "card",
      confidence: 0.988_988_058_625_949_3,
    },
    {
      text: "Як мені скасувати чек, якщо клієнт передумав?",
      action: "delivery.cancelShipment",
      kind: "write",
      effect: "write",
      confirm: "card",
      confidence: 0.580_012_229_627_282_9,
    },
    {
      text: "поставка Воленку оптовий прайс",
      action: "customers.updateGroup",
      kind: "write",
      effect: "write",
      confirm: "card",
      confidence: 0.998_524_963_083_388_7,
      needs: [{ path: "group", reason: "ambiguous" }],
    },
  ];

  const everyActionAsARead: ShoActionPlanners = Object.fromEntries(
    wrongWrites.map((recorded) => [
      recorded.action,
      readPlanner(`${recorded.action.replace(".", "_")}_tool`),
    ]),
  );

  it.each(wrongWrites)("$text falls through with no planner", (recorded) => {
    expect(planner(resultOf(recorded), NOW).kind).toBe("fallback");
  });

  it.each(wrongWrites)(
    "$text falls through even when its action is whitelisted as a read",
    (recorded) => {
      const whitelisted = createShoPlanner({
        actions: wrongWrites.map((row) => row.action),
        planners: everyActionAsARead,
      });
      expect(whitelisted(resultOf(recorded), NOW).kind).toBe("fallback");
    },
  );

  it("hands a write only to a planner that goes through the preview", () => {
    const seen: string[] = [];
    const whitelisted = createShoPlanner({
      actions: ["orders.confirm"],
      planners: {
        "orders.confirm": {
          writes: true,
          plan: (command): ShoPlan => {
            seen.push(command.action);
            return {
              kind: "call",
              toolName: "orders_confirm",
              input: {},
              reply: "Готово.",
            };
          },
        },
      },
    });
    const plan = whitelisted(
      resultOf({
        text: "підтверди замовлення 174",
        action: "orders.confirm",
        kind: "write",
        effect: "write",
        confirm: "card",
      }),
      NOW,
    );
    expect(plan).toMatchObject({ kind: "call", toolName: "orders_confirm" });
    expect(seen).toEqual(["orders.confirm"]);
  });
});

describe("the whitelist and the effect agreement", () => {
  const listed = (recorded: Recorded, planners: ShoActionPlanners): ShoPlan =>
    createShoPlanner({ actions: Object.keys(planners), planners })(
      resultOf(recorded),
      NOW,
    );

  it("plans a whitelisted read", () => {
    const plan = listed(
      { text: "покажи замовлення за тиждень", action: "orders.list" },
      READS,
    );
    expect(plan).toMatchObject({
      kind: "call",
      toolName: "orders_list_page",
      reply: "Ось вони.",
    });
  });

  it("refuses a registered planner the config does not list", () => {
    const plan = createShoPlanner({ actions: [], planners: READS })(
      resultOf({ text: "покажи замовлення", action: "orders.list" }),
      NOW,
    );
    expect(reasonOf(plan)).toBe("not_whitelisted");
  });

  it("refuses a listed action no planner implements", () => {
    const plan = createShoPlanner({
      actions: ["orders.count"],
      planners: READS,
    })(resultOf({ text: "скільки замовлень", action: "orders.count" }), NOW);
    expect(reasonOf(plan)).toBe("not_whitelisted");
  });

  it("refuses a read planner for a command Шо parsed as a write", () => {
    const plan = listed(
      {
        text: "підтверди замовлення 174",
        action: "orders.list",
        kind: "write",
        effect: "write",
        confirm: "card",
      },
      READS,
    );
    expect(reasonOf(plan)).toBe("effect_mismatch");
  });

  it("refuses a write planner for a command Шо parsed as a read", () => {
    const plan = listed(
      { text: "покажи замовлення", action: "orders.list" },
      { "orders.list": writePlanner("orders_confirm") },
    );
    expect(reasonOf(plan)).toBe("effect_mismatch");
  });

  it("refuses a read planner for a parse whose kind says write", () => {
    const plan = listed(
      {
        text: "Кафе на углу треба виставити онлайн оплату на 2 800.",
        action: "orders.list",
        kind: "write",
        effect: "read",
      },
      READS,
    );
    expect(reasonOf(plan)).toBe("effect_mismatch");
  });

  it("treats a high-stakes parse as a write however its effect reads", () => {
    expect(
      shoWrites(
        resultOf({
          text: "видали замовлення 174",
          action: "orders.cancel",
          kind: "high",
          effect: "read",
        }).first,
      ),
    ).toBe(true);
  });

  it("treats a confirmation Шо asks for as a write", () => {
    expect(
      shoWrites(
        resultOf({
          text: "познач як виконане",
          action: "orders.complete",
          kind: "write",
          effect: "read",
          confirm: "strong",
        }).first,
      ),
    ).toBe(true);
  });
});

describe("the calibrated floor", () => {
  const at = (confidence: number): ShoPlan =>
    createShoPlanner({ actions: ["orders.list"], planners: READS })(
      resultOf({
        text: "покажи замовлення",
        action: "orders.list",
        confidence,
      }),
      NOW,
    );

  it("plans at the floor", () => {
    expect(SHO_ACTION_CONFIDENCE_FLOOR).toBe(0.95);
    expect(at(SHO_ACTION_CONFIDENCE_FLOOR).kind).toBe("call");
  });

  it("falls through just below the floor", () => {
    expect(reasonOf(at(0.949_99))).toBe("low_confidence");
  });
});

describe("shoNeedRoute", () => {
  const needs: readonly (RecordedNeed & { readonly route: string })[] = [
    { path: "customer", reason: "ambiguous", route: "card" },
    { path: "product", reason: "unknown", route: "card" },
    { path: "customer", reason: "check_reference", route: "resolver" },
    { path: "customer", reason: "reference", route: "dialogue" },
    { path: "action", reason: "read_as_find", route: "dialogue" },
    { path: "action", reason: "language", route: "dialogue" },
    { path: "items.0.quantity", reason: "missing", route: "dialogue" },
    { path: "action", reason: "read_as_update", route: "dialogue" },
    { path: "action", reason: "unparsed", route: "dialogue" },
  ];

  it.each(needs)("$reason → $route", (need) => {
    expect(
      shoNeedRoute(
        shoNeedSchema.parse({
          path: need.path,
          reason: need.reason,
          blocking: true,
        }),
      ),
    ).toBe(need.route);
  });
});

describe("shoLocatorFor", () => {
  const ref = (fields: Readonly<Record<string, unknown>>): ShoRef =>
    shoRefSchema.parse(fields);

  it("takes a resolved id", () => {
    expect(
      shoLocatorFor(ref({ text: "Катя", status: "resolved", id: "c-1" })),
    ).toEqual({ kind: "locator", locator: { by: "id", id: "c-1" } });
  });

  it("sends an ambiguous name to the resolver so it opens the card", () => {
    expect(
      shoLocatorFor(
        ref({
          text: "Катя",
          status: "ambiguous",
          candidates: [
            { id: "c-1", name: "Катя Самбука" },
            { id: "c-2", name: "Катя Пончик" },
          ],
        }),
      ),
    ).toEqual({ kind: "locator", locator: { by: "query", value: "Катя" } });
  });

  it("sends an unknown name with nearest to the resolver", () => {
    expect(
      shoLocatorFor(
        ref({
          text: "Катерина",
          status: "unknown",
          nearest: [{ id: "c-1", name: "Катя Самбука", score: 0.7 }],
        }),
      ),
    ).toEqual({ kind: "locator", locator: { by: "query", value: "Катерина" } });
  });

  it("refuses a reference whose only offer is another action", () => {
    expect(
      shoLocatorFor(
        ref({
          text: "Катя",
          status: "unknown",
          suggest: { action: "customers.create", params: {} },
        }),
      ),
    ).toEqual({ kind: "fallback", reason: "unresolved_reference" });
  });

  it("refuses an unknown name with nothing to offer", () => {
    expect(shoLocatorFor(ref({ text: "хтось", status: "unknown" }))).toEqual({
      kind: "fallback",
      reason: "unresolved_reference",
    });
  });

  it("sends an unchecked phone through the customers resolver", () => {
    expect(
      shoLocatorFor(
        ref({
          text: "0931112233",
          status: "unchecked",
          by: "phone",
          value: "+380931112233",
        }),
      ),
    ).toEqual({
      kind: "locator",
      locator: { by: "query", value: "+380931112233" },
    });
  });

  it("sends an unchecked email through the customers resolver", () => {
    expect(
      shoLocatorFor(
        ref({ text: "melnyk@ukr.net", status: "unchecked", by: "email" }),
      ),
    ).toEqual({
      kind: "locator",
      locator: { by: "query", value: "melnyk@ukr.net" },
    });
  });

  it("refuses an unchecked reference that is neither phone nor email", () => {
    expect(
      shoLocatorFor(ref({ text: "той самий", status: "unchecked" })),
    ).toEqual({ kind: "fallback", reason: "unresolved_reference" });
  });

  it("takes the id the focus bound a reference word to", () => {
    expect(
      shoLocatorFor(
        ref({
          text: "неї",
          status: "context",
          id: "c-1",
          name: "Катя",
          focus: 0,
        }),
      ),
    ).toEqual({ kind: "locator", locator: { by: "id", id: "c-1" } });
  });

  it("refuses a focus binding the runtime gave no id", () => {
    expect(
      shoLocatorFor(ref({ text: "неї", status: "context", focus: 0 })),
    ).toEqual({ kind: "fallback", reason: "unresolved_reference" });
  });

  it("refuses a reference that only the conversation explains", () => {
    expect(shoLocatorFor(ref({ text: "йому", status: "previous" }))).toEqual({
      kind: "fallback",
      reason: "conversation_dependent",
    });
    expect(
      shoLocatorFor(ref({ text: "Катя", status: "resolved", focus: true })),
    ).toEqual({ kind: "fallback", reason: "conversation_dependent" });
  });

  it("refuses a resolved reference with no id", () => {
    expect(shoLocatorFor(ref({ text: "Катя", status: "resolved" }))).toEqual({
      kind: "fallback",
      reason: "unresolved_reference",
    });
  });
});
