import { createHash, timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { InputError, parsePrevious, type Previous } from "@showzy/sho";
import {
  SHO_MAX_CONTEXT_BYTES,
  SHO_PHRASES_LIMIT,
  shoContextKeySchema,
  shoContextUploadSchema,
  shoParseRequestSchema,
  shoPhrasesLimitSchema,
  type ShoErrorCode,
} from "@showzy/sho-protocol";
import { Hono } from "hono";
import type { Context as HonoContext } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

import {
  createShoContextCache,
  shoContextPhrases,
  type ShoContextCache,
} from "./contexts.ts";
import type { ShoEngine } from "./engine.ts";

export const SHO_HEALTH_PATH = "/v1/health";

export interface ShoAppOptions {
  readonly serviceToken: string;
  readonly engine: () => ShoEngine | null;
  readonly cache?: ShoContextCache;
  readonly clock?: () => number;
}

const digest = (value: string): Buffer =>
  createHash("sha256").update(value, "utf8").digest();

export function serviceTokenMatches(
  expected: string,
  given: string | null,
): boolean {
  if (given === null) return false;
  return timingSafeEqual(digest(expected), digest(given));
}

export function bearerOf(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer (.+)$/.exec(header);
  return match?.[1] ?? null;
}

const problem = (
  c: HonoContext,
  status: ContentfulStatusCode,
  error: ShoErrorCode,
): Response => c.json({ error }, status);

type Inflated = { readonly body: Buffer } | { readonly refused: ShoErrorCode };

function inflate(raw: Buffer, encoding: string | undefined): Inflated {
  if (raw.byteLength > SHO_MAX_CONTEXT_BYTES)
    return { refused: "context_limit" };
  if (encoding !== "gzip") return { body: raw };
  try {
    return {
      body: gunzipSync(raw, { maxOutputLength: SHO_MAX_CONTEXT_BYTES }),
    };
  } catch (cause) {
    return { refused: cause instanceof RangeError ? "context_limit" : "input" };
  }
}

const rawPreviousSchema = z.object({ previous: z.unknown() });

function previousOf(json: unknown): Previous | null {
  const raw = rawPreviousSchema.safeParse(json);
  if (!raw.success || raw.data.previous === undefined) return null;
  return parsePrevious(raw.data.previous);
}

function createGate(): <Value>(task: () => Promise<Value>) => Promise<Value> {
  let last: Promise<unknown> = Promise.resolve();
  return (task) => {
    const next = last.then(task, task);
    last = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
}

export function createShoApp(options: ShoAppOptions): Hono {
  const cache = options.cache ?? createShoContextCache();
  const clock = options.clock ?? (() => performance.now());
  const gate = createGate();
  const app = new Hono();

  app.use("/v1/*", async (c, next) => {
    if (c.req.path === SHO_HEALTH_PATH) return next();
    if (
      !serviceTokenMatches(
        options.serviceToken,
        bearerOf(c.req.header("authorization")),
      )
    ) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return next();
  });

  app.get(SHO_HEALTH_PATH, (c) => c.json({ status: "ok" }));

  app.get("/v1/ready", (c) => c.json({ ready: options.engine() !== null }));

  app.get("/v1/model", (c) => {
    const engine = options.engine();
    if (engine === null) return problem(c, 503, "busy");
    return c.json({
      model: engine.stamp,
      actions: [...engine.actions],
      workers: engine.workers,
    });
  });

  app.put("/v1/contexts/:key", async (c) => {
    const engine = options.engine();
    if (engine === null) return problem(c, 503, "busy");
    const key = c.req.param("key");
    if (!shoContextKeySchema.safeParse(key).success) {
      return problem(c, 400, "input");
    }
    const inflated = inflate(
      Buffer.from(await c.req.arrayBuffer()),
      c.req.header("content-encoding"),
    );
    if ("refused" in inflated) {
      return problem(
        c,
        inflated.refused === "context_limit" ? 413 : 400,
        inflated.refused,
      );
    }
    const upload = shoContextUploadSchema.safeParse(
      parseJson(inflated.body.toString("utf8")),
    );
    if (!upload.success) return problem(c, 400, "input");
    try {
      cache.put(key, {
        fingerprint: upload.data.fingerprint,
        revision: upload.data.context.revision ?? null,
        compiled: engine.compile(upload.data.context),
        phrases: shoContextPhrases(upload.data.context),
        bytes: inflated.body.byteLength,
      });
    } catch (cause) {
      return refusal(c, cause);
    }
    return c.body(null, 204);
  });

  app.get("/v1/contexts/:key/phrases", (c) => {
    const given = c.req.query("limit");
    const limit = shoPhrasesLimitSchema.safeParse(
      given === undefined ? SHO_PHRASES_LIMIT : Number(given),
    );
    if (!limit.success) return problem(c, 400, "input");
    const entry = cache.held(c.req.param("key"));
    if (entry === null) return problem(c, 409, "context_required");
    return c.json({ phrases: entry.phrases.slice(0, limit.data) });
  });

  app.post("/v1/parse", async (c) => {
    const engine = options.engine();
    if (engine === null) return problem(c, 503, "busy");
    const json = parseJson(await c.req.text());
    const request = shoParseRequestSchema.safeParse(json);
    if (!request.success) return problem(c, 400, "input");
    const { companyId, contextKey, fingerprint, text, now, deadlineMs, debug } =
      request.data;
    if (!contextKey.startsWith(`${companyId}:`)) {
      return problem(c, 400, "input");
    }
    const entry = cache.fresh(contextKey, fingerprint);
    if (entry === null) return problem(c, 409, "context_required");

    let previous: Previous | null;
    try {
      previous = previousOf(json);
    } catch (cause) {
      return refusal(c, cause);
    }

    const deadlineAt = clock() + deadlineMs;
    try {
      const ran = await gate(async () => {
        if (clock() >= deadlineAt) return null;
        const started = clock();
        const result = await engine.run({
          text,
          context: entry.compiled,
          now,
          previous,
          debug,
        });
        return { result, ms: clock() - started };
      });
      if (ran === null) return problem(c, 504, "deadline");
      return c.json({
        model: { id: engine.stamp.id, md5: engine.stamp.md5 },
        contextRevision: entry.revision,
        result: ran.result,
        ms: ran.ms,
      });
    } catch (cause) {
      return refusal(c, cause);
    }
  });

  return app;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function refusal(c: HonoContext, cause: unknown): Response {
  if (cause instanceof InputError && cause.code === "context_limit") {
    return problem(c, 413, "context_limit");
  }
  if (cause instanceof InputError) return problem(c, 400, "input");
  throw cause;
}
