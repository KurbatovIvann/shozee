import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ConfigValidationError,
  ENV_SCHEMA_KEYS,
  S3_LOOPBACK_SIGNING_WARNING,
  classifyS3SigningHost,
  loadServerConfig,
  s3DeviceSigningWarning,
} from "./config.js";
import { createProcessLogger } from "./logger.js";

/** A fully specified, valid environment (mirrors `.env.example`). */
function validEnv(): Record<string, string> {
  return {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://showzy:showzy@localhost:5432/showzy",
    DATABASE_MIGRATE_URL:
      "postgresql://showzy_migrate:showzy@localhost:5432/showzy",
    REDIS_URL: "redis://localhost:6379",
    S3_ENDPOINT: "http://localhost:3900",
    S3_REGION: "us-east-1",
    S3_ACCESS_KEY_ID: "showzy-local",
    S3_SECRET_ACCESS_KEY: "showzy-local-secret",
    S3_FORCE_PATH_STYLE: "true",
    S3_BUCKET: "showzy",
    BETTER_AUTH_SECRET: "dev-only-secret-change-me-0000000000",
    BETTER_AUTH_URL: "http://localhost:3000",
    WEB_APP_ORIGINS: "http://localhost:5173",
    IP_HMAC_SECRET: "dev-only-ip-hmac-secret-change-me-00",
    TRUSTED_PROXIES: "10.0.0.1, 172.16.0.0/12",
    SENTRY_DSN: "https://key@sentry.example.com/42",
  };
}

