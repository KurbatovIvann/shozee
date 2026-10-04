import type { ActionPipelineDeps } from "@showzy/core";
import { PermissionDeniedError } from "@showzy/core/errors";
import {
  shoCommandSchema,
  shoResultSchema,
  type ShoClient,
  type ShoCommand,
  type ShoParseInput,
  type ShoParseOutcome,
  type ShoResult,
} from "@showzy/sho-protocol";
import { describe, expect, it, vi } from "vitest";

import {
  createShoEngine,
  mountShoEngine,
  shoNowAt,
  type ShoEngineFor,
  type ShoMountConfig,
  type ShoPlanner,
} from "./sho-engine.js";
import type { ShoContextBuild } from "./sho-context.js";
import type { ShoContextSource } from "./sho-context-source.js";
import {
  cloneShoParse,
  shoCustomerWriteParse,
} from "./sho-planners/__tests__/customer-write-parses.js";
import { shoOrderWriteParse } from "./sho-planners/__tests__/order-write-parses.js";
import type { ShoPlan } from "./sho-turn.js";

type Json = Record<string, unknown>;

const MEMBER = {
  verifiedCompanyId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  requestId: "33333333-3333-4333-8333-333333333333",
};

const BUILD: ShoContextBuild = {
  scopeHash: "a".repeat(32),
  fingerprint: "b".repeat(16),
  context: {} as ShoContextBuild["context"],
};

const COMMAND = shoCommandSchema.parse({
  text: "покажи клієнтів",
  action: "customers.listCustomers",
  kind: "read",
  effect: "read",
  confirm: "none",
  params: {},
  needs: [],
  ready: true,
  catalogued: true,
  confidence: { action: 0.99, margin: 0.5, certainty: 0.9, spans: 0.9 },
  refPrevious: {},
});

const RESULT: ShoResult = shoResultSchema.parse({
  schema: "sho-result/2",
  raw: null,
  text: "покажи клієнтів",
  segments: ["покажи клієнтів"],
  tooMany: false,
  commands: [],
  first: COMMAND,
  context: null,
});

const CALL: ShoPlan = {
  kind: "call",
  writes: false,
  toolName: "customers_list_customers",
  input: {},
  reply: "Ось клієнти.",
};

function sourceOf(current: ShoContextSource["current"]): ShoContextSource {
  return { current };
}

function clientOf(parse: () => Promise<ShoParseOutcome>): ShoClient {
  return {
    replicas: ["http://sho"],
    replicaFor: () => "http://sho",
    parse,
    putContext: () => Promise.resolve({ outcome: "stored" }),
    phrases: () => Promise.resolve({ outcome: "ok", value: [] }),
    model: () =>
      Promise.resolve({
        outcome: "ok",
        value: {
          model: {
            id: "sho",
            md5: "0",
            catalogue: "0",
            labelsMd5: "0",
            runtime: "0",
          },
          actions: [],
          workers: 1,
        },
      }),
    ready: () => Promise.resolve(true),
    health: () => Promise.resolve(true),
  };
}

const parsedOk = (): Promise<ShoParseOutcome> =>
  Promise.resolve({
    outcome: "ok",
    value: {
      model: { id: "sho", md5: "0" },
      contextRevision: null,
      result: RESULT,
      ms: 12,
    },
  });

describe("shoNowAt", () => {
  it("reads the Kyiv wall clock, not UTC", () => {
    expect(shoNowAt(new Date("2026-07-01T21:30:00.000Z"))).toEqual({
      year: 2026,
      month: 7,
      day: 2,
      hour: 0,
      minute: 30,
    });
  });
});

