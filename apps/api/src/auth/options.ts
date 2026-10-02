/**
 * The better-auth configuration module (fnd-T6): every security-operations §2
 * parameter is encoded here, once. Runtime mounting — the Hono app, the real
 * Drizzle database, Redis-backed stores, and the SMS/email senders — is
 * composed in `src/boot.ts` (fnd-T26) and must build its instance through
 * this factory so the parameters cannot drift between schema generation,
 * runtime, and tests.
 *
 * OTP codes never persist to Postgres: `secondaryStorage` is a required
 * dependency, and with it configured better-auth keeps all verification
 * values (phone/email OTPs) in that store with a TTL — the generated schema
 * has no `verification` table at all, so OTPs cannot reach database backups
 * or dumps. Sessions
 * are explicitly pinned to Postgres (`storeSessionInDatabase`). Residual
 * accepted risk: phone codes
 * sit plaintext inside the TTL'd secondary store for their 5-minute lifetime
 * (the phone plugin has no `storeOTP`; email codes are additionally hashed).
 */
import { expo } from "@better-auth/expo";
import type { BetterAuthOptions, DBAdapterInstance } from "better-auth/types";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { bearer } from "better-auth/plugins/bearer";
import { emailOTP } from "better-auth/plugins/email-otp";
import { phoneNumber } from "better-auth/plugins/phone-number";
import { z } from "zod";

import type { AuthRateLimitStore } from "../stores/memory.js";
import {
  createOtpSendGuard,
  type OtpChannel,
  type OtpSendStore,
} from "./otp-send-guard.js";
import {
  cookiePolicy,
  expoClientPolicy,
  otpPolicy,
  sessionPolicy,
} from "./policy.js";

export interface AuthComposition {
  /** Database adapter — `drizzleAdapter(db, { provider: "pg" })` at runtime. */
  readonly database: DBAdapterInstance;
  /** From validated config (`BETTER_AUTH_URL`); never read from process.env here. */
  readonly baseUrl: string;
  /**
   * Browser origins of the web panel joining `trustedOrigins` (web-T2,
   * ADR-0030). From validated config (`WEB_APP_ORIGINS`); empty in
   * environments without a web panel. Origin checks only — never a grant.
   */
  readonly webOrigins: readonly string[];
  /** From validated config (`BETTER_AUTH_SECRET`). */
  readonly secret: string;
  /** Delivers a phone OTP (SMS provider at runtime). Never log the code. */
  readonly sendPhoneOtp: (data: {
    phoneNumber: string;
    code: string;
  }) => Promise<void>;
  /** Delivers an email OTP. Never log the code. */
  readonly sendEmailOtp: (data: {
    email: string;
    otp: string;
    type: "sign-in" | "email-verification" | "forget-password" | "change-email";
  }) => Promise<void>;
  /** Backs the per-identifier send limits; Redis at runtime (fnd-T26). */
  readonly otpSendStore: OtpSendStore;
  /**
   * Atomic Better Auth IP / path rate-limit consume (security-operations §2
   * 20/hour per IP for OTP send). Redis Lua INCR+EXPIRE at runtime; in-memory
   * mutex store in tests. Both HMAC the Better Auth key with `IP_HMAC_SECRET`
   * before persist (no 24h rotation). Do not rely on Better Auth's default
   * memory store or secondary-storage get/set (those are racy across replicas).
   */
  readonly authRateLimitStore: AuthRateLimitStore;
  /**
   * Required: keeps OTP codes out of Postgres entirely (verification values
   * live here with a TTL). Redis at runtime (fnd-T26) — implement
   * `getAndDelete` (Redis `GETDEL`) so single-use verification values are
   * consumed atomically across processes. IP send counters use
   * `authRateLimitStore`, not this map.
   */
  readonly secondaryStorage: NonNullable<BetterAuthOptions["secondaryStorage"]>;
  /** Injectable clock for tests. */
  readonly now?: () => number;
}

/**
 * Deterministic placeholder email for phone-only sign-ups: better-auth
 * requires an email per user, and `.invalid` is reserved (RFC 2606) so the
 * placeholder can never be delivered to or registered by anyone.
 */
export function tempEmailForPhone(phone: string): string {
  return `${phone.replaceAll(/\D/g, "")}@phone.invalid`;
}

/** OTP send endpoints subject to the per-identifier guard. */
const otpSendPaths: Readonly<
  Record<string, { channel: OtpChannel; body: z.ZodType<string> }>
> = {
  "/phone-number/send-otp": {
    channel: "phone",
    body: z.object({ phoneNumber: z.string() }).transform((b) => b.phoneNumber),
  },
  "/email-otp/send-verification-otp": {
    channel: "email",
    body: z.object({ email: z.string() }).transform((b) => b.email),
  },
};

/**
 * The return type is deliberately inferred (checked with `satisfies`): the
 * concrete plugin tuple is what lets `betterAuth()` infer the plugin
 * endpoints (`auth.api.sendPhoneNumberOTP`, …) for callers.
 */