describe("loadServerConfig", () => {
  it("parses a fully specified environment into the grouped config", () => {
    const config = loadServerConfig(validEnv());

    expect(config.nodeEnv).toBe("test");
    expect(config.database.url).toBe(
      "postgresql://showzy:showzy@localhost:5432/showzy",
    );
    expect(config.database.migrateUrl).toBe(
      "postgresql://showzy_migrate:showzy@localhost:5432/showzy",
    );
    expect(config.redis.url).toBe("redis://localhost:6379");
    expect(config.s3.endpoint).toBe("http://localhost:3900");
    expect(config.s3.publicEndpoint).toBe("http://localhost:3900");
    expect(config.s3.forcePathStyle).toBe(true);
    expect(config.s3.bucket).toBe("showzy");
    expect(config.s3).not.toHaveProperty("buckets");
    expect(config.auth.url).toBe("http://localhost:3000");
    expect(config.auth.webOrigins).toEqual(["http://localhost:5173"]);
    expect(config.rateLimit.ipHmacSecret).toBe(
      "dev-only-ip-hmac-secret-change-me-00",
    );
    expect(config.http.port).toBe(3000);
    expect(config.trustedProxies).toEqual(["10.0.0.1", "172.16.0.0/12"]);
    expect(config.sentry.dsn).toBe("https://key@sentry.example.com/42");
    expect(config.otpDelivery).toEqual({
      email: { transport: "stub" },
      sms: {
        transport: "stub",
        apiUrl: "https://sms-fly.ua/api/v2/api.php",
      },
    });
    expect(config.ai.anthropicApiKey).toBeUndefined();
    expect(config.ai.model).toBe("claude-sonnet-4-6");
    expect(config.ai.gateModel).toBe("claude-haiku-4-5");
    expect(config.ai.chatTurnsPerMinutePerUser).toBe(20);
    expect(config.ai.dailyBudgetUsdPerCompany).toBe(5);
    expect(config.ai.dailyBudgetUsdGlobal).toBe(100);
    expect(config.ai.unknownModelTurnUsd).toBe(0.1);
  });

  it("applies defaults for optional keys", () => {
    const env = validEnv();
    delete env["NODE_ENV"];
    delete env["DATABASE_MIGRATE_URL"];
    delete env["S3_REGION"];
    delete env["S3_FORCE_PATH_STYLE"];
    delete env["TRUSTED_PROXIES"];
    delete env["SENTRY_DSN"];
    delete env["API_PORT"];
    delete env["WEB_APP_ORIGINS"];

    const config = loadServerConfig(env);

    expect(config.nodeEnv).toBe("development");
    expect(config.http.port).toBe(3000);
    expect(config.database.migrateUrl).toBeUndefined();
    expect(config.s3.region).toBe("us-east-1");
    expect(config.s3.forcePathStyle).toBe(false);
    expect(config.s3.bucket).toBe("showzy");
    expect(config.s3.publicEndpoint).toBe(config.s3.endpoint);
    expect(config.trustedProxies).toEqual([]);
    expect(config.auth.webOrigins).toEqual([]);
    expect(config.sentry.dsn).toBeUndefined();
    expect(config.otpDelivery.email.transport).toBe("stub");
    expect(config.otpDelivery.sms).toEqual({
      transport: "stub",
      apiUrl: "https://sms-fly.ua/api/v2/api.php",
    });
    expect(config.ai.anthropicApiKey).toBeUndefined();
    expect(config.ai.model).toBe("claude-sonnet-4-6");
    expect(config.ai.gateModel).toBe("claude-haiku-4-5");
    expect(config.ai.chatTurnsPerMinutePerUser).toBe(20);
    expect(config.ai.dailyBudgetUsdPerCompany).toBe(5);
    expect(config.ai.dailyBudgetUsdGlobal).toBe(100);
    expect(config.ai.unknownModelTurnUsd).toBe(0.1);
  });

  it("fails fast on missing required keys and reports every one of them", () => {
    const env = validEnv();
    delete env["DATABASE_URL"];
    delete env["BETTER_AUTH_SECRET"];
    delete env["IP_HMAC_SECRET"];
    delete env["S3_BUCKET"];
    delete env["S3_ACCESS_KEY_ID"];
    delete env["S3_SECRET_ACCESS_KEY"];

    const load = () => loadServerConfig(env);

    expect(load).toThrow(ConfigValidationError);
    try {
      load();
    } catch (error) {
      const configError = error as ConfigValidationError;
      expect(configError.message).toContain("DATABASE_URL");
      expect(configError.message).toContain("BETTER_AUTH_SECRET");
      expect(configError.message).toContain("IP_HMAC_SECRET");
      expect(configError.message).toContain("S3_BUCKET");
      expect(configError.message).toContain("S3_ACCESS_KEY_ID");
      expect(configError.message).toContain("S3_SECRET_ACCESS_KEY");
      expect(configError.message).toContain("missing");
    }
  });

  it("fails fast on invalid values and aggregates all offending keys", () => {
    const env = validEnv();
    env["NODE_ENV"] = "staging";
    env["REDIS_URL"] = "http://not-redis:6379";
    env["TRUSTED_PROXIES"] = "10.0.0.1, not-an-ip";

    const load = () => loadServerConfig(env);

    expect(load).toThrow(ConfigValidationError);
    try {
      load();
    } catch (error) {
      const configError = error as ConfigValidationError;
      expect(configError.message).toContain("NODE_ENV");
      expect(configError.message).toContain("REDIS_URL");
      expect(configError.message).toContain("TRUSTED_PROXIES");
    }
  });

  it("never echoes secret values in the error, its issues, or nested causes", () => {
    const env = validEnv();
    // Each invalid secret carries a unique sentinel that must not surface.
    env["DATABASE_URL"] =
      "mysql://showzy:DB_PASSWORD_SENTINEL@localhost:3306/showzy";
    env["REDIS_URL"] = "redis-wrong://:REDIS_PASSWORD_SENTINEL@localhost:6379";
    env["BETTER_AUTH_SECRET"] = "AUTH_SECRET_SENTINEL";
    env["IP_HMAC_SECRET"] = "IP_HMAC_SECRET_SENTINEL";
    env["SENTRY_DSN"] = "not-a-url-SENTRY_KEY_SENTINEL";
    env["OTP_EMAIL_TRANSPORT"] = "resend";
    env["RESEND_API_KEY"] = "RESEND_API_KEY_SENTINEL";
    env["RESEND_FROM_EMAIL"] = "not-an-email";
    env["OTP_SMS_TRANSPORT"] = "sms-fly";
    env["SMS_FLY_API_KEY"] = "SMS_FLY_API_KEY_SENTINEL";
    env["ANTHROPIC_API_KEY"] = "ANTHROPIC_API_KEY_SENTINEL";

    let thrown: unknown;
    try {
      loadServerConfig(env);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigValidationError);
    const configError = thrown as ConfigValidationError;
    // The offending keys are named so the operator knows what to fix...
    expect(configError.message).toContain("DATABASE_URL");
    expect(configError.message).toContain("REDIS_URL");
    expect(configError.message).toContain("BETTER_AUTH_SECRET");
    expect(configError.message).toContain("IP_HMAC_SECRET");
    expect(configError.message).toContain("SENTRY_DSN");
    expect(configError.message).toContain("RESEND_FROM_EMAIL");
    // ...but no serialization of the error may contain a secret value.
    const everything = JSON.stringify({
      message: configError.message,
      issues: configError.issues,
      stack: configError.stack,
      cause: configError.cause,
    });
    expect(everything).not.toContain("SENTINEL");
  });

  it("treats empty strings as missing values", () => {
    const optional = validEnv();
    optional["SENTRY_DSN"] = "";
    expect(loadServerConfig(optional).sentry.dsn).toBeUndefined();

    const required = validEnv();
    required["DATABASE_URL"] = "";
    expect(() => loadServerConfig(required)).toThrow(ConfigValidationError);
    try {
      loadServerConfig(required);
    } catch (error) {
      expect((error as ConfigValidationError).message).toContain("missing");
    }

    const bucket = validEnv();
    bucket["S3_BUCKET"] = "";
    expect(() => loadServerConfig(bucket)).toThrow(ConfigValidationError);
    try {
      loadServerConfig(bucket);
    } catch (error) {
      expect((error as ConfigValidationError).message).toContain("S3_BUCKET");
      expect((error as ConfigValidationError).message).toContain("missing");
    }
  });

  it("never echoes S3 credentials in ConfigValidationError", () => {
    const env = validEnv();
    env["S3_ACCESS_KEY_ID"] = "S3_ACCESS_KEY_ID_SENTINEL";
    env["S3_SECRET_ACCESS_KEY"] = "S3_SECRET_ACCESS_KEY_SENTINEL";
    env["S3_ENDPOINT"] = "ftp://not-s3";

    let thrown: unknown;
    try {
      loadServerConfig(env);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigValidationError);
    const everything = JSON.stringify({
      message: (thrown as ConfigValidationError).message,
      issues: (thrown as ConfigValidationError).issues,
      stack: (thrown as ConfigValidationError).stack,
      cause: (thrown as ConfigValidationError).cause,
    });
    expect(everything).not.toContain("SENTINEL");
    expect(everything).toContain("S3_ENDPOINT");
    expect(everything).not.toContain("S3_SECRET_ACCESS_KEY_SENTINEL");
  });

  it("parses WEB_APP_ORIGINS as a comma-separated origin list", () => {
    const env = validEnv();
    env["WEB_APP_ORIGINS"] = "http://localhost:5173, https://panel.example.com";
    const config = loadServerConfig(env);
    expect(config.auth.webOrigins).toEqual([
      "http://localhost:5173",
      "https://panel.example.com",
    ]);
  });

  it("normalizes WEB_APP_ORIGINS entries to their origin (no path, no slash)", () => {
    const env = validEnv();
    env["WEB_APP_ORIGINS"] =
      "https://panel.example.com/, https://panel.example.com/sign-in";
    // Better-auth compares the request Origin header against the list, so a
    // trailing slash or path would silently never match. Entries that
    // normalize to the same origin collapse into one.
    expect(loadServerConfig(env).auth.webOrigins).toEqual([
      "https://panel.example.com",
    ]);
  });

  it("dedupes WEB_APP_ORIGINS entries that normalize to the same origin", () => {
    const env = validEnv();
    env["WEB_APP_ORIGINS"] =
      "https://panel.example.com, https://panel.example.com/, https://panel.example.com/sign-in, http://localhost:5173";
    // First occurrence wins; distinct origins keep their relative order.
    expect(loadServerConfig(env).auth.webOrigins).toEqual([
      "https://panel.example.com",
      "http://localhost:5173",
    ]);
  });

  it("rejects WEB_APP_ORIGINS entries that are not http(s) URLs", () => {
    for (const value of ["not-a-url", "showzy://", "ftp://panel.example.com"]) {
      const env = validEnv();
      env["WEB_APP_ORIGINS"] = value;
      expect(() => loadServerConfig(env)).toThrow(ConfigValidationError);
      try {
        loadServerConfig(env);
      } catch (error) {
        expect((error as ConfigValidationError).message).toContain(
          "WEB_APP_ORIGINS",
        );
      }
    }
  });

  it("signs client URLs against S3_PUBLIC_ENDPOINT when it is set", () => {
    const env = validEnv();
    env["S3_PUBLIC_ENDPOINT"] = "http://192.168.0.106:3900";
    const config = loadServerConfig(env);
    expect(config.s3.endpoint).toBe("http://localhost:3900");
    expect(config.s3.publicEndpoint).toBe("http://192.168.0.106:3900");
  });

  it("treats loopback S3_ENDPOINT + unset public endpoint as the device-break shape", () => {
    const env = validEnv();
    expect(env["S3_PUBLIC_ENDPOINT"]).toBeUndefined();
    const config = loadServerConfig(env);
    expect(config.s3.endpoint).toBe("http://localhost:3900");
    expect(config.s3.publicEndpoint).toBe(config.s3.endpoint);
    expect(config.s3.publicEndpoint).toBe("http://localhost:3900");
    expect(classifyS3SigningHost(config.s3.publicEndpoint)).toBe("loopback");
    expect(s3DeviceSigningWarning(config)).toEqual({
      s3SigningHostClass: "loopback",
    });
    expect(classifyS3SigningHost("http://127.0.0.1:3900")).toBe("loopback");
    expect(classifyS3SigningHost("http://[::1]:3900")).toBe("loopback");
    expect(classifyS3SigningHost("http://192.168.0.106:3900")).toBe(
      "non-loopback",
    );
    const lan = loadServerConfig({
      ...env,
      S3_PUBLIC_ENDPOINT: "http://192.168.0.106:3900",
    });
    expect(s3DeviceSigningWarning(lan)).toBeNull();
    expect(classifyS3SigningHost(lan.s3.publicEndpoint)).toBe("non-loopback");
  });

  it("loopback signing warning names the host class and never the endpoint or secrets", () => {
    const config = loadServerConfig(validEnv());
    const warning = s3DeviceSigningWarning(config);
    expect(warning).toEqual({ s3SigningHostClass: "loopback" });
    const serialized = JSON.stringify(warning);
    expect(serialized).toContain("loopback");
    expect(serialized).not.toContain("localhost");
    expect(serialized).not.toContain("3900");
    expect(serialized).not.toContain(config.s3.accessKeyId);
    expect(serialized).not.toContain(config.s3.secretAccessKey);
    expect(S3_LOOPBACK_SIGNING_WARNING).not.toContain("http://");
    expect(S3_LOOPBACK_SIGNING_WARNING).not.toContain("localhost");

    const lines: string[] = [];
    const logger = createProcessLogger({
      name: "s3-signing-warning-test",
      destination: {
        write(chunk: string) {
          lines.push(chunk);
        },
      },
    });
    logger.warn(warning, S3_LOOPBACK_SIGNING_WARNING);
    const payload = lines.join("\n");
    expect(payload).toContain("loopback");
    expect(payload).not.toContain("localhost:3900");
    expect(payload).not.toContain("showzy-local-secret");
  });

  it("allows a missing ANTHROPIC_API_KEY in test and maps AI_MODEL when set", () => {
    const missing = validEnv();
    expect(missing["ANTHROPIC_API_KEY"]).toBeUndefined();
    const withoutKey = loadServerConfig(missing);
    expect(withoutKey.ai.anthropicApiKey).toBeUndefined();
    expect(withoutKey.ai.model).toBe("claude-sonnet-4-6");
    expect(withoutKey.ai.gateModel).toBe("claude-haiku-4-5");

    const env = validEnv();
    env["ANTHROPIC_API_KEY"] = "sk-ant-test-not-a-real-key";
    env["AI_MODEL"] = "claude-opus-4-6";
    env["AI_GATE_MODEL"] = "claude-haiku-4-5-20251001";
    const withKey = loadServerConfig(env);
    expect(withKey.ai.anthropicApiKey).toBe("sk-ant-test-not-a-real-key");
    expect(withKey.ai.model).toBe("claude-opus-4-6");
    expect(withKey.ai.gateModel).toBe("claude-haiku-4-5-20251001");
  });

  it("maps assistant budget env, accepts 0 to disable limits, and rejects unknown-model 0", () => {
    const configured = validEnv();
    configured["AI_CHAT_TURNS_PER_MINUTE_PER_USER"] = "7";
    configured["AI_DAILY_BUDGET_USD_PER_COMPANY"] = "1.5";
    configured["AI_DAILY_BUDGET_USD_GLOBAL"] = "12.25";
    configured["AI_UNKNOWN_MODEL_TURN_USD"] = "0.2";
    const mapped = loadServerConfig(configured);
    expect(mapped.ai.chatTurnsPerMinutePerUser).toBe(7);
    expect(mapped.ai.dailyBudgetUsdPerCompany).toBe(1.5);
    expect(mapped.ai.dailyBudgetUsdGlobal).toBe(12.25);
    expect(mapped.ai.unknownModelTurnUsd).toBe(0.2);

    const disabled = validEnv();
    disabled["AI_CHAT_TURNS_PER_MINUTE_PER_USER"] = "0";
    disabled["AI_DAILY_BUDGET_USD_PER_COMPANY"] = "0";
    disabled["AI_DAILY_BUDGET_USD_GLOBAL"] = "0";
    const zeroed = loadServerConfig(disabled);
    expect(zeroed.ai.chatTurnsPerMinutePerUser).toBe(0);
    expect(zeroed.ai.dailyBudgetUsdPerCompany).toBe(0);
    expect(zeroed.ai.dailyBudgetUsdGlobal).toBe(0);
    expect(zeroed.ai.unknownModelTurnUsd).toBe(0.1);

    const unknownZero = validEnv();
    unknownZero["AI_UNKNOWN_MODEL_TURN_USD"] = "0";
    expect(() => loadServerConfig(unknownZero)).toThrow(ConfigValidationError);

    for (const key of [
      "AI_CHAT_TURNS_PER_MINUTE_PER_USER",
      "AI_DAILY_BUDGET_USD_PER_COMPANY",
      "AI_DAILY_BUDGET_USD_GLOBAL",
      "AI_UNKNOWN_MODEL_TURN_USD",
    ] as const) {
      const env = validEnv();
      env[key] = "-1";
      expect(() => loadServerConfig(env)).toThrow(ConfigValidationError);
      try {
        loadServerConfig(env);
      } catch (error) {
        const configError = error as ConfigValidationError;
        expect(configError.issues.some((issue) => issue.key === key)).toBe(
          true,
        );
      }
    }

    for (const key of [
      "AI_DAILY_BUDGET_USD_PER_COMPANY",
      "AI_DAILY_BUDGET_USD_GLOBAL",
      "AI_UNKNOWN_MODEL_TURN_USD",
    ] as const) {
      const env = validEnv();
      env[key] = "Infinity";
      expect(() => loadServerConfig(env)).toThrow(ConfigValidationError);
    }
  });

  it("treats an empty ANTHROPIC_API_KEY as unset", () => {
    const env = validEnv();
    env["ANTHROPIC_API_KEY"] = "";
    expect(loadServerConfig(env).ai.anthropicApiKey).toBeUndefined();
  });

  it("never echoes ANTHROPIC_API_KEY in ConfigValidationError", () => {
    const env = validEnv();
    env["ANTHROPIC_API_KEY"] = "ANTHROPIC_API_KEY_SENTINEL";
    env["NODE_ENV"] = "staging";

    let thrown: unknown;
    try {
      loadServerConfig(env);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigValidationError);
    const configError = thrown as ConfigValidationError;
    expect(configError.message).toContain("NODE_ENV");
    const everything = JSON.stringify({
      message: configError.message,
      issues: configError.issues,
      stack: configError.stack,
      cause: configError.cause,
    });
    expect(everything).not.toContain("SENTINEL");
    expect(everything).not.toContain("ANTHROPIC_API_KEY_SENTINEL");
    expect(everything).not.toContain("sk-ant-");
  });
});

