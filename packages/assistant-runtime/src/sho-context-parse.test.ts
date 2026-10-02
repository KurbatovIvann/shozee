import {
  SHO_RESULT_SCHEMA,
  type ShoClient,
  type ShoCommand,
  type ShoContextOutcome,
  type ShoModelOutcome,
  type ShoParseOutcome,
  type ShoParseResponse,
  type ShoPhrasesOutcome,
} from "@showzy/sho-protocol";
import { describe, expect, it, vi } from "vitest";

import { PermissionDeniedError, TimeoutError } from "@showzy/core/errors";

import {
  parseWithShoContext,
  SHO_CONTEXT_UNREADABLE,
  type ShoContextCaller,
  type ShoContextSource,
} from "./sho-context-source.js";
import { buildShoContext, type ShoContextBuild } from "./sho-context.js";

const caller: ShoContextCaller = {
  companyId: "company-a",
  userId: "anna",
  requestId: "request-1",
};

const built: ShoContextBuild = buildShoContext({
  catalog: null,
  customers: {
    customers: { items: [{ id: "customer-1", name: "Оля" }], truncated: false },
    groups: { items: [], truncated: false },
  },
  pricing: null,
});

const command: ShoCommand = {
  text: "додай Олю",
  action: "customers.create",
  kind: "write",
  effect: "write",
  confirm: "card",
  params: {},
  needs: [],
  ready: true,
  catalogued: true,
  confidence: { action: 0.98, margin: 0.9, certainty: 0.95, spans: 0.87 },
  refPrevious: {},
};

const answer: ShoParseResponse = {
  model: { id: "system-one-uk", md5: "a".repeat(32) },
  contextRevision: built.fingerprint,
  result: {
    schema: SHO_RESULT_SCHEMA,
    raw: "customers.create",
    text: "додай Олю",
    segments: ["додай Олю"],
    tooMany: false,
    commands: [command],
    first: command,
    context: { version: 2, revision: built.fingerprint },
  },
  ms: 7,
};

const source: ShoContextSource = {
  current: () => Promise.resolve(built),
};

const refusing = (error: Error): ShoContextSource => ({
  current: () => Promise.reject(error),
});

const request = {
  text: "додай Олю",
  now: { year: 2026, month: 10, day: 2, hour: 12, minute: 30 },
  deadlineMs: 900,
  debug: false,
};

function stubClient(
  parseOutcomes: readonly ShoParseOutcome[],
  stored: ShoContextOutcome = { outcome: "stored" },
): ShoClient {
  const queue = [...parseOutcomes];
  return {
    replicas: ["http://sho"],
    replicaFor: () => "http://sho",
    parse: vi.fn(() => {
      const next = queue.shift();
      if (next === undefined) throw new Error("parse called too often");
      return Promise.resolve(next);
    }),
    putContext: vi.fn(() => Promise.resolve(stored)),
    phrases: vi.fn(() =>
      Promise.resolve<ShoPhrasesOutcome>({ outcome: "ok", value: [] }),
    ),
    model: vi.fn(() =>
      Promise.resolve<ShoModelOutcome>({
        outcome: "fallback",
        reason: "unreachable",
        httpStatus: null,
      }),
    ),
    ready: vi.fn(() => Promise.resolve(true)),
    health: vi.fn(() => Promise.resolve(true)),
  };
}

describe("parseWithShoContext", () => {
  it("parses against the cached fingerprint without uploading", async () => {
    const client = stubClient([{ outcome: "ok", value: answer }]);

    const outcome = await parseWithShoContext(client, source, caller, request);

    expect(outcome).toEqual({ outcome: "ok", value: answer });
    expect(client.putContext).not.toHaveBeenCalled();
    expect(client.parse).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-a",
        scopeHash: built.scopeHash,
        fingerprint: built.fingerprint,
        text: "додай Олю",
      }),
    );
  });

  it("uploads the context on 409 and retries the parse once", async () => {
    const client = stubClient([
      { outcome: "context_required" },
      { outcome: "ok", value: answer },
    ]);

    const outcome = await parseWithShoContext(client, source, caller, request);

    expect(outcome).toEqual({ outcome: "ok", value: answer });
    expect(client.putContext).toHaveBeenCalledWith({
      companyId: "company-a",
      scopeHash: built.scopeHash,
      fingerprint: built.fingerprint,
      context: built.context,
    });
    expect(client.parse).toHaveBeenCalledTimes(2);
  });

  it("stops at one retry when the upload does not settle the context", async () => {
    const client = stubClient([
      { outcome: "context_required" },
      { outcome: "context_required" },
    ]);

    const outcome = await parseWithShoContext(client, source, caller, request);

    expect(outcome).toEqual({ outcome: "context_required" });
    expect(client.parse).toHaveBeenCalledTimes(2);
    expect(client.putContext).toHaveBeenCalledTimes(1);
  });

  it("falls through to the LLM when the context cannot be read", async () => {
    const client = stubClient([]);

    const outcome = await parseWithShoContext(
      client,
      refusing(new TimeoutError()),
      caller,
      request,
    );

    expect(outcome).toEqual(SHO_CONTEXT_UNREADABLE);
    expect(client.parse).not.toHaveBeenCalled();
    expect(client.putContext).not.toHaveBeenCalled();
  });

  it("refuses a caller the staff context denied", async () => {
    const client = stubClient([]);

    await expect(
      parseWithShoContext(
        client,
        refusing(new PermissionDeniedError()),
        caller,
        request,
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(client.parse).not.toHaveBeenCalled();
    expect(client.putContext).not.toHaveBeenCalled();
  });

  it("gives back the upload's fallback and never parses again", async () => {
    const client = stubClient([{ outcome: "context_required" }], {
      outcome: "fallback",
      reason: "context_limit",
      httpStatus: 413,
    });

    const outcome = await parseWithShoContext(client, source, caller, request);

    expect(outcome).toEqual({
      outcome: "fallback",
      reason: "context_limit",
      httpStatus: 413,
    });
    expect(client.parse).toHaveBeenCalledTimes(1);
  });
});
