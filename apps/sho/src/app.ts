import { createHash, timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { InputError, parseContext } from "@showzy/sho";
import {
  SHO_MAX_CONTEXT_BYTES,
  SHO_MAX_PARSE_BYTES,
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

import { shoContextPhrases } from "./contexts.ts";
import { ShoRunFailure, type ShoEngine } from "./engine.ts";

export const SHO_HEALTH_PATH = "/v1/health";

export type ShoParseOutcome =
  "ok" | "input" | "context_required" | "busy" | "deadline" | "failed";

export interface ShoParseLogEntry {
  readonly requestId: string | null;
  readonly outcome: ShoParseOutcome;
  readonly ms: number | null;
}

export interface ShoAppOptions {
  readonly serviceToken: string;
  readonly engine: () => ShoEngine | null;
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

const PARSE_REFUSAL_STATUS: Record<
  "context_required" | "busy" | "deadline" | "input",
  ContentfulStatusCode
> = {
  context_required: 409,
  busy: 503,
  deadline: 504,
  input: 400,
};

const uploadEnvelopeSchema = z.object({
  fingerprint: shoContextUploadSchema.shape.fingerprint,
  context: z.unknown(),
});

export function createShoApp(options: ShoAppOptions): Hono {
  const log = options.log ?? ((): void => undefined);
  const app = new Hono();

  app.use("/v1/*", async (c, next) => {
    if (c.req.path === SHO_HEALTH_PATH) return next();
    const given = bearerOf(c.req.header("authorization"));
    if (!serviceTokenMatches(options.serviceToken, given)) {
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

      try {
        parseContext(envelope.data.context);
      } catch (cause) {
        return refusal(c, cause);
      }
      const shaped = shoContextSchema.safeParse(envelope.data.context);
      if (!shaped.success) return problem(c, 400, "input");

      const stored = await engine.store({
        key,
        fingerprint: envelope.data.fingerprint,
        revision: shaped.data.revision ?? null,
        context: envelope.data.context,
        phrases: shoContextPhrases(shaped.data),
        uploadBytes: inflated.body.byteLength,
      });
      if (stored.kind === "stored") return c.body(null, 204);
      if (stored.kind === "input") return problem(c, 400, "input");
      if (stored.kind === "busy") return problem(c, 503, "busy");
      throw new ShoRunFailure(stored.message);
    },
  );

  app.get("/v1/contexts/:key/phrases", async (c) => {
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
    const engine = options.engine();
    if (engine === null) return problem(c, 503, "busy");
    const phrases = await engine.phrases(key);
    if (phrases === null) return problem(c, 409, "context_required");
    return c.json({ phrases: phrases.slice(0, query.data.limit) });
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
      const asked = request.data;
      const requestId = asked.requestId;
      if (!asked.contextKey.startsWith(`${asked.companyId}:`)) {
        log({ requestId, outcome: "input", ms: null });
        return problem(c, 400, "input");
      }
      const ran = await engine.run({
        key: asked.contextKey,
        fingerprint: asked.fingerprint,
        text: asked.text,
        now: asked.now,
        previous: asked.previous ?? null,
        debug: asked.debug,
        deadlineMs: asked.deadlineMs,
      });
      if (ran.kind === "ok") {
        log({ requestId, outcome: "ok", ms: ran.ms });
        return c.json({
          model: { id: engine.stamp.id, md5: engine.stamp.md5 },
          contextRevision: ran.contextRevision,
          result: ran.result,
          ms: ran.ms,
        });
      }
      if (ran.kind === "failed") {
        log({ requestId, outcome: "failed", ms: null });
        throw new ShoRunFailure(ran.message);
      }
      log({ requestId, outcome: ran.kind, ms: null });
      return problem(c, PARSE_REFUSAL_STATUS[ran.kind], ran.kind);
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
