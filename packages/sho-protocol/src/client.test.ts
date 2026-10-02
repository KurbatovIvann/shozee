import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import {
  createShoClient,
  type ShoFetch,
  type ShoParseInput,
  type ShoParseOutcome,
} from "./client.js";
import { SHO_RESULT_SCHEMA } from "./result.js";
import { SHO_PHRASES_LIMIT, shoContextKey } from "./endpoints.js";

const urls = ["http://sho-1:8080", "http://sho-2:8080", "http://sho-3:8080"];

const token = "service-token";

const command = {
  text: "додай 2 кави",
  action: "orders.create",
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

const parseBody = {
  model: { id: "system-one-uk", md5: "a".repeat(32) },
  contextRevision: "rev-7",
  result: {
    schema: SHO_RESULT_SCHEMA,
    raw: "orders.create",
    text: "додай 2 кави",
    segments: ["додай 2 кави"],
    tooMany: false,
    commands: [command],
    first: command,
    context: { version: 2, revision: "rev-7" },
  },
  ms: 9.4,
};

const companyB = "c0ffee00-0000-4000-8000-000000000002";

const parseRequest: ShoParseInput = {
  requestId: "req-1",
  companyId: "c0ffee00-0000-4000-8000-000000000001",
  scopeHash: "9f8c1a2b",
  fingerprint: "fp-1",
  text: "додай 2 кави",
  now: { year: 2026, month: 10, day: 2, hour: 11, minute: 5 },
  deadlineMs: 900,
  debug: false,
};

const respondWith = (body: string | null, status: number): ShoFetch => {
  return () => Promise.resolve(new Response(body, { status }));
};

const json = (body: unknown, status: number): ShoFetch =>
  respondWith(JSON.stringify(body), status);

const client = (fetchImpl: ShoFetch, timeoutMs = 1000) =>
  createShoClient({ urls, token, timeoutMs }, { fetch: fetchImpl });

const rejected = {
  outcome: "fallback",
  reason: "input_rejected",
  httpStatus: null,
};

describe("createShoClient.parse", () => {
  it("returns the decoded response on 200", async () => {
    const outcome = await client(json(parseBody, 200)).parse(parseRequest);
    expect(outcome.outcome).toBe("ok");
    if (outcome.outcome !== "ok") return;
    expect(outcome.value.result.commands[0]?.action).toBe("orders.create");
    expect(outcome.value.contextRevision).toBe("rev-7");
  });

  it("sends the service token and the request body to the company's replica", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const recording: ShoFetch = (url, init) => {
      seen.url = url;
      seen.init = init;
      return Promise.resolve(
        new Response(JSON.stringify(parseBody), { status: 200 }),
      );
    };

    const sho = client(recording);
    await sho.parse(parseRequest);

    expect(seen.url).toBe(`${sho.replicaFor(parseRequest.companyId)}/v1/parse`);
    expect(new Headers(seen.init?.headers).get("authorization")).toBe(
      `Bearer ${token}`,
    );
    expect(JSON.parse(seen.init?.body as string)).toMatchObject({
      requestId: "req-1",
      text: "додай 2 кави",
      contextKey: shoContextKey(parseRequest.companyId, parseRequest.scopeHash),
    });
  });

  it("refuses to follow a redirect away from the replica", async () => {
    const seen: { init?: RequestInit } = {};
    const recording: ShoFetch = (_url, init) => {
      seen.init = init;
      return Promise.resolve(
        new Response(JSON.stringify(parseBody), { status: 200 }),
      );
    };

    await client(recording).parse(parseRequest);

    expect(seen.init?.redirect).toBe("error");
  });

  it("builds the context key from the company it routes to", async () => {
    const seen: { url?: string; body?: unknown } = {};
    const recording: ShoFetch = (url, init) => {
      seen.url = url;
      seen.body = JSON.parse(init.body as string);
      return Promise.resolve(
        new Response(JSON.stringify(parseBody), { status: 200 }),
      );
    };

    const sho = client(recording);
    await sho.parse({ ...parseRequest, companyId: companyB });

    expect(seen.url).toBe(`${sho.replicaFor(companyB)}/v1/parse`);
    expect(seen.body).toMatchObject({
      companyId: companyB,
      contextKey: shoContextKey(companyB, parseRequest.scopeHash),
    });
  });

  it("refuses a request the service would reject", async () => {
    let called = false;
    const counting: ShoFetch = () => {
      called = true;
      return Promise.resolve(new Response(null, { status: 200 }));
    };

    expect(
      await client(counting).parse({
        ...parseRequest,
        scopeHash: "not a hash",
      }),
    ).toEqual(rejected);
    expect(await client(counting).parse({ ...parseRequest, text: "" })).toEqual(
      rejected,
    );
    expect(called).toBe(false);
  });

  const fallbacks: readonly (readonly [number, string])[] = [
    [400, "input_rejected"],
    [503, "busy"],
    [504, "deadline"],
    [418, "unexpected_status"],
    [500, "unexpected_status"],
  ];

  for (const [status, reason] of fallbacks) {
    it(`maps ${String(status)} to the ${reason} fallback`, async () => {
      const outcome = await client(json({ error: reason }, status)).parse(
        parseRequest,
      );
      expect(outcome).toEqual({
        outcome: "fallback",
        reason,
        httpStatus: status,
      });
    });
  }

  it("maps 409 to context_required so the caller can build and retry", async () => {
    const outcome = await client(
      json({ error: "context_required" }, 409),
    ).parse(parseRequest);
    expect(outcome).toEqual({ outcome: "context_required" });
  });

  it("maps a 200 body that is not a result to the unreadable fallback", async () => {
    const garbage = await client(json({ result: "соррі" }, 200)).parse(
      parseRequest,
    );
    expect(garbage).toEqual({
      outcome: "fallback",
      reason: "unreadable",
      httpStatus: 200,
    });

    const notJson = await client(respondWith("<html>502</html>", 200)).parse(
      parseRequest,
    );
    expect(notJson).toEqual({
      outcome: "fallback",
      reason: "unreadable",
      httpStatus: 200,
    });
  });

  it("maps a request that outlives the timeout to the timeout fallback", async () => {
    const hanging: ShoFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });

    const outcome = await client(hanging, 5).parse(parseRequest);
    expect(outcome).toEqual({
      outcome: "fallback",
      reason: "timeout",
      httpStatus: null,
    });
  });

  it("maps a body that stalls after the headers to the timeout fallback", async () => {
    const stalling: ShoFetch = (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"model":'));
          init.signal?.addEventListener("abort", () => {
            controller.error(new Error("aborted"));
          });
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    };

    const outcome = await client(stalling, 5).parse(parseRequest);
    expect(outcome).toEqual({
      outcome: "fallback",
      reason: "timeout",
      httpStatus: null,
    });
  });

  it("reads the error code of a status it does not map on its own", async () => {
    expect(
      await client(json({ error: "busy" }, 500)).parse(parseRequest),
    ).toEqual({ outcome: "fallback", reason: "busy", httpStatus: 500 });
    expect(
      await client(json({ error: "shrug" }, 500)).parse(parseRequest),
    ).toEqual({
      outcome: "fallback",
      reason: "unexpected_status",
      httpStatus: 500,
    });
  });

  it("maps an unreachable service to the unreachable fallback", async () => {
    const refused: ShoFetch = () => Promise.reject(new Error("ECONNREFUSED"));
    const outcome = await client(refused).parse(parseRequest);
    expect(outcome).toEqual({
      outcome: "fallback",
      reason: "unreachable",
      httpStatus: null,
    });
  });

  it("never throws for any mapped transport outcome", async () => {
    const outcomes: ShoParseOutcome[] = [];
    for (const status of [200, 400, 409, 413, 500, 503, 504]) {
      outcomes.push(
        await client(json({ error: "x" }, status)).parse(parseRequest),
      );
    }
    expect(outcomes).toHaveLength(7);
    expect(outcomes.every((outcome) => outcome.outcome !== "ok")).toBe(true);
  });
});

