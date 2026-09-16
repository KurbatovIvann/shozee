import { describe, expect, it } from "vitest";

import {
  REDACTED,
  isSensitiveKey,
  redactText,
  redactUnknown,
  scrubTelemetryEvent,
} from "./redact.js";

const OTP = "847291";
const AUTH_SECRET = "AUTH_SECRET_SENTINEL_do_not_log";
const DB_PASSWORD = "DB_PASSWORD_SENTINEL";
const REDIS_PASSWORD = "REDIS_PASSWORD_SENTINEL";
const SENTRY_KEY = "SENTRY_KEY_SENTINEL";
const BEARER = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.sentinel";
const PHONE = "+380501234567";
const EMAIL = "owner@example.com";
const RAW_IP = "203.0.113.44";

describe("isSensitiveKey", () => {
  it("matches policy names regardless of separators and case", () => {
    expect(isSensitiveKey("otp")).toBe(true);
    expect(isSensitiveKey("OTP_CODE")).toBe(true);
    expect(isSensitiveKey("authorization")).toBe(true);
    expect(isSensitiveKey("secretAccessKey")).toBe(true);
    expect(isSensitiveKey("ip_hmac_secret")).toBe(true);
    expect(isSensitiveKey("RESEND_API_KEY")).toBe(true);
    expect(isSensitiveKey("SMS_FLY_API_KEY")).toBe(true);
    expect(isSensitiveKey("ANTHROPIC_API_KEY")).toBe(true);
    expect(isSensitiveKey("anthropicApiKey")).toBe(true);
    expect(isSensitiveKey("clientIp")).toBe(true);
    expect(isSensitiveKey("rawPayload")).toBe(true);
    expect(isSensitiveKey("uploadUrl")).toBe(true);
    expect(isSensitiveKey("upload_url")).toBe(true);
    expect(isSensitiveKey("downloadUrl")).toBe(true);
    expect(isSensitiveKey("download_url")).toBe(true);
    expect(isSensitiveKey("pdfDownloadUrl")).toBe(true);
    expect(isSensitiveKey("pdf_download_url")).toBe(true);
    expect(isSensitiveKey("signedDownloadUrl")).toBe(true);
    expect(isSensitiveKey("signed_download_url")).toBe(true);
    expect(isSensitiveKey("payloadDownloadUrl")).toBe(true);
    expect(isSensitiveKey("payload_download_url")).toBe(true);
    expect(isSensitiveKey("objectKey")).toBe(true);
    expect(isSensitiveKey("object_key")).toBe(true);
  });

  it("leaves correlation fields alone", () => {
    expect(isSensitiveKey("request_id")).toBe(false);
    expect(isSensitiveKey("actor_id")).toBe(false);
    expect(isSensitiveKey("company_id")).toBe(false);
    expect(isSensitiveKey("action")).toBe(false);
    expect(isSensitiveKey("channel")).toBe(false);
    expect(isSensitiveKey("outcome")).toBe(false);
    expect(isSensitiveKey("tool_call_id")).toBe(false);
    expect(isSensitiveKey("AI_GATE_MODEL")).toBe(false);
    expect(isSensitiveKey("gateModel")).toBe(false);
  });
});

describe("redactText", () => {
  it("strips passwords out of Postgres and Redis URLs", () => {
    const postgres = redactText(
      `connect postgresql://showzy:${DB_PASSWORD}@localhost:5432/showzy`,
    );
    expect(postgres).toContain("postgresql://showzy:");
    expect(postgres).toContain(REDACTED);
    expect(postgres).not.toContain(DB_PASSWORD);

    const redis = redactText(`redis://:${REDIS_PASSWORD}@localhost:6379/0`);
    expect(redis).toContain(REDACTED);
    expect(redis).not.toContain(REDIS_PASSWORD);
  });

  it("strips Bearer tokens and Sentry DSN userinfo", () => {
    expect(redactText(`Authorization: Bearer ${BEARER}`)).not.toContain(BEARER);
    expect(
      redactText(`https://${SENTRY_KEY}@sentry.example.com/42`),
    ).not.toContain(SENTRY_KEY);
  });

  it("strips AWS/Garage/R2 presign query credentials and leaves the host", () => {
    const signature =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const credential =
      "showzy-local%2F20260824%2Fus-east-1%2Fs3%2Faws4_request";
    const presigned =
      "https://garage.example:3900/showzy/11111111-1111-1111-1111-111111111111/uploads/22222222-2222-2222-2222-222222222222" +
      "?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
      `&X-Amz-Credential=${credential}` +
      "&X-Amz-Date=20260824T100000Z" +
      "&X-Amz-Expires=900" +
      "&X-Amz-SignedHeaders=content-length%3Bhost" +
      `&X-Amz-Signature=${signature}`;

    const redacted = redactText(`mint failed: ${presigned}`);
    expect(redacted).toContain("https://garage.example:3900/showzy/");
    expect(redacted).toContain("X-Amz-Algorithm=AWS4-HMAC-SHA256");
    expect(redacted).not.toContain(signature);
    expect(redacted).not.toContain(credential);
    expect(redacted).toContain(`X-Amz-Signature=${REDACTED}`);
    expect(redacted).toContain(`X-Amz-Credential=${REDACTED}`);
  });
});

