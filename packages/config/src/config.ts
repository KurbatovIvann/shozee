import { z } from "zod";

/**
 * Env keys whose values are credentials or may embed credentials (connection
 * URLs carry passwords, a Sentry DSN carries its key). Validation issues for
 * these keys are redacted before they reach the error message — a boot
 * failure log must never leak a secret (security-operations §4).
 */
const SECRET_ENV_KEYS: ReadonlySet<string> = new Set([
  "DATABASE_URL",
  "DATABASE_MIGRATE_URL",
  "REDIS_URL",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "BETTER_AUTH_SECRET",
  "IP_HMAC_SECRET",
  "SENTRY_DSN",
  "RESEND_API_KEY",
  "SMS_FLY_API_KEY",
  "ANTHROPIC_API_KEY",
]);

const DEFAULT_SMS_FLY_API_URL = "https://sms-fly.ua/api/v2/api.php";

const trustedProxyEntry = z.union([z.ipv4(), z.ipv6(), z.cidrv4(), z.cidrv6()]);

const envObjectSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  /** Runtime-role connection (`showzy_app` once fnd-T4 creates the roles). */
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  /** Migration-role connection; only the CI/deploy migration step needs it. */
  DATABASE_MIGRATE_URL: z.url({ protocol: /^postgres(ql)?$/ }).optional(),

  REDIS_URL: z.url({ protocol: /^rediss?$/ }),

  S3_ENDPOINT: z.url({ protocol: /^https?$/ }),
  /**
   * Host clients use for signed PUT/GET URLs. The API/worker keep talking
   * to `S3_ENDPOINT`. Empty = same as `S3_ENDPOINT` (device-break when
   * that host is loopback). Set this to the machine LAN address
   * (`http://192.168.x.x:3900`) when a physical device uploads to local
   * Garage — phones cannot reach localhost. API boot warns on loopback.
   */
  S3_PUBLIC_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
  S3_REGION: z.string().min(1).default("us-east-1"),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  /** Garage (local) needs path-style addressing; R2 in prod does not. */
  S3_FORCE_PATH_STYLE: z.stringbool().default(false),
  /**
   * Single private bucket (ADR-0027). Local compose/.env.example use
   * `showzy`. Missing or empty fails boot — empty string is unset.
   */
  S3_BUCKET: z.string().min(1),

  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.url({ protocol: /^https?$/ }),

  /**
   * Comma-separated browser origins of the web panel (ADR-0030). Each entry
   * joins better-auth `trustedOrigins`; empty means "no web panel" (the API
   * origin and the Expo scheme are always trusted). Entries are normalized
   * to their origin (`scheme://host[:port]`) — better-auth compares the
   * request `Origin` header against the list, so paths would never match —
   * and entries that normalize to the same origin collapse to one.
   */
  WEB_APP_ORIGINS: z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    )
    .pipe(
      z.array(
        z
          .url({ protocol: /^https?$/ })
          .transform((entry) => new URL(entry).origin),
      ),
    )
    .transform((origins) => [...new Set(origins)]),

  /**
   * HMAC secret for public rate-limit bucket keys (core.md §10). Rotating
   * IP HMACs must not be derivable from data; this value is injected into
   * `createRateLimitHook` at API boot (fnd-T26).
   */
  IP_HMAC_SECRET: z.string().min(32),

  /** HTTP listen port for `apps/api` (and later `apps/worker` admin if any). */
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  /**
   * Comma-separated ingress proxy IPs/CIDRs. Forwarded-IP headers are trusted
   * only from these addresses (security-operations §2); empty means "trust no
   * proxy" — the socket peer address is the client.
   */
  TRUSTED_PROXIES: z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    )
    .pipe(z.array(trustedProxyEntry)),

  SENTRY_DSN: z.url().optional(),

  /**
   * OTP delivery transports. Development/test default to `stub` (no I/O).
   * Production must select the live vendors; adapters are composed in apps/api.
   */
  OTP_EMAIL_TRANSPORT: z.enum(["resend", "stub"]).default("stub"),
  OTP_SMS_TRANSPORT: z.enum(["sms-fly", "stub"]).default("stub"),
  RESEND_API_KEY: z.string().min(1).optional(),
  RESEND_FROM_EMAIL: z.email().optional(),
  RESEND_FROM_NAME: z.string().min(1).optional(),
  SMS_FLY_API_KEY: z.string().min(1).optional(),
  SMS_FLY_API_URL: z
    .url({ protocol: /^https?$/ })
    .default(DEFAULT_SMS_FLY_API_URL),
  SMS_FLY_SENDER: z.string().min(1).optional(),

  /**
   * Anthropic API key for the staff-panel AI loop (`packages/ai`, ADR-0032).
   * Optional in every environment so development/test (and CI) boot without
   * a paid key. The SSE mount fails typed when it is unset — do not read
   * this from `process.env` outside this package.
   */
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  /**
   * Staff-panel model id. Provider choice is config, not a runtime swap
   * (ADR-0032). Default matches the SHO-318 pin.
   */
  AI_MODEL: z.string().min(1).default("claude-sonnet-4-6"),
  /**
   * Cheap classifier / chitchat model id (same Anthropic provider, not a
   * second `@ai-sdk/*` package). Not a secret. Default Haiku 4.5.
   */
  AI_GATE_MODEL: z.string().min(1).default("claude-haiku-4-5"),
  /**
   * Staff-assistant HTTP turn bucket (`POST /assistant/chat`). `0` disables
   * the per-user turn check (SHO-505). Default 20 turns / 60s / user.
   */
  AI_CHAT_TURNS_PER_MINUTE_PER_USER: z.coerce.number().int().min(0).default(20),
  /**
   * Kyiv-calendar daily USD ceiling per company for `/assistant/chat`.
   * `0` disables the company check. Default 5.
   */
  AI_DAILY_BUDGET_USD_PER_COMPANY: z.coerce.number().finite().min(0).default(5),
  /**
   * Kyiv-calendar daily USD ceiling across every company. `0` disables
   * the global check. Default 100.
   */
  AI_DAILY_BUDGET_USD_GLOBAL: z.coerce.number().finite().min(0).default(100),
  /**
   * Budget spend charged when `estimateStaffAssistantTurnCostUsd` is
   * `null` (unpriced model). Not a disable switch — `0` means an unknown
   * model adds nothing. Default 0.10.
   */
  AI_UNKNOWN_MODEL_TURN_USD: z.coerce.number().finite().min(0).default(0.1),
});