describe("createShoClient.putContext", () => {
  const contextRequest = {
    companyId: parseRequest.companyId,
    scopeHash: parseRequest.scopeHash,
    fingerprint: "fp-1",
    context: {
      version: 2 as const,
      customers: [{ id: "cus_1", name: "Софія" }],
    },
  };

  const keyOf = (companyId: string) =>
    encodeURIComponent(shoContextKey(companyId, parseRequest.scopeHash));

  it("gzips the body and reports 204 as stored", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const recording: ShoFetch = (url, init) => {
      seen.url = url;
      seen.init = init;
      return Promise.resolve(new Response(null, { status: 204 }));
    };

    const outcome = await client(recording).putContext(contextRequest);

    expect(outcome).toEqual({ outcome: "stored" });
    expect(seen.url).toBe(
      `${client(recording).replicaFor(contextRequest.companyId)}/v1/contexts/${keyOf(contextRequest.companyId)}`,
    );
    expect(new Headers(seen.init?.headers).get("content-encoding")).toBe(
      "gzip",
    );
    expect(
      JSON.parse(gunzipSync(seen.init?.body as Uint8Array).toString("utf8")),
    ).toEqual({ fingerprint: "fp-1", context: contextRequest.context });
  });

  it("maps 413 to the context_limit fallback and 503 to busy", async () => {
    expect(
      await client(json({ error: "context_limit" }, 413)).putContext(
        contextRequest,
      ),
    ).toEqual({
      outcome: "fallback",
      reason: "context_limit",
      httpStatus: 413,
    });
    expect(
      await client(json({ error: "busy" }, 503)).putContext(contextRequest),
    ).toEqual({ outcome: "fallback", reason: "busy", httpStatus: 503 });
  });

  it("refuses a scope that cannot form a context key", async () => {
    let called = false;
    const counting: ShoFetch = () => {
      called = true;
      return Promise.resolve(new Response(null, { status: 204 }));
    };

    expect(
      await client(counting).putContext({
        ...contextRequest,
        scopeHash: "not a scope hash",
      }),
    ).toEqual(rejected);
    expect(
      await client(counting).phrases({
        companyId: contextRequest.companyId,
        scopeHash: "not a scope hash",
      }),
    ).toEqual(rejected);
    expect(called).toBe(false);
  });

  it("keys and routes every context call by the company it is given", async () => {
    const seen: string[] = [];
    const recording: ShoFetch = (url) => {
      seen.push(url);
      return Promise.resolve(new Response(null, { status: 204 }));
    };

    const sho = client(recording);
    await sho.putContext({ ...contextRequest, companyId: companyB });
    await sho.phrases({
      companyId: companyB,
      scopeHash: contextRequest.scopeHash,
    });

    expect(seen[0]).toBe(
      `${sho.replicaFor(companyB)}/v1/contexts/${keyOf(companyB)}`,
    );
    expect(seen[1]).toContain(`/v1/contexts/${keyOf(companyB)}/phrases`);
    expect(seen.join(" ")).not.toContain(contextRequest.companyId);
  });

  it("refuses a context that carries phones or emails", async () => {
    let called = false;
    const counting: ShoFetch = () => {
      called = true;
      return Promise.resolve(new Response(null, { status: 204 }));
    };

    const withContacts = {
      version: 2 as const,
      customers: [
        { id: "cus_1", name: "Софія", phones: ["+380501112233"] },
        { id: "cus_2", name: "Олег", emails: ["oleh@example.com"] },
      ],
    };

    expect(
      await client(counting).putContext({
        ...contextRequest,
        context: withContacts,
      }),
    ).toEqual(rejected);
    expect(called).toBe(false);
  });

  it("refuses a context larger than the service accepts", async () => {
    let called = false;
    const counting: ShoFetch = () => {
      called = true;
      return Promise.resolve(new Response(null, { status: 204 }));
    };

    expect(
      await client(counting).putContext({
        ...contextRequest,
        context: {
          version: 2 as const,
          customers: Array.from({ length: 7000 }, (_, index) => ({
            id: `cus_${String(index)}`,
            name: "Софія",
            aliases: Array.from({ length: 10 }, () => "x".repeat(120)),
          })),
        },
      }),
    ).toEqual({
      outcome: "fallback",
      reason: "context_limit",
      httpStatus: null,
    });
    expect(called).toBe(false);
  });
});