describe("createShoEngine", () => {
  it("plans from the parsed result", async () => {
    const plan = vi.fn<ShoPlanner>(() => CALL);
    const engine = createShoEngine({
      client: clientOf(parsedOk),
      source: sourceOf(() => Promise.resolve(BUILD)),
      plan,
    });
    const now = new Date("2026-09-11T06:00:00.000Z");

    await expect(
      engine(MEMBER).plan({ text: "покажи клієнтів", now, focus: [] }),
    ).resolves.toEqual(CALL);
    expect(plan).toHaveBeenCalledWith(RESULT, now);
  });

  it("falls back on the reason the client gave", async () => {
    const engine = createShoEngine({
      client: clientOf(() =>
        Promise.resolve({
          outcome: "fallback",
          reason: "timeout",
          httpStatus: null,
        }),
      ),
      source: sourceOf(() => Promise.resolve(BUILD)),
      plan: () => CALL,
    });

    await expect(
      engine(MEMBER).plan({ text: "привіт", now: new Date(), focus: [] }),
    ).resolves.toEqual({ kind: "fallback", reason: "timeout" });
  });

  it("falls back for a member the context reads all deny, rather than refusing the turn", async () => {
    const plan = vi.fn<ShoPlanner>(() => CALL);
    const engine = createShoEngine({
      client: clientOf(parsedOk),
      source: sourceOf(() =>
        Promise.reject(new PermissionDeniedError("customers:view")),
      ),
      plan,
    });

    await expect(
      engine(MEMBER).plan({ text: "привіт", now: new Date(), focus: [] }),
    ).resolves.toEqual({ kind: "fallback", reason: "unreadable" });
    expect(plan).not.toHaveBeenCalled();
  });

  it("lets any other failure out, so the turn falls back rather than settling", async () => {
    const engine = createShoEngine({
      client: clientOf(() => Promise.reject(new Error("socket"))),
      source: sourceOf(() => Promise.resolve(BUILD)),
      plan: () => CALL,
    });

    await expect(
      engine(MEMBER).plan({ text: "привіт", now: new Date(), focus: [] }),
    ).rejects.toThrow("socket");
  });
});

describe("mountShoEngine", () => {
  const PIPELINE = {} as ActionPipelineDeps;
  const TOKEN = "sho-service-token-at-least-32-chars";
  const URLS = ["http://sho-a:3100"];
  const ACTIONS = ["orders.list"];

  const mounted = (sho: ShoMountConfig): ShoEngineFor | undefined =>
    mountShoEngine({ sho, pipeline: PIPELINE });

  it("mounts nothing without a replica", () => {
    expect(
      mounted({ urls: [], serviceToken: TOKEN, actions: ACTIONS }),
    ).toBeUndefined();
  });

  it("mounts nothing without a service token", () => {
    expect(
      mounted({ urls: URLS, serviceToken: undefined, actions: ACTIONS }),
    ).toBeUndefined();
  });

  it("mounts nothing while no action is whitelisted", () => {
    expect(
      mounted({ urls: URLS, serviceToken: TOKEN, actions: [] }),
    ).toBeUndefined();
  });

  it("mounts an engine for a configured replica, token and action", () => {
    const engine = mounted({
      urls: URLS,
      serviceToken: TOKEN,
      actions: ACTIONS,
    });
    expect(engine).toBeTypeOf("function");
    expect(engine?.(MEMBER).plan).toBeTypeOf("function");
  });
});

