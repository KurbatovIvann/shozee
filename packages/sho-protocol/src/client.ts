import { gzipSync } from "node:zlib";
import { z } from "zod";

import {
  SHO_ERROR_CODES,
  SHO_MAX_CONTEXT_BYTES,
  shoContextKeySchema,
  shoContextUploadSchema,
  shoErrorResponseSchema,
  shoModelResponseSchema,
  shoParseResponseSchema,
  shoPhrasesResponseSchema,
  shoReadyResponseSchema,
  type ShoErrorCode,
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

interface Received {
  readonly status: number;
  readonly body: unknown;
}

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
        signal: controller.signal,
        headers,
      });
      return { status: response.status, body: parseJson(await response.text()) };
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
      const upload = shoContextUploadSchema.safeParse({
        fingerprint: contextRequest.fingerprint,
        context: contextRequest.context,
      });
      const key = shoContextKeySchema.safeParse(contextRequest.contextKey);
      if (!upload.success || !key.success) {
        return fallback("input_rejected", null);
      }
      const payload = Buffer.from(JSON.stringify(upload.data), "utf8");
      if (payload.byteLength > SHO_MAX_CONTEXT_BYTES) {
        return fallback("context_limit", null);
      }
      const body = gzipSync(payload);
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
      return statusOrBodyFallback(sent);
    },

    async phrases(phrasesRequest) {
      if (!shoContextKeySchema.safeParse(phrasesRequest.contextKey).success) {
        return fallback("input_rejected", null);
      }
      const limit = phrasesRequest.limit ?? 1000;
      const sent = await request(
        replicaFor(phrasesRequest.companyId),
        `/v1/contexts/${encodeURIComponent(phrasesRequest.contextKey)}/phrases?limit=${String(limit)}`,
        { method: "GET" },
      );
      const outcome = decode(sent, shoPhrasesResponseSchema);
      return outcome.outcome === "ok"
        ? { outcome: "ok", value: outcome.value.phrases }
        : outcome;
    },

    async model(replicaUrl) {
      if (!urls.includes(replicaUrl)) return fallback("input_rejected", null);
      return decode(
        await request(replicaUrl, "/v1/model", { method: "GET" }),
        shoModelResponseSchema,
      );
    },

    async ready(replicaUrl) {
      if (!urls.includes(replicaUrl)) return false;
      const outcome = decode(
        await request(replicaUrl, "/v1/ready", { method: "GET" }),
        shoReadyResponseSchema,
      );
      return outcome.outcome === "ok" && outcome.value.ready;
    },
  };
}
