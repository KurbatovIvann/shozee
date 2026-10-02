import { createHash, timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  InputError,
  parseContext,
  parsePrevious,
  type Context,
  type Previous,
} from "@showzy/sho";
import {
  SHO_MAX_CONTEXT_BYTES,
  SHO_PHRASES_LIMIT,
  shoContextKeySchema,
  shoContextSchema,
  shoContextUploadSchema,
  shoParseRequestSchema,
  shoPhrasesQuerySchema,
  type ShoErrorCode,
} from "@showzy/sho-protocol";
import { Hono } from "hono";
import type { Context as HonoContext } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

import {
  createShoContextCache,
  shoContextPhrases,
  type ShoContextCache,
} from "./contexts.ts";
import type { ShoEngine } from "./engine.ts";

export const SHO_HEALTH_PATH = "/v1/health";
export const SHO_MAX_PARSE_BYTES = 256 * 1024;
export const SHO_QUEUE_LIMIT = 8;

export type ShoParseOutcome =
  "ok" | "input" | "context_required" | "busy" | "deadline";

export interface ShoParseLogEntry {
  readonly requestId: string | null;
  readonly outcome: ShoParseOutcome;
  readonly ms: number | null;
}

export interface ShoAppOptions {
  readonly serviceToken: string;
  readonly engine: () => ShoEngine | null;
  readonly cache?: ShoContextCache;
  readonly clock?: () => number;
  readonly queueLimit?: number;
  readonly log?: (entry: ShoParseLogEntry) => void;
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

const uploadEnvelopeSchema = z.object({
  fingerprint: shoContextUploadSchema.shape.fingerprint,
  context: z.unknown(),
});

interface Gate {
  readonly depth: number;
  run<Value>(task: () => Promise<Value>): Promise<Value>;
}

function createGate(): Gate {
  let depth = 0;
  let last: Promise<unknown> = Promise.resolve();
  return {
    get depth() {
      return depth;
    },
    run(task) {
      depth += 1;
      const next = last.then(task, task);
      last = next.then(
        () => undefined,
        () => undefined,
      );
      return next.finally(() => {
        depth -= 1;
      });
    },
  };
}

const EXPIRED = Symbol("deadline");

function expiresIn(ms: number): {
  readonly reached: Promise<typeof EXPIRED>;
  readonly cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reached = new Promise<typeof EXPIRED>((resolve) => {
    timer = setTimeout(
      () => {
        resolve(EXPIRED);
      },
      Math.max(ms, 0),
    );
  });
  return {
    reached,
    cancel: () => {
      clearTimeout(timer);
    },
  };
}

export function createShoApp(options: ShoAppOptions): Hono {
  const cache = options.cache ?? createShoContextCache();
  const clock = options.clock ?? (() => performance.now());
  const queueLimit = options.queueLimit ?? SHO_QUEUE_LIMIT;
  const log = options.log ?? (() => undefined);
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

  app.put(
    "/v1/contexts/:key",
    bodyLimit({
      maxSize: SHO_MAX_CONTEXT_BYTES,
      onError: (c) => problem(c, 413, "context_limit"),
    }),
    async (c) => {
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
      const envelope = uploadEnvelopeSchema.safeParse(
        parseJson(inflated.body.toString("utf8")),
      );
      if (!envelope.success) return problem(c, 400, "input");

      let parsed: Context;
      try {
        parsed = parseContext(envelope.data.context);
      } catch (cause) {
        return refusal(c, cause);
      }
      const shaped = shoContextSchema.safeParse(envelope.data.context);
      if (!shaped.success) return problem(c, 400, "input");

      cache.put(key, {
        fingerprint: envelope.data.fingerprint,
        revision: shaped.data.revision ?? null,
        compiled: engine.compile(parsed),
        phrases: shoContextPhrases(shaped.data),
        uploadBytes: inflated.body.byteLength,
      });
      return c.body(null, 204);
    },
  );

  app.get("/v1/contexts/:key/phrases", (c) => {
    const key = c.req.param("key");
    const query = shoPhrasesQuerySchema.safeParse({
      companyId: c.req.query("companyId"),
      limit: Number(c.req.query("limit") ?? SHO_PHRASES_LIMIT),
    });
    if (!shoContextKeySchema.safeParse(key).success || !query.success) {
      return problem(c, 400, "input");
    }
    if (!key.startsWith(`${query.data.companyId}:`)) {
      return problem(c, 400, "input");
    }
    const entry = cache.read(key);
    if (entry === null) return problem(c, 409, "context_required");
    return c.json({ phrases: entry.phrases.slice(0, query.data.limit) });
  });

  app.post(
    "/v1/parse",
    bodyLimit({
      maxSize: SHO_MAX_PARSE_BYTES,
      onError: (c) => problem(c, 400, "input"),
    }),
    async (c) => {
      const engine = options.engine();
      if (engine === null) {
        log({ requestId: null, outcome: "busy", ms: null });
        return problem(c, 503, "busy");
      }
      const request = shoParseRequestSchema.safeParse(
        parseJson(await c.req.text()),
      );
      if (!request.success) {
        log({ requestId: null, outcome: "input", ms: null });
        return problem(c, 400, "input");
      }
      const {
        requestId,
        companyId,
        contextKey,
        fingerprint,
        text,
        now,
        deadlineMs,
        debug,
      } = request.data;
      if (!contextKey.startsWith(`${companyId}:`)) {
        log({ requestId, outcome: "input", ms: null });
        return problem(c, 400, "input");
      }
      const entry = cache.fresh(contextKey, fingerprint);
      if (entry === null) {
        log({ requestId, outcome: "context_required", ms: null });
        return problem(c, 409, "context_required");
      }
      if (gate.depth >= queueLimit) {
        log({ requestId, outcome: "busy", ms: null });
        return problem(c, 503, "busy");
      }

      const previous: Previous | null =
        request.data.previous === undefined
          ? null
          : parsePrevious(request.data.previous);

      const deadlineAt = clock() + deadlineMs;
      const expiry = expiresIn(deadlineMs);
      const running = gate.run(async () => {
        if (clock() >= deadlineAt) return EXPIRED;
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
      running.catch(() => undefined);
      try {
        const ran = await Promise.race([running, expiry.reached]);
        if (ran === EXPIRED) {
          log({ requestId, outcome: "deadline", ms: null });
          return problem(c, 504, "deadline");
        }
        log({ requestId, outcome: "ok", ms: ran.ms });
        return c.json({
          model: { id: engine.stamp.id, md5: engine.stamp.md5 },
          contextRevision: entry.revision,
          result: ran.result,
          ms: ran.ms,
        });
      } catch (cause) {
        log({ requestId, outcome: "input", ms: null });
        return refusal(c, cause);
      } finally {
        expiry.cancel();
      }
    },
  );

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