describe("createShoClient model, phrases and ready", () => {
  it("decodes the model stamp", async () => {
    const outcome = await client(
      json(
        {
          model: {
            id: "system-one-uk",
            md5: "a".repeat(32),
            catalogue: "v3.5",
            labelsMd5: "b".repeat(32),
            runtime: "onnx",
          },
          actions: ["orders.create"],
          workers: 4,
        },
        200,
      ),
    ).model(urls[0] ?? "");
    expect(outcome.outcome).toBe("ok");
    if (outcome.outcome !== "ok") return;
    expect(outcome.value.model.labelsMd5).toBe("b".repeat(32));
  });

  it("returns the speech phrases and falls back when the service is busy", async () => {
    const query = {
      companyId: parseRequest.companyId,
      scopeHash: parseRequest.scopeHash,
    };
    expect(
      await client(json({ phrases: ["Софія Мельник", "Кава"] }, 200)).phrases(
        query,
      ),
    ).toEqual({ outcome: "ok", value: ["Софія Мельник", "Кава"] });
    expect(await client(json({ error: "busy" }, 503)).phrases(query)).toEqual({
      outcome: "fallback",
      reason: "busy",
      httpStatus: 503,
    });
  });

  it("asks for the declared phrases limit and refuses a larger one", async () => {
    const seen: string[] = [];
    const recording: ShoFetch = (url) => {
      seen.push(url);
      return Promise.resolve(
        new Response(JSON.stringify({ phrases: [] }), { status: 200 }),
      );
    };

    const query = {
      companyId: parseRequest.companyId,
      scopeHash: parseRequest.scopeHash,
    };
    await client(recording).phrases(query);
    expect(seen[0]).toContain(
      `phrases?companyId=${query.companyId}&limit=${String(SHO_PHRASES_LIMIT)}`,
    );
    expect(
      await client(recording).phrases({
        ...query,
        limit: SHO_PHRASES_LIMIT + 1,
      }),
    ).toEqual(rejected);
    expect(seen).toHaveLength(1);
  });

  it("is ready only when the service says so", async () => {
    expect(await client(json({ ready: true }, 200)).ready(urls[0] ?? "")).toBe(
      true,
    );
    expect(await client(json({ ready: false }, 200)).ready(urls[0] ?? "")).toBe(
      false,
    );
    expect(await client(json({}, 503)).ready(urls[0] ?? "")).toBe(false);
  });

  it("reports health only for a replica that answers ok", async () => {
    expect(
      await client(json({ status: "ok" }, 200)).health(urls[0] ?? ""),
    ).toBe(true);
    expect(await client(json({}, 503)).health(urls[0] ?? "")).toBe(false);
  });

  it("never sends the service token to a url outside the configuration", async () => {
    let called = false;
    const counting: ShoFetch = () => {
      called = true;
      return Promise.resolve(new Response(null, { status: 200 }));
    };
    const foreign = "http://attacker.example/v1";

    expect(await client(counting).model(foreign)).toEqual({
      outcome: "fallback",
      reason: "input_rejected",
      httpStatus: null,
    });
    expect(await client(counting).ready(foreign)).toBe(false);
    expect(await client(counting).health(foreign)).toBe(false);
    expect(called).toBe(false);
  });
});

describe("createShoClient configuration", () => {
  it("refuses a configuration with no replica or no token", () => {
    expect(() => createShoClient({ urls: [], token })).toThrow();
    expect(() => createShoClient({ urls, token: "" })).toThrow();
  });
});
