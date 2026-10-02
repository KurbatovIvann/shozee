import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { z } from "zod";

import {
  SHO_ERROR_CODES,
  SHO_MAX_CONTEXT_BYTES,
  SHO_PHRASES_LIMIT,
  shoContextKey,
  shoContextKeySchema,
  shoContextUploadSchema,
  shoErrorResponseSchema,
  shoHealthResponseSchema,
  shoModelResponseSchema,
  shoParseRequestSchema,
  shoParseResponseSchema,
  shoPhrasesLimitSchema,
  shoPhrasesResponseSchema,
  shoReadyResponseSchema,
  type ShoContext,
  type ShoErrorCode,
  type ShoModelResponse,
  type ShoParseRequest,
  type ShoParseResponse,
} from "./endpoints.js";
import { shoReplicaFor } from "./routing.js";

const gzipAsync = promisify(gzip);

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

export type ShoOk<Value> = { readonly outcome: "ok"; readonly value: Value };
export type ShoContextRequired = { readonly outcome: "context_required" };
export type ShoStored = { readonly outcome: "stored" };

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

export type ShoClientOptions = { readonly fetch?: ShoFetch };

export interface ShoParseInput extends Omit<ShoParseRequest, "contextKey"> {
  readonly scopeHash: string;
}

export interface ShoContextRequest {
  readonly companyId: string;
  readonly scopeHash: string;
  readonly fingerprint: string;
  readonly context: ShoContext;
}

export interface ShoPhrasesRequest {
  readonly companyId: string;
  readonly scopeHash: string;
  readonly limit?: number;
}

export interface ShoClient {
  readonly replicas: readonly string[];
  readonly replicaFor: (companyId: string) => string;
  readonly parse: (request: ShoParseInput) => Promise<ShoParseOutcome>;
  readonly putContext: (
    request: ShoContextRequest,
  ) => Promise<ShoContextOutcome>;
  readonly phrases: (request: ShoPhrasesRequest) => Promise<ShoPhrasesOutcome>;
  readonly model: (replicaUrl: string) => Promise<ShoModelOutcome>;
  readonly ready: (replicaUrl: string) => Promise<boolean>;
  readonly health: (replicaUrl: string) => Promise<boolean>;
}

type TransportFailure = Extract<ShoFallbackReason, "timeout" | "unreachable">;
type Received = { readonly status: number; readonly body: unknown };
type Sent = Received | TransportFailure;

const fallback = (
  reason: ShoFallbackReason,
  httpStatus: number | null,
): ShoFallback => ({ outcome: "fallback", reason, httpStatus });

const statusFallbacks: Partial<Record<number, ShoFallbackReason>> = {
  400: "input_rejected",
  413: "context_limit",
  503: "busy",
  504: "deadline",
};

const errorCodeFallbacks: Record<ShoErrorCode, ShoFallbackReason | null> = {
  context_required: null,
  context_limit: "context_limit",
  busy: "busy",
  deadline: "deadline",
  input: "input_rejected",
};

const isErrorCode = (value: string): value is ShoErrorCode =>
  (SHO_ERROR_CODES as readonly string[]).includes(value);

function statusOrBodyFallback({ status, body }: Received): ShoFallback {
  const parsed = shoErrorResponseSchema.safeParse(body);
  const byCode =
    parsed.success && isErrorCode(parsed.data.error)
      ? errorCodeFallbacks[parsed.data.error]
      : null;
  return fallback(
    statusFallbacks[status] ?? byCode ?? "unexpected_status",
    status,
  );
}

function keyFor(companyId: string, scopeHash: string): string | null {
  const key = shoContextKey(companyId, scopeHash);
  return shoContextKeySchema.safeParse(key).success ? key : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function decode<Schema extends z.ZodType>(
  sent: Sent,
  schema: Schema,
): ShoOk<z.infer<Schema>> | ShoFallback {
  if (typeof sent === "string") return fallback(sent, null);
  if (sent.status !== 200) return statusOrBodyFallback(sent);
  const parsed = schema.safeParse(sent.body);
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
      const response = await send(`${replicaUrl}${path}`, {
        ...init,
        redirect: "error",
        signal: controller.signal,
        headers,
      });
      return {
        status: response.status,
        body: parseJson(await response.text()),
      };
    } catch {
      return controller.signal.aborted ? "timeout" : "unreachable";
    } finally {
      clearTimeout(timer);
    }
  }

  async function read<Schema extends z.ZodType>(
    replicaUrl: string,
    path: string,
    schema: Schema,
  ): Promise<ShoOk<z.infer<Schema>> | ShoFallback> {
    if (!urls.includes(replicaUrl)) return fallback("input_rejected", null);
    return decode(await request(replicaUrl, path, { method: "GET" }), schema);
  }

  const replicaFor = (companyId: string) => shoReplicaFor(urls, companyId);

  return {
    replicas: urls,
    replicaFor,

    async parse({ scopeHash, ...rest }) {
      const wire = shoParseRequestSchema.safeParse({
        ...rest,
        contextKey: shoContextKey(rest.companyId, scopeHash),
      });
      if (!wire.success) return fallback("input_rejected", null);
      const sent = await request(replicaFor(rest.companyId), "/v1/parse", {
        method: "POST",
        body: JSON.stringify(wire.data),
        headers: { "content-type": "application/json" },
      });
      if (typeof sent !== "string" && sent.status === 409) {
        return { outcome: "context_required" };
      }
      return decode(sent, shoParseResponseSchema);
    },

    async putContext(contextRequest) {
      const upload = shoContextUploadSchema.safeParse({
        fingerprint: contextRequest.fingerprint,
        context: contextRequest.context,
      });
      const key = keyFor(contextRequest.companyId, contextRequest.scopeHash);
      if (!upload.success || key === null) {
        return fallback("input_rejected", null);
      }
      const payload = Buffer.from(JSON.stringify(upload.data), "utf8");
      if (payload.byteLength > SHO_MAX_CONTEXT_BYTES) {
        return fallback("context_limit", null);
      }
      const body = await gzipAsync(payload);
      const sent = await request(
        replicaFor(contextRequest.companyId),
        `/v1/contexts/${encodeURIComponent(key)}`,
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
      return statusOrBodyFallback(sent);
    },

    async phrases(phrasesRequest) {
      const key = keyFor(phrasesRequest.companyId, phrasesRequest.scopeHash);
      const limit = phrasesRequest.limit ?? SHO_PHRASES_LIMIT;
      if (key === null || !shoPhrasesLimitSchema.safeParse(limit).success) {
        return fallback("input_rejected", null);
      }
      const query = new URLSearchParams({
        companyId: phrasesRequest.companyId,
        limit: String(limit),
      });
      const sent = await request(
        replicaFor(phrasesRequest.companyId),
        `/v1/contexts/${encodeURIComponent(key)}/phrases?${query.toString()}`,
        { method: "GET" },
      );
      const outcome = decode(sent, shoPhrasesResponseSchema);
      return outcome.outcome === "ok"
        ? { outcome: "ok", value: outcome.value.phrases }
        : outcome;
    },

    async model(replicaUrl) {
      return read(replicaUrl, "/v1/model", shoModelResponseSchema);
    },

    async ready(replicaUrl) {
      const got = await read(replicaUrl, "/v1/ready", shoReadyResponseSchema);
      return got.outcome === "ok" && got.value.ready;
    },

    async health(replicaUrl) {
      const got = await read(replicaUrl, "/v1/health", shoHealthResponseSchema);
      return got.outcome === "ok";
    },
  };
}