describe("what createShoEngine asks Шо", () => {
  const sent = (): {
    readonly client: ShoClient;
    readonly asked: ShoParseInput[];
  } => {
    const asked: ShoParseInput[] = [];
    const client = clientOf(() => parsedOk());
    return {
      asked,
      client: {
        ...client,
        parse: (request) => {
          asked.push(request);
          return parsedOk();
        },
      },
    };
  };

  it("passes the focus and the previous command of the turn", async () => {
    const { client, asked } = sent();
    const engine = createShoEngine({
      client,
      source: sourceOf(() => Promise.resolve(BUILD)),
      plan: () => CALL,
    });
    const focus = [
      {
        type: "customer" as const,
        id: "c-1",
        name: "Катя",
        how: "created" as const,
        turns: 0,
      },
    ];

    await engine(MEMBER).plan({
      text: "створи для неї замовлення",
      now: new Date("2026-10-02T09:00:00.000Z"),
      focus,
      previous: { command: COMMAND, at: "2026-10-02T08:59:00.000Z" },
    });

    expect(asked[0]?.focus).toEqual(focus);
    expect(asked[0]?.previous?.command.action).toBe("customers.listCustomers");
  });

  const boundTo = (id: string) =>
    shoCommandSchema.parse({
      ...COMMAND,
      action: "orders.list",
      params: {
        customer: {
          text: "неї",
          status: "context",
          id,
          name: "Катя",
          focus: 0,
        },
      },
    });

  const engineOver = (
    command: ShoCommand,
  ): ReturnType<typeof createShoEngine> =>
    createShoEngine({
      client: clientOf(() =>
        Promise.resolve({
          outcome: "ok",
          value: {
            model: { id: "sho", md5: "0" },
            contextRevision: null,
            result: { ...RESULT, commands: [command] },
            ms: 12,
          },
        }),
      ),
      source: sourceOf(() => Promise.resolve(BUILD)),
      plan: () => CALL,
    });

  const FOCUS = [
    {
      type: "customer" as const,
      id: "c-1",
      name: "Катя",
      how: "created" as const,
      turns: 0,
    },
  ];

  it("plans a reference the focus it sent holds", async () => {
    await expect(
      engineOver(boundTo("c-1"))(MEMBER).plan({
        text: "покажи її замовлення",
        now: new Date("2026-10-02T09:00:00.000Z"),
        focus: FOCUS,
      }),
    ).resolves.toMatchObject({ kind: "call" });
  });

  it("refuses an id no entry of the focus it sent holds", async () => {
    await expect(
      engineOver(boundTo("c-2"))(MEMBER).plan({
        text: "покажи її замовлення",
        now: new Date("2026-10-02T09:00:00.000Z"),
        focus: FOCUS,
      }),
    ).resolves.toEqual({ kind: "fallback", reason: "unresolved_reference" });
  });

  it("tells the turn which command it planned, so the log stores it", async () => {
    const engine = createShoEngine({
      client: clientOf(() =>
        Promise.resolve({
          outcome: "ok",
          value: {
            model: { id: "sho", md5: "0" },
            contextRevision: null,
            result: { ...RESULT, commands: [COMMAND] },
            ms: 12,
          },
        }),
      ),
      source: sourceOf(() => Promise.resolve(BUILD)),
      plan: () => CALL,
    });

    await expect(
      engine(MEMBER).plan({
        text: "покажи клієнтів",
        now: new Date("2026-10-02T09:00:00.000Z"),
        focus: [],
      }),
    ).resolves.toEqual({ ...CALL, command: COMMAND });
  });

  const CONFIDENT = { action: 0.99, margin: 0.8, certainty: 0.9, spans: 0.9 };

  const parseOf = (caseId: string): Json =>
    cloneShoParse(shoOrderWriteParse(caseId));

  const commandOf = (caseId: string, params?: Json): ShoCommand =>
    shoCommandSchema.parse({
      ...parseOf(caseId),
      confidence: CONFIDENT,
      ...(params === undefined ? {} : { params }),
    });

  function createWithProduct(product: Json): ShoCommand {
    const params = parseOf("d92-focus-update-as-create")["params"] as Json;
    const items = params["items"] as readonly Json[];
    return commandOf("d92-focus-update-as-create", {
      ...params,
      items: [{ ...(items[0] ?? {}), product }],
    });
  }

  const BOUGHT_FOR = {
    type: "customer" as const,
    id: "new-orest",
    name: "Орест Ярема",
    how: "created" as const,
    turns: 0,
  };

  const SHOWN_PRODUCT = {
    type: "product" as const,
    id: "p-cable",
    name: "Кабель USB-C",
    how: "shown" as const,
    turns: 1,
  };

  const inLine = (id: string): Json => ({
    text: "такий самий",
    status: "context",
    id,
    name: "Кабель USB-C",
    focus: 0,
  });

  it("refuses an id inside a line no entry of the focus it sent holds", async () => {
    await expect(
      engineOver(createWithProduct(inLine("p-other")))(MEMBER).plan({
        text: "і відразу замовлення йому на три такі самі",
        now: new Date("2026-10-02T09:00:00.000Z"),
        focus: [BOUGHT_FOR, SHOWN_PRODUCT],
      }),
    ).resolves.toEqual({ kind: "fallback", reason: "unresolved_reference" });
  });

  it("plans an id inside a line the focus it sent holds", async () => {
    await expect(
      engineOver(createWithProduct(inLine("p-cable")))(MEMBER).plan({
        text: "і відразу замовлення йому на три такі самі",
        now: new Date("2026-10-02T09:00:00.000Z"),
        focus: [BOUGHT_FOR, SHOWN_PRODUCT],
      }),
    ).resolves.toMatchObject({ kind: "call" });
  });

  const CONFIRM_FOCUSED = commandOf("d88-object-order");

  const focusedAs = (type: "customer" | "order") => [
    {
      type,
      id: "o-7001",
      name: "Остап Гнатюк",
      how: "shown" as const,
      turns: 0,
    },
  ];

  it("refuses a focus entry of another type in a param that expects an order", async () => {
    await expect(
      engineOver(CONFIRM_FOCUSED)(MEMBER).plan({
        text: "підтверди його",
        now: new Date("2026-10-02T09:00:00.000Z"),
        focus: focusedAs("customer"),
      }),
    ).resolves.toEqual({ kind: "fallback", reason: "unresolved_reference" });
  });

  it("plans the same id when the focus holds it as an order", async () => {
    await expect(
      engineOver(CONFIRM_FOCUSED)(MEMBER).plan({
        text: "підтверди його",
        now: new Date("2026-10-02T09:00:00.000Z"),
        focus: focusedAs("order"),
      }),
    ).resolves.toMatchObject({ kind: "call" });
  });

  it("refuses a held id in a slot that names no record type", async () => {
    const elsewhere = commandOf("d88-object-order", {
      period: {
        text: "його",
        status: "context",
        id: "o-7001",
        name: "№ 7001",
        focus: 0,
      },
    });

    await expect(
      engineOver(elsewhere)(MEMBER).plan({
        text: "підтверди його",
        now: new Date("2026-10-02T09:00:00.000Z"),
        focus: focusedAs("order"),
      }),
    ).resolves.toEqual({ kind: "fallback", reason: "unresolved_reference" });
  });

  const GROUPED = shoCommandSchema.parse({
    ...(JSON.parse(
      JSON.stringify(shoCustomerWriteParse("d88-there-group")),
    ) as Json),
    confidence: CONFIDENT,
    params: {
      customers: [{ text: "її", status: "context", id: "c-lytvyn", focus: 0 }],
      group: {
        text: "туди",
        status: "context",
        id: "new-wedding",
        name: "Весільні",
        focus: 1,
      },
    },
  });

  const IN_THE_GROUP = {
    type: "group" as const,
    id: "new-wedding",
    name: "Весільні",
    how: "created" as const,
    turns: 1,
  };

  const listedAs = (type: "customer" | "product") => [
    {
      type,
      id: "c-lytvyn",
      name: "Ігор Литвин",
      how: "shown" as const,
      turns: 0,
    },
    IN_THE_GROUP,
  ];

  it("plans a record list whose entry the focus holds as that record", async () => {
    await expect(
      engineOver(GROUPED)(MEMBER).plan({
        text: "закинь її туди",
        now: new Date("2026-10-02T09:00:00.000Z"),
        focus: listedAs("customer"),
      }),
    ).resolves.toMatchObject({ kind: "call" });
  });

  it("refuses a record list whose entry the focus holds as another record", async () => {
    await expect(
      engineOver(GROUPED)(MEMBER).plan({
        text: "закинь її туди",
        now: new Date("2026-10-02T09:00:00.000Z"),
        focus: listedAs("product"),
      }),
    ).resolves.toEqual({ kind: "fallback", reason: "unresolved_reference" });
  });
});
