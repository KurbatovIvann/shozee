import type { ActionPipelineDeps } from "@showzy/core";
import { PermissionDeniedError } from "@showzy/core/errors";
import type {
  ShoClient,
  ShoParseOutcome,
  ShoResult,
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
import type { ShoPlan } from "./sho-turn.js";

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

const RESULT = { text: "покажи клієнтів" } as ShoResult;

const CALL: ShoPlan = {
  kind: "call",
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
      engine(MEMBER).plan({ text: "покажи клієнтів", now }),
    ).resolves.toEqual({ plan: CALL, result: RESULT });
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
      engine(MEMBER).plan({ text: "привіт", now: new Date() }),
    ).resolves.toEqual({
      plan: { kind: "fallback", reason: "timeout" },
      result: null,
    });
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
      engine(MEMBER).plan({ text: "привіт", now: new Date() }),
    ).resolves.toEqual({
      plan: { kind: "fallback", reason: "unreadable" },
      result: null,
    });
    expect(plan).not.toHaveBeenCalled();
  });

  it("lets any other failure out, so the turn falls back rather than settling", async () => {
    const engine = createShoEngine({
      client: clientOf(() => Promise.reject(new Error("socket"))),
      source: sourceOf(() => Promise.resolve(BUILD)),
      plan: () => CALL,
    });

    await expect(
      engine(MEMBER).plan({ text: "привіт", now: new Date() }),
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