export function authTrustedOrigins(composition: {
  readonly baseUrl: string;
  readonly webOrigins: readonly string[];
}): readonly string[] {
  return [
    composition.baseUrl,
    expoClientPolicy.origin,
    ...composition.webOrigins,
  ];
}

export function buildAuthOptions(composition: AuthComposition) {
  const guard = createOtpSendGuard({
    store: composition.otpSendStore,
    ...(composition.now !== undefined ? { now: composition.now } : {}),
  });

  return {
    appName: "showzy",
    baseURL: composition.baseUrl,
    secret: composition.secret,
    database: composition.database,
    trustedOrigins: [...authTrustedOrigins(composition)],
    // OTP codes live here (TTL'd), never in Postgres.
    secondaryStorage: composition.secondaryStorage,
    session: {
      // Sessions stay in Postgres (the `session` table): durable, queryable,
      // and revocable by future admin tooling. Only ephemeral verification
      // values belong in the secondary store. IP send counters use
      // `authRateLimitStore` (atomic consume), not this map.
      storeSessionInDatabase: true,
      expiresIn: sessionPolicy.expiresInSeconds,
      updateAge: sessionPolicy.updateAgeSeconds,
    },
    // No emailAndPassword block: OTP is the only credential flow (ADR-0006),
    // so no password surface exists to attack or to leak account existence.
    plugins: [
      phoneNumber({
        sendOTP: async ({ phoneNumber: phone, code }) => {
          await composition.sendPhoneOtp({ phoneNumber: phone, code });
        },
        otpLength: otpPolicy.length,
        expiresIn: otpPolicy.expirySeconds,
        allowedAttempts: otpPolicy.maxVerifyAttempts,
        // Phone-first sign-up (v1 parity): first successful verification
        // creates the account. Responses stay identical for new and existing
        // phones — no enumeration surface.
        signUpOnVerification: {
          getTempEmail: tempEmailForPhone,
        },
      }),
      emailOTP({
        sendVerificationOTP: async ({ email, otp, type }) => {
          await composition.sendEmailOtp({ email, otp, type });
        },
        otpLength: otpPolicy.length,
        expiresIn: otpPolicy.expirySeconds,
        allowedAttempts: otpPolicy.maxVerifyAttempts,
        /** Email OTPs are hashed at rest (security-operations §2). */
        storeOTP: "hashed",
        // Auto sign-up on first email OTP keeps send responses identical for
        // known and unknown addresses (non-enumeration).
        disableSignUp: false,
      }),
      /** Expo cookie jar + deep-link origin (contract.md §3). */
      expo(),
      /** Bearer remains for non-RN callers (tests, future machine clients). */
      bearer(),
    ],
    hooks: {
      // Runs before OTP creation: enforces the 60-second resend cooldown and
      // the 5 sends/hour per identifier. Uniform error body regardless of
      // which limit tripped.
      before: createAuthMiddleware(async (ctx) => {
        const sendPath = otpSendPaths[ctx.path];
        if (sendPath === undefined) return;
        const identifier = sendPath.body.safeParse(ctx.body);
        // Malformed bodies fall through to endpoint validation.
        if (!identifier.success) return;
        const decision = await guard.check(sendPath.channel, identifier.data);
        if (!decision.allowed) {
          throw new APIError("TOO_MANY_REQUESTS", {
            message: "Too many OTP requests. Please try again later.",
          });
        }
      }),
    },
    rateLimit: {
      // §2 limits apply in every environment, not only NODE_ENV=production.
      enabled: true,
      // Atomic consume is required: with secondaryStorage configured, Better
      // Auth otherwise stores counters via get/set (racy) and warns that
      // storage has no `consume`. Fail closed on store errors — OTP send is
      // public/auth abuse. Never log `key` (the preimage contains the client
      // IP; the store HMACs it before Redis / the in-memory map).
      customStorage: {
        get: () => Promise.resolve(null),
        set: () => Promise.resolve(),
        consume: async (key, rule) => {
          try {
            return await composition.authRateLimitStore.consume(key, rule);
          } catch {
            return {
              allowed: false,
              retryAfter: Math.max(1, rule.window),
            };
          }
        },
      },
      customRules: {
        "/phone-number/send-otp": {
          window: otpPolicy.sendWindowSeconds,
          max: otpPolicy.maxSendsPerHourPerIp,
        },
        "/email-otp/send-verification-otp": {
          window: otpPolicy.sendWindowSeconds,
          max: otpPolicy.maxSendsPerHourPerIp,
        },
      },
    },
    advanced: {
      useSecureCookies: cookiePolicy.secure,
      defaultCookieAttributes: {
        httpOnly: cookiePolicy.httpOnly,
        sameSite: cookiePolicy.sameSite,
      },
    },
  } satisfies BetterAuthOptions;
}