const envSchema = envObjectSchema.superRefine((parsed, ctx) => {
  if (parsed.NODE_ENV === "production") {
    if (parsed.OTP_EMAIL_TRANSPORT !== "resend") {
      ctx.addIssue({
        code: "custom",
        path: ["OTP_EMAIL_TRANSPORT"],
        message: "production requires resend",
      });
    }
    if (parsed.OTP_SMS_TRANSPORT !== "sms-fly") {
      ctx.addIssue({
        code: "custom",
        path: ["OTP_SMS_TRANSPORT"],
        message: "production requires sms-fly",
      });
    }
  }

  if (parsed.OTP_EMAIL_TRANSPORT === "resend") {
    if (parsed.RESEND_API_KEY === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["RESEND_API_KEY"],
        message: "missing required value",
      });
    }
    if (parsed.RESEND_FROM_EMAIL === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["RESEND_FROM_EMAIL"],
        message: "missing required value",
      });
    }
    if (parsed.RESEND_FROM_NAME === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["RESEND_FROM_NAME"],
        message: "missing required value",
      });
    }
  }

  if (parsed.OTP_SMS_TRANSPORT === "sms-fly") {
    if (parsed.SMS_FLY_API_KEY === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["SMS_FLY_API_KEY"],
        message: "missing required value",
      });
    }
    if (parsed.SMS_FLY_SENDER === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["SMS_FLY_SENDER"],
        message: "missing required value",
      });
    }
  }
});

type ParsedEnv = z.infer<typeof envSchema>;

/** Keys the Zod env schema accepts — `.env.example` must list the same set. */
export const ENV_SCHEMA_KEYS: readonly string[] = Object.freeze(
  Object.keys(envObjectSchema.shape),
);