describe("redactUnknown", () => {
  it("redacts secrets, OTPs, tokens, PII, raw IPs, and webhook bodies", () => {
    const redacted = redactUnknown({
      request_id: "req-1",
      action: "orders.create",
      actor_id: "user-1",
      company_id: "company-1",
      otp: OTP,
      password: AUTH_SECRET,
      authorization: `Bearer ${BEARER}`,
      cookie: "better-auth.session=abc",
      email: EMAIL,
      phone: PHONE,
      clientIp: RAW_IP,
      rawPayload: { provider: "monobank", body: "PAN 4444333322221111" },
      nested: {
        ipHmacSecret: AUTH_SECRET,
        resendApiKey: AUTH_SECRET,
        anthropicApiKey: AUTH_SECRET,
        ok: true,
      },
    });

    expect(redacted.request_id).toBe("req-1");
    expect(redacted.action).toBe("orders.create");
    expect(redacted.actor_id).toBe("user-1");
    expect(redacted.company_id).toBe("company-1");
    expect(redacted.otp).toBe(REDACTED);
    expect(redacted.password).toBe(REDACTED);
    expect(redacted.authorization).toBe(REDACTED);
    expect(redacted.cookie).toBe(REDACTED);
    expect(redacted.email).toBe(REDACTED);
    expect(redacted.phone).toBe(REDACTED);
    expect(redacted.clientIp).toBe(REDACTED);
    expect(redacted.rawPayload).toBe(REDACTED);
    expect(redacted.nested).toEqual({
      ipHmacSecret: REDACTED,
      resendApiKey: REDACTED,
      anthropicApiKey: REDACTED,
      ok: true,
    });

    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain(OTP);
    expect(serialized).not.toContain(AUTH_SECRET);
    expect(serialized).not.toContain(BEARER);
    expect(serialized).not.toContain(EMAIL);
    expect(serialized).not.toContain(PHONE);
    expect(serialized).not.toContain(RAW_IP);
    expect(serialized).not.toContain("4444333322221111");
  });

  it("censors uploadUrl, downloadUrl, pdfDownloadUrl, signedDownloadUrl, payloadDownloadUrl, and objectKey one and two levels down", () => {
    const signature =
      "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
    const objectKey =
      "11111111-1111-1111-1111-111111111111/catalog/22222222-2222-2222-2222-222222222222";
    const uploadUrl = `https://files.example/showzy/${objectKey}?X-Amz-Signature=${signature}`;
    const downloadUrl = `https://files.example/showzy/${objectKey}?X-Amz-Signature=${signature}`;
    const pdfDownloadUrl = `https://files.example/showzy/${objectKey}?X-Amz-Signature=${signature}`;
    const signedDownloadUrl = `https://files.example/showzy/${objectKey}?X-Amz-Signature=${signature}`;
    const payloadDownloadUrl = `https://files.example/showzy/${objectKey}?X-Amz-Signature=${signature}`;

    const oneLevel = redactUnknown({
      request_id: "req-files",
      uploadUrl,
      downloadUrl,
      pdfDownloadUrl,
      signedDownloadUrl,
      payloadDownloadUrl,
      objectKey,
    });
    expect(oneLevel.request_id).toBe("req-files");
    expect(oneLevel.uploadUrl).toBe(REDACTED);
    expect(oneLevel.downloadUrl).toBe(REDACTED);
    expect(oneLevel.pdfDownloadUrl).toBe(REDACTED);
    expect(oneLevel.signedDownloadUrl).toBe(REDACTED);
    expect(oneLevel.payloadDownloadUrl).toBe(REDACTED);
    expect(oneLevel.objectKey).toBe(REDACTED);

    const twoLevels = redactUnknown({
      extra: {
        result: {
          uploadUrl,
          download_url: downloadUrl,
          pdf_download_url: pdfDownloadUrl,
          signed_download_url: signedDownloadUrl,
          payload_download_url: payloadDownloadUrl,
          object_key: objectKey,
          fileId: "22222222-2222-2222-2222-222222222222",
        },
      },
    });
    expect(twoLevels.extra.result.fileId).toBe(
      "22222222-2222-2222-2222-222222222222",
    );
    expect(twoLevels.extra.result.uploadUrl).toBe(REDACTED);
    expect(twoLevels.extra.result.download_url).toBe(REDACTED);
    expect(twoLevels.extra.result.pdf_download_url).toBe(REDACTED);
    expect(twoLevels.extra.result.signed_download_url).toBe(REDACTED);
    expect(twoLevels.extra.result.payload_download_url).toBe(REDACTED);
    expect(twoLevels.extra.result.object_key).toBe(REDACTED);

    const serialized = JSON.stringify({ oneLevel, twoLevels });
    expect(serialized).not.toContain(signature);
    expect(serialized).not.toContain(objectKey);
    expect(serialized).not.toContain(uploadUrl);
    expect(serialized).not.toContain(downloadUrl);
    expect(serialized).not.toContain(pdfDownloadUrl);
    expect(serialized).not.toContain(signedDownloadUrl);
    expect(serialized).not.toContain(payloadDownloadUrl);
  });

  it("redacts credentials inside Error messages without dropping the Error", () => {
    const error = new Error(
      `migrate failed: postgresql://showzy:${DB_PASSWORD}@localhost:5432/showzy`,
    );
    const redacted = redactUnknown(error);
    expect(redacted).toBeInstanceOf(Error);
    expect(redacted.message).not.toContain(DB_PASSWORD);
    expect(redacted.message).toContain(REDACTED);
  });

  it("keeps AggregateError.errors and redacts credentials inside each nested error", () => {
    const error = new AggregateError(
      [
        new Error(
          `pool close failed: postgresql://showzy:${DB_PASSWORD}@localhost:5432/showzy`,
        ),
        new Error("boss stop failed"),
      ],
      "worker close failed",
    );
    const redacted = redactUnknown(error);
    expect(redacted).toBeInstanceOf(AggregateError);
    expect(redacted.name).toBe("AggregateError");
    expect(redacted.message).toBe("worker close failed");
    const nestedErrors: readonly unknown[] = redacted.errors;
    const originalErrors: readonly unknown[] = error.errors;
    expect(nestedErrors).toHaveLength(2);
    const [first, second] = nestedErrors;
    if (!(first instanceof Error) || !(second instanceof Error)) {
      throw new TypeError(
        "nested errors were not preserved as Error instances",
      );
    }
    expect(first).not.toBe(originalErrors[0]);
    expect(first.message).not.toContain(DB_PASSWORD);
    expect(first.message).toContain(REDACTED);
    expect(first.stack).not.toContain(DB_PASSWORD);
    expect(second.message).toBe("boss stop failed");
  });

  it("redacts an AggregateError listed in its own errors without recursing forever", () => {
    const nested = new Error(
      `pool close failed: postgresql://showzy:${DB_PASSWORD}@localhost:5432/showzy`,
    );
    const error = new AggregateError([nested], "worker close failed");
    error.errors.push(error);
    const redacted = redactUnknown(error);
    expect(redacted).toBeInstanceOf(AggregateError);
    const nestedErrors: readonly unknown[] = redacted.errors;
    expect(nestedErrors).toHaveLength(2);
    const [first, second] = nestedErrors;
    if (!(first instanceof Error)) {
      throw new TypeError("nested error was not preserved as an Error");
    }
    expect(first.message).not.toContain(DB_PASSWORD);
    expect(second).toBe(REDACTED);
  });

  it("redacts an Error set as its own cause without recursing forever", () => {
    const error = new Error(
      `migrate failed: postgresql://showzy:${DB_PASSWORD}@localhost:5432/showzy`,
    );
    error.cause = error;
    const redacted = redactUnknown(error);
    expect(redacted).toBeInstanceOf(Error);
    expect(redacted.message).not.toContain(DB_PASSWORD);
    expect(redacted.cause).toBe(REDACTED);
  });
});

