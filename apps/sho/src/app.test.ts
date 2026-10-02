import { gzipSync } from "node:zlib";
import {
  compileContext,
  parseContext,
  type ActionName,
  type CommandV2,
  type ResultV2,
} from "@showzy/sho";
import {
  SHO_MAX_PARSE_BYTES,
  shoContextKey,
  shoModelResponseSchema,
  shoParseResponseSchema,
  shoPhrasesResponseSchema,
  type ShoContext,
  type ShoModelStamp,
} from "@showzy/sho-protocol";
import { beforeEach, describe, expect, it } from "vitest";

import { createShoApp, type ShoParseLogEntry } from "./app.ts";
import { createShoContextCache } from "./contexts.ts";
import type { ShoEngine, ShoParseJob, ShoReply } from "./engine.ts";

const TOKEN = "service-token-of-at-least-32-characters";
const COMPANY = "company1";
const SCOPE = "scope1";
const KEY = shoContextKey(COMPANY, SCOPE);

const STAMP: ShoModelStamp = {
  id: "v35",
  md5: "0123456789abcdef0123456789abcdef",
  catalogue: "v3",
  labelsMd5: "fedcba9876543210fedcba9876543210",
  runtime: "0.2.0",
};

const CONTEXT: ShoContext = {
  version: 2,
  revision: "rev-1",
  products: [
    {
      id: "coffee",
      name: "Кава",
      unit: "kg",
      variants: [{ id: "coffee-250", name: "Кава 250 г", values: ["250 г"] }],
    },
  ],
  customers: [{ id: "olena", name: "Олена Коваль" }],
};

const COMMAND: CommandV2 = {
  text: "дай каву",
  action: "orders.create" as ActionName,
  kind: "write",
  effect: "write",
  confirm: "card",
  params: {},
  needs: [],
  ready: true,
  refPrevious: {},
  catalogued: false,
  confidence: { action: 1, margin: 1, certainty: 1, spans: 1 },
};

const RESULT: ResultV2 = {
  schema: "sho-result/2",
  raw: "дай каву",
  text: "дай каву",
  segments: ["дай каву"],
  tooMany: false,
  commands: [COMMAND],
  first: COMMAND,
  context: null,
};

interface Recorded {
  readonly jobs: ShoParseJob[];
  readonly engine: ShoEngine;
}

function fakeEngine(run?: (job: ShoParseJob) => Promise<ShoReply>): Recorded {
  const jobs: ShoParseJob[] = [];
  const cache = createShoContextCache();
  return {
    jobs,
    engine: {
      stamp: STAMP,
      actions: ["orders.create", "customers.create"],
      workers: 1,
      ready: true,
      store: (upload) => {
        cache.put(upload.key, {
          fingerprint: upload.fingerprint,
          revision: upload.revision,
          compiled: compileContext(parseContext(upload.context)),
          phrases: upload.phrases,
          uploadBytes: upload.uploadBytes,
        });
        return Promise.resolve({ kind: "stored" });
      },
      phrases: (key) =>
        Promise.resolve({
          kind: "phrases",
          phrases: cache.read(key)?.phrases ?? null,
        }),
      run: async (job) => {
        const entry = cache.fresh(job.key, job.fingerprint);
        if (entry === null) return { kind: "context_required" };
        jobs.push(job);
        return run === undefined
          ? {
              kind: "parsed",
              result: RESULT,
              contextRevision: entry.revision,
              ms: 1,
            }
          : run(job);
      },
      dispose: () => Promise.resolve(),
    },
  };
}

const authorized = { authorization: `Bearer ${TOKEN}` };

function parseBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    requestId: "req-1",
    companyId: COMPANY,
    contextKey: KEY,
    fingerprint: "fp-1",
    text: "дай каву",
    now: { year: 2026, month: 10, day: 2, hour: 11, minute: 0 },
    deadlineMs: 1500,
    debug: false,
    ...overrides,
  };
}

