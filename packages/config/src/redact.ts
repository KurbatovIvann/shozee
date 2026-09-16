/**
 * Shared log/Sentry redaction (fnd-T28, security-operations §4–§6).
 *
 * Structured logs and Sentry events must never carry raw OTPs, tokens,
 * secrets, connection passwords, full documents, raw webhook/payment
 * payloads, unredacted personal input, object keys, or signed object-store
 * URLs. The walker is the authority; pino path lists and Sentry `beforeSend`
 * both run this function.
 */

/** Replacement written in place of a sensitive value. Safe to log. */
export const REDACTED = "[Redacted]";

/**
 * Field names (after lowercasing and stripping `-`/`_`) that are never
 * copied into logs or Sentry payloads. Actor/request/action identifiers
 * used for correlation are intentionally absent.
 */
const SENSITIVE_KEYS = new Set([
  "password",
  "passwd",
  "secret",
  "token",
  "otp",
  "otpcode",
  "verificationcode",
  "authorization",
  "cookie",
  "setcookie",
  "apikey",
  "accesskey",
  "accesskeyid",
  "privatekey",
  "secretaccesskey",
  "creditcard",
  "cardnumber",
  "cvv",
  "cvc",
  "iban",
  "edrpou",
  "phone",
  "phonenumber",
  "email",
  "emailaddress",
  "firstname",
  "lastname",
  "fullname",
  "displayname",
  "dateofbirth",
  "dob",
  "clientip",
  "ipaddress",
  "forwardedfor",
  "xforwardedfor",
  "session",
  "sessionid",
  "bearertoken",
  "authsecret",
  "betterauthsecret",
  "iphmacsecret",
  "sentrydsn",
  "dsn",
  "rawpayload",
  "rawbody",
  "webhookpayload",
  "webhookbody",
  "documenthtml",
  "documentcontent",
  "uploadurl",
  "downloadurl",
  "pdfdownloadurl",
  "signeddownloadurl",
  "payloaddownloadurl",
  "objectkey",
]);

const SENSITIVE_SUFFIXES = [
  "password",
  "secret",
  "token",
  "otp",
  "apikey",
] as const;

/** pino `redact.paths` covering one- and two-level nesting plus headers. */
export const LOG_REDACT_PATHS: readonly string[] = Object.freeze(
  [...SENSITIVE_KEYS].flatMap((key) => [
    key,
    `*.${key}`,
    `*.*.${key}`,
    `headers.${key}`,
    `req.headers.${key}`,
    `request.headers.${key}`,
  ]),
);

export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll(/[-_[\]]/g, "");
  if (SENSITIVE_KEYS.has(normalized)) {
    return true;
  }
  return SENSITIVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

const POSTGRES_URI_USERINFO = /(postgres(?:ql)?):\/\/([^@/\s]+)@/gi;
const REDIS_URI_USERINFO = /(rediss?):\/\/([^@/\s]+)@/gi;
const HTTP_URI_USERINFO = /(https?):\/\/([^@/\s]+)@/gi;

function redactUriUserinfo(value: string, pattern: RegExp): string {
  pattern.lastIndex = 0;
  return value.replaceAll(
    pattern,
    (_match, proto: string, userinfo: string) => {
      const colon = userinfo.indexOf(":");
      if (colon === -1) {
        return `${proto}://${REDACTED}@`;
      }
      const user = userinfo.slice(0, colon);
      return user === ""
        ? `${proto}://:${REDACTED}@`
        : `${proto}://${user}:${REDACTED}@`;
    },
  );
}

/**
 * AWS SigV4 (Garage, R2, S3) and legacy SigV2 query credentials. Host and
 * object path may remain; the bearer signature must not.
 */
function redactPresignedQuery(value: string): string {
  return value.replaceAll(
    /([?&](?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|AWSAccessKeyId|Signature)=)([^&\s"'<>]+)/gi,
    `$1${REDACTED}`,
  );
}

/**
 * Strip credentials out of free-text so a connection string or Bearer
 * token accidentally interpolated into a message still cannot leak.
 */
export function redactText(value: string): string {
  let next = value;
  next = redactUriUserinfo(next, POSTGRES_URI_USERINFO);
  next = redactUriUserinfo(next, REDIS_URI_USERINFO);
  next = redactUriUserinfo(next, HTTP_URI_USERINFO);
  next = next.replaceAll(
    /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
    `Bearer ${REDACTED}`,
  );
  next = next.replaceAll(
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    REDACTED,
  );
  next = next.replaceAll(
    /\b(?:otp|verification[_-]?code)\s*[:=]?\s*\d{4,8}\b/gi,
    `otp ${REDACTED}`,
  );
  return redactPresignedQuery(next);
}

function redactErrorShell(error: Error): Error {
  const message = redactText(error.message);
  if (error instanceof AggregateError) {
    const nestedErrors: readonly unknown[] = error.errors;
    return new AggregateError(
      nestedErrors.map((nested) => redactUnknown(nested)),
      message,
    );
  }
  return new Error(message);
}

function redactError(error: Error): Error {
  const redacted = redactErrorShell(error);
  redacted.name = error.name;
  if (error.stack !== undefined) {
    redacted.stack = redactText(error.stack);
  }
  if (error.cause !== undefined) {
    redacted.cause = redactUnknown(error.cause);
  }
  return redacted;
}

/**
 * Deep-copy `value`, replacing sensitive keys and credential-shaped text.
 * Preserves `Error` instances so pino's `err` serializer still runs.
 */
export function redactUnknown<T>(value: T): T {
  return redactWalk(value, new WeakSet<object>()) as T;
}

function redactWalk(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return redactText(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (value instanceof Error) {
    return redactError(value);
  }
  if (seen.has(value)) {
    return REDACTED;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => redactWalk(entry, seen));
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = isSensitiveKey(key) ? REDACTED : redactWalk(entry, seen);
  }
  return output;
}

/** Sentry `beforeSend` that scrubs the event in place of a copy. */
export function scrubTelemetryEvent<T>(event: T): T {
  return redactUnknown(event);
}