describe("scrubTelemetryEvent", () => {
  it("scrubs a Sentry-shaped payload the same way as a log object", () => {
    const event = scrubTelemetryEvent({
      message: `otp ${OTP} for ${EMAIL}`,
      extra: {
        otp: OTP,
        databaseUrl: `postgresql://showzy:${DB_PASSWORD}@localhost:5432/showzy`,
      },
      request: {
        headers: { authorization: `Bearer ${BEARER}`, cookie: "sid=1" },
        data: { phone: PHONE, action: "account.requestOtp" },
      },
      user: { email: EMAIL, ip_address: RAW_IP, id: "user-1" },
      contexts: { response: { rawBody: "<html>invoice</html>" } },
    });

    expect(event.request.data.action).toBe("account.requestOtp");
    expect(event.user.id).toBe("user-1");
    expect(event.extra.otp).toBe(REDACTED);
    expect(event.extra.databaseUrl).not.toContain(DB_PASSWORD);
    expect(event.request.headers.authorization).toBe(REDACTED);
    expect(event.request.headers.cookie).toBe(REDACTED);
    expect(event.request.data.phone).toBe(REDACTED);
    expect(event.user.email).toBe(REDACTED);
    expect(event.user.ip_address).toBe(REDACTED);
    expect(event.contexts.response.rawBody).toBe(REDACTED);

    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(OTP);
    expect(serialized).not.toContain(EMAIL);
    expect(serialized).not.toContain(BEARER);
    expect(serialized).not.toContain(PHONE);
    expect(serialized).not.toContain(RAW_IP);
    expect(serialized).not.toContain("<html>invoice</html>");
  });
});