describe("ENV_SCHEMA_KEYS vs .env.example", () => {
  it("lists the same keys the Zod env schema accepts", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../../.env.example", import.meta.url)),
      { encoding: "utf8" },
    );
    const exampleKeys = new Set<string>();
    for (const line of source.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) {
        continue;
      }
      const eq = trimmed.indexOf("=");
      if (eq <= 0) {
        continue;
      }
      exampleKeys.add(trimmed.slice(0, eq));
    }
    expect([...exampleKeys].sort()).toEqual([...ENV_SCHEMA_KEYS].sort());
  });
});

function liveOtpEnv(): Record<string, string> {
  return {
    ...validEnv(),
    OTP_EMAIL_TRANSPORT: "resend",
    RESEND_API_KEY: "re_test_not_a_real_key_000000",
    RESEND_FROM_EMAIL: "noreply@example.com",
    RESEND_FROM_NAME: "Шозі",
    OTP_SMS_TRANSPORT: "sms-fly",
    SMS_FLY_API_KEY: "test-sms-fly-key-not-real-0000",
    SMS_FLY_SENDER: "Showzy",
  };
}

describe("OTP delivery config", () => {
  it("defaults development and test to stub without live keys", () => {
    const development = validEnv();
    development["NODE_ENV"] = "development";
    const config = loadServerConfig(development);

    expect(config.otpDelivery.email).toEqual({ transport: "stub" });
    expect(config.otpDelivery.sms.transport).toBe("stub");
  });

  it("accepts live transports in non-production when keys and from-line are set", () => {
    const config = loadServerConfig(liveOtpEnv());

    expect(config.otpDelivery.email).toEqual({
      transport: "resend",
      apiKey: "re_test_not_a_real_key_000000",
      fromEmail: "noreply@example.com",
      fromName: "Шозі",
    });
    expect(config.otpDelivery.sms).toEqual({
      transport: "sms-fly",
      apiKey: "test-sms-fly-key-not-real-0000",
      apiUrl: "https://sms-fly.ua/api/v2/api.php",
      sender: "Showzy",
    });
  });

  it("accepts production when live transports and keys are present", () => {
    const env = liveOtpEnv();
    env["NODE_ENV"] = "production";
    const config = loadServerConfig(env);
    expect(config.nodeEnv).toBe("production");
    expect(config.otpDelivery.email.transport).toBe("resend");
    expect(config.otpDelivery.sms.transport).toBe("sms-fly");
  });

  it("fails production when live transports are missing", () => {
    const env = validEnv();
    env["NODE_ENV"] = "production";

    expect(() => loadServerConfig(env)).toThrow(ConfigValidationError);
    try {
      loadServerConfig(env);
    } catch (error) {
      const configError = error as ConfigValidationError;
      expect(configError.message).toContain("OTP_EMAIL_TRANSPORT");
      expect(configError.message).toContain("production requires resend");
      expect(configError.message).toContain("OTP_SMS_TRANSPORT");
      expect(configError.message).toContain("production requires sms-fly");
      expect(configError.issues).toEqual(
        expect.arrayContaining([
          {
            key: "OTP_EMAIL_TRANSPORT",
            message: "production requires resend",
          },
          { key: "OTP_SMS_TRANSPORT", message: "production requires sms-fly" },
        ]),
      );
    }
  });

  it("fails a live email transport that is missing its key or from-line", () => {
    const env = validEnv();
    env["OTP_EMAIL_TRANSPORT"] = "resend";

    expect(() => loadServerConfig(env)).toThrow(ConfigValidationError);
    try {
      loadServerConfig(env);
    } catch (error) {
      const configError = error as ConfigValidationError;
      expect(configError.message).toContain("RESEND_API_KEY");
      expect(configError.message).toContain("RESEND_FROM_EMAIL");
      expect(configError.message).toContain("RESEND_FROM_NAME");
      expect(configError.message).toContain("missing required value");
      expect(configError.issues).toEqual(
        expect.arrayContaining([
          { key: "RESEND_API_KEY", message: "missing required value" },
          { key: "RESEND_FROM_EMAIL", message: "missing required value" },
          { key: "RESEND_FROM_NAME", message: "missing required value" },
        ]),
      );
    }
  });

  it("fails a live SMS transport that is missing its key or sender", () => {
    const env = validEnv();
    env["OTP_SMS_TRANSPORT"] = "sms-fly";

    expect(() => loadServerConfig(env)).toThrow(ConfigValidationError);
    try {
      loadServerConfig(env);
    } catch (error) {
      const configError = error as ConfigValidationError;
      expect(configError.message).toContain("SMS_FLY_API_KEY");
      expect(configError.message).toContain("SMS_FLY_SENDER");
      expect(configError.message).toContain("missing required value");
      expect(configError.issues).toEqual(
        expect.arrayContaining([
          { key: "SMS_FLY_API_KEY", message: "missing required value" },
          { key: "SMS_FLY_SENDER", message: "missing required value" },
        ]),
      );
    }
  });

  it("never echoes OTP provider API keys in ConfigValidationError", () => {
    const env = validEnv();
    env["OTP_EMAIL_TRANSPORT"] = "resend";
    env["RESEND_API_KEY"] = "RESEND_API_KEY_SENTINEL";
    env["RESEND_FROM_EMAIL"] = "not-an-email";
    env["OTP_SMS_TRANSPORT"] = "sms-fly";
    env["SMS_FLY_API_KEY"] = "SMS_FLY_API_KEY_SENTINEL";
    env["SMS_FLY_SENDER"] = "Showzy";

    let thrown: unknown;
    try {
      loadServerConfig(env);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigValidationError);
    const everything = JSON.stringify({
      message: (thrown as ConfigValidationError).message,
      issues: (thrown as ConfigValidationError).issues,
      stack: (thrown as ConfigValidationError).stack,
      cause: (thrown as ConfigValidationError).cause,
    });
    expect(everything).not.toContain("SENTINEL");
    expect(everything).toContain("RESEND_FROM_EMAIL");
  });
});