/** Validated runtime configuration, grouped by concern. */
export interface ServerConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly database: {
    readonly url: string;
    readonly migrateUrl: string | undefined;
  };
  readonly redis: { readonly url: string };
  readonly s3: {
    readonly endpoint: string;
    /** Signed URL host; equals `endpoint` when `S3_PUBLIC_ENDPOINT` is unset. */
    readonly publicEndpoint: string;
    readonly region: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly forcePathStyle: boolean;
    readonly bucket: string;
  };
  readonly auth: {
    readonly secret: string;
    readonly url: string;
    /** Web panel origins joining better-auth `trustedOrigins` (ADR-0030). */
    readonly webOrigins: readonly string[];
  };
  readonly rateLimit: { readonly ipHmacSecret: string };
  readonly http: { readonly port: number };
  readonly trustedProxies: readonly string[];
  readonly sentry: { readonly dsn: string | undefined };
  readonly otpDelivery: {
    readonly email:
      | { readonly transport: "stub" }
      | {
          readonly transport: "resend";
          readonly apiKey: string;
          readonly fromEmail: string;
          readonly fromName: string;
        };
    readonly sms:
      | { readonly transport: "stub"; readonly apiUrl: string }
      | {
          readonly transport: "sms-fly";
          readonly apiKey: string;
          readonly apiUrl: string;
          readonly sender: string;
        };
  };
  readonly ai: {
    readonly anthropicApiKey: string | undefined;
    readonly model: string;
    readonly gateModel: string;
    /** `0` disables the per-user `/assistant/chat` turn check. */
    readonly chatTurnsPerMinutePerUser: number;
    /** `0` disables the per-company Kyiv-day USD check. */
    readonly dailyBudgetUsdPerCompany: number;
    /** `0` disables the global Kyiv-day USD check. */
    readonly dailyBudgetUsdGlobal: number;
    /** Spend used when the turn cost estimate is `null`. */
    readonly unknownModelTurnUsd: number;
  };
}

/** One redacted, operator-facing validation problem. */
export interface ConfigIssue {
  readonly key: string;
  readonly message: string;
}

/**
 * Thrown by {@link loadServerConfig} when the environment is invalid. Names
 * the offending keys but never their values; safe to log as-is.
 */
export class ConfigValidationError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    const lines = issues.map((issue) => `  - ${issue.key}: ${issue.message}`);
    super(`Invalid environment configuration:\n${lines.join("\n")}`);
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

/**
 * Parse and validate the process environment. Call once at process boot and
 * pass the result down explicitly — an invalid environment must crash the
 * process before it serves anything (fail-fast).
 *
 * Empty-string values are treated as unset so a templated `.env` with blank
 * optional lines behaves like a missing line.
 */
export function loadServerConfig(
  env: Record<string, string | undefined> = process.env,
): ServerConfig {
  const present: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value !== "") {
      present[key] = value;
    }
  }

  const result = envSchema.safeParse(present);
  if (!result.success) {
    throw new ConfigValidationError(
      result.error.issues.map((issue) => {
        const key = String(issue.path[0] ?? "(root)");
        // OTP transport rules live on the schema (`superRefine`). Keep those
        // custom messages even when the key was omitted from `present`
        // (`OTP_EMAIL_TRANSPORT` defaults to stub, then production rejects it).
        if (issue.code === "custom") {
          return { key, message: issue.message };
        }
        if (!(key in present)) {
          return { key, message: "missing required value" };
        }
        if (SECRET_ENV_KEYS.has(key)) {
          return {
            key,
            message: "invalid value (redacted — see .env.example)",
          };
        }
        return { key, message: issue.message };
      }),
    );
  }

  const parsed = result.data;
  return {
    nodeEnv: parsed.NODE_ENV,
    database: {
      url: parsed.DATABASE_URL,
      migrateUrl: parsed.DATABASE_MIGRATE_URL,
    },
    redis: { url: parsed.REDIS_URL },
    s3: {
      endpoint: parsed.S3_ENDPOINT,
      publicEndpoint: parsed.S3_PUBLIC_ENDPOINT ?? parsed.S3_ENDPOINT,
      region: parsed.S3_REGION,
      accessKeyId: parsed.S3_ACCESS_KEY_ID,
      secretAccessKey: parsed.S3_SECRET_ACCESS_KEY,
      forcePathStyle: parsed.S3_FORCE_PATH_STYLE,
      bucket: parsed.S3_BUCKET,
    },
    auth: {
      secret: parsed.BETTER_AUTH_SECRET,
      url: parsed.BETTER_AUTH_URL,
      webOrigins: parsed.WEB_APP_ORIGINS,
    },
    rateLimit: { ipHmacSecret: parsed.IP_HMAC_SECRET },
    http: { port: parsed.API_PORT },
    trustedProxies: parsed.TRUSTED_PROXIES,
    sentry: { dsn: parsed.SENTRY_DSN },
    otpDelivery: mapOtpDelivery(parsed),
    ai: {
      anthropicApiKey: parsed.ANTHROPIC_API_KEY,
      model: parsed.AI_MODEL,
      gateModel: parsed.AI_GATE_MODEL,
      chatTurnsPerMinutePerUser: parsed.AI_CHAT_TURNS_PER_MINUTE_PER_USER,
      dailyBudgetUsdPerCompany: parsed.AI_DAILY_BUDGET_USD_PER_COMPANY,
      dailyBudgetUsdGlobal: parsed.AI_DAILY_BUDGET_USD_GLOBAL,
      unknownModelTurnUsd: parsed.AI_UNKNOWN_MODEL_TURN_USD,
    },
  };
}