function uploadRequest(
  body: unknown,
  key = KEY,
  headers: Record<string, string> = authorized,
): Request {
  return new Request(`http://sho.test/v1/contexts/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { ...headers, "content-encoding": "gzip" },
    body: new Uint8Array(gzipSync(Buffer.from(JSON.stringify(body), "utf8"))),
  });
}

const phrasesRequest = (
  key = KEY,
  query: Record<string, string> = { companyId: COMPANY },
): Request =>
  new Request(
    `http://sho.test/v1/contexts/${encodeURIComponent(key)}/phrases?${new URLSearchParams(query).toString()}`,
    { headers: authorized },
  );

describe("apps/sho /v1", () => {
  let recorded: Recorded;
  let logged: ShoParseLogEntry[];
  let app: ReturnType<typeof createShoApp>;

  beforeEach(() => {
    recorded = fakeEngine();
    logged = [];
    app = createShoApp({
      serviceToken: TOKEN,
      engine: () => recorded.engine,
      log: (entry) => logged.push(entry),
    });
  });

  const store = (fingerprint = "fp-1", context: ShoContext = CONTEXT) =>
    app.fetch(uploadRequest({ fingerprint, context }));

  it("serves health without a token and reports ready", async () => {
    const health = await app.fetch(new Request("http://sho.test/v1/health"));
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ status: "ok" });

    const ready = await app.fetch(
      new Request("http://sho.test/v1/ready", { headers: authorized }),
    );
    await expect(ready.json()).resolves.toEqual({ ready: true });
  });

  it("reports the model stamp, including labelsMd5", async () => {
    const response = await app.fetch(
      new Request("http://sho.test/v1/model", { headers: authorized }),
    );
    expect(response.status).toBe(200);
    const body = shoModelResponseSchema.parse(await response.json());
    expect(body.model).toEqual(STAMP);
    expect(body.model.labelsMd5).toBe(STAMP.labelsMd5);
    expect(body.workers).toBe(1);
  });

  it("stores a context and parses against it", async () => {
    expect((await store()).status).toBe(204);

    const response = await app.fetch(
      new Request("http://sho.test/v1/parse", {
        method: "POST",
        headers: { ...authorized, "content-type": "application/json" },
        body: JSON.stringify(parseBody()),
      }),
    );
    expect(response.status).toBe(200);
    const body = shoParseResponseSchema.parse(await response.json());
    expect(body.model).toEqual({ id: STAMP.id, md5: STAMP.md5 });
    expect(body.contextRevision).toBe("rev-1");
    expect(body.result.text).toBe("дай каву");
    expect(recorded.jobs).toHaveLength(1);
    expect(recorded.jobs[0]?.now.year).toBe(2026);
    expect(recorded.jobs[0]?.previous).toBeNull();
  });

  it("passes previous from the request", async () => {
    await store();
    const previous = { command: COMMAND, at: "2026-10-02T11:00:00Z" };
    const response = await app.fetch(
      new Request("http://sho.test/v1/parse", {
        method: "POST",
        headers: { ...authorized, "content-type": "application/json" },
        body: JSON.stringify(parseBody({ previous })),
      }),
    );
    expect(response.status).toBe(200);
    expect(recorded.jobs[0]?.previous?.command.action).toBe("orders.create");
    expect(recorded.jobs[0]?.previous?.at).toBe("2026-10-02T11:00:00Z");
  });

  it("serves phrases for a stored context", async () => {
    await store();
    const response = await app.fetch(
      phrasesRequest(KEY, { companyId: COMPANY, limit: "10" }),
    );
    expect(response.status).toBe(200);
    const body = shoPhrasesResponseSchema.parse(await response.json());
    expect(body.phrases).toEqual(["Кава", "Кава 250 г", "Олена Коваль"]);
  });

  it("binds phrases to the asking company and validates the key", async () => {
    await store();

    const foreign = await app.fetch(
      phrasesRequest(KEY, { companyId: "other" }),
    );
    expect(foreign.status).toBe(400);
    await expect(foreign.json()).resolves.toEqual({ error: "input" });

    const noCompany = await app.fetch(phrasesRequest(KEY, {}));
    expect(noCompany.status).toBe(400);

    const malformed = await app.fetch(
      phrasesRequest("no-colon", { companyId: "no-colon" }),
    );
    expect(malformed.status).toBe(400);

    const badLimit = await app.fetch(
      phrasesRequest(KEY, { companyId: COMPANY, limit: "0" }),
    );
    expect(badLimit.status).toBe(400);

    const otherTenant = await app.fetch(
      phrasesRequest(shoContextKey("other", SCOPE), { companyId: "other" }),
    );
    expect(otherTenant.status).toBe(409);
    await expect(otherTenant.json()).resolves.toEqual({
      error: "context_required",
    });
  });

  it("refuses a missing or wrong token on every route but health", async () => {
    const missing = await app.fetch(new Request("http://sho.test/v1/model"));
    expect(missing.status).toBe(401);

    const wrong = await app.fetch(
      new Request("http://sho.test/v1/model", {
        headers: { authorization: `Bearer ${TOKEN}x` },
      }),
    );
    expect(wrong.status).toBe(401);

    const unstored = await app.fetch(
      uploadRequest({ fingerprint: "fp-1", context: CONTEXT }, KEY, {
        authorization: "Bearer nope",
      }),
    );
    expect(unstored.status).toBe(401);

    const parse = await app.fetch(
      new Request("http://sho.test/v1/parse", {
        method: "POST",
        body: JSON.stringify(parseBody()),
      }),
    );
    expect(parse.status).toBe(401);
    expect(recorded.jobs).toHaveLength(0);
  });

  it("answers 409 on a context miss and on a stale fingerprint", async () => {
    const miss = await app.fetch(
      new Request("http://sho.test/v1/parse", {
        method: "POST",
        headers: authorized,
        body: JSON.stringify(parseBody()),
      }),
    );
    expect(miss.status).toBe(409);
    await expect(miss.json()).resolves.toEqual({ error: "context_required" });

    await store("fp-1");
    const stale = await app.fetch(
      new Request("http://sho.test/v1/parse", {
        method: "POST",
        headers: authorized,
        body: JSON.stringify(parseBody({ fingerprint: "fp-2" })),
      }),
    );
    expect(stale.status).toBe(409);
    expect(recorded.jobs).toHaveLength(0);

    const phrases = await app.fetch(
      phrasesRequest(shoContextKey("other", SCOPE), { companyId: "other" }),
    );
    expect(phrases.status).toBe(409);
    expect(logged).toEqual([
      { requestId: "req-1", outcome: "context_required", ms: null, code: null },
      { requestId: "req-1", outcome: "context_required", ms: null, code: null },
    ]);
  });

  it("refuses a context over a list, count or length limit with 413", async () => {
    const overLimit = [
      {
        version: 2,
        groups: Array.from({ length: 2001 }, (_, index) => ({
          id: `g${String(index)}`,
          name: `Group ${String(index)}`,
        })),
      },
      { version: 2, customers: [{ id: "c", name: "n".repeat(121) }] },
      {
        version: 2,
        customers: [
          {
            id: "c",
            name: "A",
            aliases: Array.from({ length: 11 }, () => "a"),
          },
        ],
      },
    ];
    for (const context of overLimit) {
      const response = await app.fetch(
        uploadRequest({ fingerprint: "fp-1", context }),
      );
      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({
        error: "context_limit",
      });
    }
  });

  it("refuses a malformed context shape with 400", async () => {
    const malformed = [
      { version: 2, products: [{ id: "p", name: "P", unit: "barrels" }] },
      {
        version: 2,
        customers: [
          { id: "a", name: "A" },
          { id: "a", name: "B" },
        ],
      },
      { version: 2, customers: [{ id: "c", name: "  " }] },
      { version: 2, orders: [] },
      { version: 2, customers: [{ id: "c", name: "A", phones: ["+380"] }] },
    ];
    for (const context of malformed) {
      const response = await app.fetch(
        uploadRequest({ fingerprint: "fp-1", context }),
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "input" });
    }
  });

  it("refuses a declared oversized upload without reading the body", async () => {
    const request = new Request(
      `http://sho.test/v1/contexts/${encodeURIComponent(KEY)}`,
      {
        method: "PUT",
        headers: { ...authorized, "content-length": String(9 * 1024 * 1024) },
        body: new Uint8Array(64),
      },
    );
    const response = await app.fetch(request);
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "context_limit" });
    expect(request.bodyUsed).toBe(false);
  });

  it("refuses an undeclared oversized upload while streaming it", async () => {
    const response = await app.fetch(
      new Request(`http://sho.test/v1/contexts/${encodeURIComponent(KEY)}`, {
        method: "PUT",
        headers: authorized,
        body: new Uint8Array(9 * 1024 * 1024),
      }),
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "context_limit" });
    expect(
      (await app.fetch(phrasesRequest(KEY, { companyId: COMPANY }))).status,
    ).toBe(409);
  });

  it("refuses an oversized parse body with 400", async () => {
    await store();
    const response = await app.fetch(
      new Request("http://sho.test/v1/parse", {
        method: "POST",
        headers: authorized,
        body: JSON.stringify(
          parseBody({ previous: { filler: "x".repeat(SHO_MAX_PARSE_BYTES) } }),
        ),
      }),
    );
    expect(response.status).toBe(400);
    expect(recorded.jobs).toHaveLength(0);
  });

  it("refuses a malformed key, body or cross-tenant context key", async () => {
    expect((await app.fetch(uploadRequest({}, "no-colon"))).status).toBe(400);
    expect((await app.fetch(uploadRequest({ fingerprint: "" }))).status).toBe(
      400,
    );

    await store();
    const foreign = await app.fetch(
      new Request("http://sho.test/v1/parse", {
        method: "POST",
        headers: authorized,
        body: JSON.stringify(parseBody({ companyId: "other" })),
      }),
    );
    expect(foreign.status).toBe(400);
    expect(recorded.jobs).toHaveLength(0);
  });

  it("maps every refused run outcome to its status and log outcome", async () => {
    for (const kind of ["busy", "deadline", "input"] as const) {
      const refusing = fakeEngine(() => Promise.resolve({ kind }));
      const entries: ShoParseLogEntry[] = [];
      const refusingApp = createShoApp({
        serviceToken: TOKEN,
        engine: () => refusing.engine,
        log: (entry) => entries.push(entry),
      });
      await refusingApp.fetch(
        uploadRequest({ fingerprint: "fp-1", context: CONTEXT }),
      );
      const response = await refusingApp.fetch(
        new Request("http://sho.test/v1/parse", {
          method: "POST",
          headers: authorized,
          body: JSON.stringify(parseBody()),
        }),
      );
      expect(response.status).toBe(
        { busy: 503, deadline: 504, input: 400 }[kind],
      );
      await expect(response.json()).resolves.toEqual({ error: kind });
      expect(entries).toEqual([
        { requestId: "req-1", outcome: kind, ms: null, code: null },
      ]);
    }
  });

  it("logs a failed run apart from an input refusal before it rethrows", async () => {
    const broken = fakeEngine(() =>
      Promise.resolve({ kind: "failed", code: "ShoRunFailure" }),
    );
    const entries: ShoParseLogEntry[] = [];
    const brokenApp = createShoApp({
      serviceToken: TOKEN,
      engine: () => broken.engine,
      log: (entry) => entries.push(entry),
    });
    await brokenApp.fetch(
      uploadRequest({ fingerprint: "fp-1", context: CONTEXT }),
    );
    const response = await brokenApp.fetch(
      new Request("http://sho.test/v1/parse", {
        method: "POST",
        headers: authorized,
        body: JSON.stringify(parseBody()),
      }),
    );
    expect(response.status).toBe(500);
    expect(entries).toEqual([
      {
        requestId: "req-1",
        outcome: "failed",
        ms: null,
        code: "ShoRunFailure",
      },
    ]);
  });

  it("maps every phrases outcome to its status", async () => {
    const answers: [ShoReply, number][] = [
      [{ kind: "busy" }, 503],
      [{ kind: "deadline" }, 504],
      [{ kind: "phrases", phrases: null }, 409],
      [{ kind: "failed", code: "ShoRunFailure" }, 500],
    ];
    for (const [reply, status] of answers) {
      const refusing = fakeEngine();
      const refusingApp = createShoApp({
        serviceToken: TOKEN,
        engine: () => ({
          ...refusing.engine,
          phrases: () => Promise.resolve(reply),
        }),
      });
      const response = await refusingApp.fetch(phrasesRequest());
      expect(response.status).toBe(status);
    }
  });

  it("reports ready only while the engine says every worker is warm", async () => {
    const cold = fakeEngine();
    const coldApp = createShoApp({
      serviceToken: TOKEN,
      engine: () => ({ ...cold.engine, ready: false }),
    });
    const response = await coldApp.fetch(
      new Request("http://sho.test/v1/ready", { headers: authorized }),
    );
    await expect(response.json()).resolves.toEqual({ ready: false });

    const warm = await app.fetch(
      new Request("http://sho.test/v1/ready", { headers: authorized }),
    );
    await expect(warm.json()).resolves.toEqual({ ready: true });
  });

  it("logs a request id and outcome, never the command text", async () => {
    await store();
    await app.fetch(
      new Request("http://sho.test/v1/parse", {
        method: "POST",
        headers: authorized,
        body: JSON.stringify(parseBody()),
      }),
    );
    expect(logged).toHaveLength(1);
    expect(logged[0]?.requestId).toBe("req-1");
    expect(logged[0]?.outcome).toBe("ok");
    expect(JSON.stringify(logged)).not.toContain("каву");
  });

  it("answers 503 until the model is loaded", async () => {
    const booting = createShoApp({ serviceToken: TOKEN, engine: () => null });
    const ready = await booting.fetch(
      new Request("http://sho.test/v1/ready", { headers: authorized }),
    );
    await expect(ready.json()).resolves.toEqual({ ready: false });
    const model = await booting.fetch(
      new Request("http://sho.test/v1/model", { headers: authorized }),
    );
    expect(model.status).toBe(503);
    await expect(model.json()).resolves.toEqual({ error: "busy" });
  });
});
