import { gzipSync } from "node:zlib";
import { z } from "zod";

import {
  shoModelResponseSchema,
  shoParseResponseSchema,
  shoPhrasesResponseSchema,
  shoReadyResponseSchema,
  type ShoModelResponse,
  type ShoParseRequest,
  type ShoParseResponse,
} from "./endpoints.js";
import { shoReplicaFor } from "./routing.js";

export const SHO_DEFAULT_TIMEOUT_MS = 1500;

export const SHO_FALLBACK_REASONS = [
  "input_rejected",
  "context_limit",
  "busy",
  "deadline",
  "timeout",
  "unreachable",
  "unreadable",
  "unexpected_status",
] as const;

export type ShoFallbackReason = (typeof SHO_FALLBACK_REASONS)[number];

export interface ShoFallback {
  readonly outcome: "fallback";
  readonly reason: ShoFallbackReason;
  readonly httpStatus: number | null;
}

export interface ShoOk<Value> {
  readonly outcome: "ok";
  readonly value: Value;
}

export interface ShoContextRequired {
  readonly outcome: "context_required";
}

export interface ShoStored {
  readonly outcome: "stored";
}

export type ShoParseOutcome =
  ShoOk<ShoParseResponse> | ShoContextRequired | ShoFallback;

export type ShoContextOutcome = ShoStored | ShoFallback;

export type ShoPhrasesOutcome = ShoOk<readonly string[]> | ShoFallback;

export type ShoModelOutcome = ShoOk<ShoModelResponse> | ShoFallback;

export const shoClientConfigSchema = z.object({
  urls: z.array(z.url({ protocol: /^https?$/ })).min(1),
  token: z.string().min(1),
  timeoutMs: z.number().int().positive().default(SHO_DEFAULT_TIMEOUT_MS),
});

export type ShoClientConfig = z.input<typeof shoClientConfigSchema>;

export type ShoFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface ShoClientOptions {
  readonly fetch?: ShoFetch;
}

export interface ShoContextRequest {
  readonly companyId: string;
  readonly contextKey: string;
  readonly fingerprint: string;
  readonly context: unknown;
}

export interface ShoPhrasesRequest {
  readonly companyId: string;
  readonly contextKey: string;
  readonly limit?: number;
}

export interface ShoClient {
  readonly replicas: readonly string[];
  readonly replicaFor: (companyId: string) => string;
  readonly parse: (request: ShoParseRequest) => Promise<ShoParseOutcome>;
  readonly putContext: (
    request: ShoContextRequest,
  ) => Promise<ShoContextOutcome>;
  readonly phrases: (request: ShoPhrasesRequest) => Promise<ShoPhrasesOutcome>;
  readonly model: (replicaUrl: string) => Promise<ShoModelOutcome>;
  readonly ready: (replicaUrl: string) => Promise<boolean>;
}

type TransportFailure = Extract<ShoFallbackReason, "timeout" | "unreachable">;

type Sent = Response | TransportFailure;

const fallback = (
  reason: ShoFallbackReason,
  httpStatus: number | null,
): ShoFallback => ({ outcome: "fallback", reason, httpStatus });

function statusFallback(status: number): ShoFallback | null {
  if (status === 400) return fallback("input_rejected", status);
  if (status === 413) return fallback("context_limit", status);
  if (status === 503) return fallback("busy", status);
  if (status === 504) return fallback("deadline", status);
  return null;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function decode<Schema extends z.ZodType>(
  sent: Sent,
  schema: Schema,
): Promise<ShoOk<z.infer<Schema>> | ShoFallback> {
  if (typeof sent === "string") return fallback(sent, null);
  const mapped = statusFallback(sent.status);
  if (mapped) return mapped;
  if (sent.status !== 200) return fallback("unexpected_status", sent.status);
  const parsed = schema.safeParse(await readJson(sent));
  return parsed.success
    ? { outcome: "ok", value: parsed.data }
    : fallback("unreadable", sent.status);
}

export function createShoClient(
  config: ShoClientConfig,
  options: ShoClientOptions = {},
): ShoClient {
  const { urls, token, timeoutMs } = shoClientConfigSchema.parse(config);
  const send = options.fetch ?? ((input, init) => fetch(input, init));

  async function request(
    replicaUrl: string,
    path: string,
    init: RequestInit,
  ): Promise<Sent> {
    const controller = new AbortController();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      return await send(`${replicaUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers,
      });
    } catch {
      return controller.signal.aborted ? "timeout" : "unreachable";
    } finally {
      clearTimeout(timer);
    }
  }

  const replicaFor = (companyId: string): string =>
    shoReplicaFor(urls, companyId);

  return {
    replicas: urls,
    replicaFor,

    async parse(parseRequest) {
      const sent = await request(
        replicaFor(parseRequest.companyId),
        "/v1/parse",
        {
          method: "POST",
          body: JSON.stringify(parseRequest),
          headers: { "content-type": "application/json" },
        },
      );
      if (typeof sent !== "string" && sent.status === 409) {
        return { outcome: "context_required" };
      }
      return decode(sent, shoParseResponseSchema);
    },

    async putContext(contextRequest) {
      const body = gzipSync(
        Buffer.from(
          JSON.stringify({
            fingerprint: contextRequest.fingerprint,
            context: contextRequest.context,
          }),
          "utf8",
        ),
      );
      const sent = await request(
        replicaFor(contextRequest.companyId),
        `/v1/contexts/${encodeURIComponent(contextRequest.contextKey)}`,
        {
          method: "PUT",
          body: new Uint8Array(body),
          headers: {
            "content-type": "application/json",
            "content-encoding": "gzip",
          },
        },
      );
      if (typeof sent === "string") return fallback(sent, null);
      if (sent.status === 204) return { outcome: "stored" };
      return (
        statusFallback(sent.status) ??
        fallback("unexpected_status", sent.status)
      );
    },

    async phrases(phrasesRequest) {
      const limit = phrasesRequest.limit ?? 1000;
      const sent = await request(
        replicaFor(phrasesRequest.companyId),
        `/v1/contexts/${encodeURIComponent(phrasesRequest.contextKey)}/phrases?limit=${String(limit)}`,
        { method: "GET" },
      );
      const outcome = await decode(sent, shoPhrasesResponseSchema);
      return outcome.outcome === "ok"
        ? { outcome: "ok", value: outcome.value.phrases }
        : outcome;
    },

    async model(replicaUrl) {
      return decode(
        await request(replicaUrl, "/v1/model", { method: "GET" }),
        shoModelResponseSchema,
      );
    },

    async ready(replicaUrl) {
      const outcome = await decode(
        await request(replicaUrl, "/v1/ready", { method: "GET" }),
        shoReadyResponseSchema,
      );
      return outcome.outcome === "ok" && outcome.value.ready;
    },
  };
}