function mapOtpDelivery(parsed: ParsedEnv): ServerConfig["otpDelivery"] {
  return {
    email: mapOtpEmail(parsed),
    sms: mapOtpSms(parsed),
  };
}

/**
 * superRefine already rejected the missing-key shapes. TypeScript does not
 * narrow optional env fields from custom issues, so this is the mapping
 * gate — same message as parse-time, unreachable after a successful parse.
 */
function requireOtpString(value: string | undefined, key: string): string {
  if (value === undefined) {
    throw new ConfigValidationError([
      { key, message: "missing required value" },
    ]);
  }
  return value;
}

function mapOtpEmail(parsed: ParsedEnv): ServerConfig["otpDelivery"]["email"] {
  if (parsed.OTP_EMAIL_TRANSPORT === "resend") {
    return {
      transport: "resend",
      apiKey: requireOtpString(parsed.RESEND_API_KEY, "RESEND_API_KEY"),
      fromEmail: requireOtpString(
        parsed.RESEND_FROM_EMAIL,
        "RESEND_FROM_EMAIL",
      ),
      fromName: requireOtpString(parsed.RESEND_FROM_NAME, "RESEND_FROM_NAME"),
    };
  }
  return { transport: "stub" };
}

function mapOtpSms(parsed: ParsedEnv): ServerConfig["otpDelivery"]["sms"] {
  if (parsed.OTP_SMS_TRANSPORT === "sms-fly") {
    return {
      transport: "sms-fly",
      apiKey: requireOtpString(parsed.SMS_FLY_API_KEY, "SMS_FLY_API_KEY"),
      apiUrl: parsed.SMS_FLY_API_URL,
      sender: requireOtpString(parsed.SMS_FLY_SENDER, "SMS_FLY_SENDER"),
    };
  }
  return { transport: "stub", apiUrl: parsed.SMS_FLY_API_URL };
}

/** Host class of a signed-URL endpoint. Never log the URL itself. */
export type S3SigningHostClass = "loopback" | "non-loopback";

/**
 * Classify the host clients will call for signed PUT/GET. Loopback
 * (`localhost`, `127.0.0.0/8`, `::1`) is the local-dev device-break
 * shape: phones on the LAN cannot reach the API machine's loopback.
 */
export function classifyS3SigningHost(endpoint: string): S3SigningHostClass {
  let hostname: string;
  try {
    hostname = new URL(endpoint).hostname.toLowerCase();
  } catch {
    return "non-loopback";
  }
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1);
  }
  if (hostname === "localhost" || hostname === "::1") {
    return "loopback";
  }
  if (hostname.startsWith("127.")) {
    return "loopback";
  }
  return "non-loopback";
}

/**
 * Boot-warning payload when signed URLs target loopback. Fields are host
 * class only — no endpoint, credentials, or object keys.
 */
export function s3DeviceSigningWarning(
  config: Pick<ServerConfig, "s3">,
): { readonly s3SigningHostClass: "loopback" } | null {
  if (classifyS3SigningHost(config.s3.publicEndpoint) !== "loopback") {
    return null;
  }
  return { s3SigningHostClass: "loopback" };
}

export const S3_LOOPBACK_SIGNING_WARNING =
  "S3 signing host is loopback; LAN devices cannot reach signed PUT/GET URLs. Set S3_PUBLIC_ENDPOINT to a LAN-reachable Garage host.";
