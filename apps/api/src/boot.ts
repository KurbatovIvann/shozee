/**
 * Process boot: load validated config, open Postgres + Redis, compose
 * better-auth and the action pipeline, return the Hono app. OTP senders are
 * composed from validated `otpDelivery` config (stub or live Resend / SMS Fly).
 * Codes never reach logs (security-operations §2).
 */
import { getConnInfo } from "@hono/node-server/conninfo";
import type { ServerConfig } from "@showzy/config";
import { contractModules } from "@showzy/contract";
import { createDbClient } from "@showzy/db";
import { configureDocumentShareOrigin } from "@showzy/documents/share-origin";
import {
  closeFilesObjectStore,
  configureFilesObjectStore,
  probeFilesObjectStore,
} from "@showzy/files/storage";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { Context } from "hono";
import { Redis } from "ioredis";

import { buildAuthOptions } from "./auth/options.js";
import { otpSendersFromConfig } from "./auth/otp-delivery.js";
import {
  createActionRegistry,
  createStaffAssistantProvider,
} from "./composition.js";
import { optionalStaffAssistantLanguageModel } from "./http/assistant-chat.js";
import { createAssistantKitRuntime } from "./http/assistant-kit-runtime.js";
import { createApp, type AuthInstance } from "./http/app.js";
import { createProcessObservability } from "./observability.js";
import { createActionPipeline } from "./pipeline.js";
import {
  createRedisAiBudgetStore,
  createRedisAuthRateLimitStore,
  createRedisConfirmationStore,
  createRedisConversationLock,
  createRedisOtpSendStore,
  createRedisPendingStore,
  createRedisRateLimitStore,
  createRedisSecondaryStorage,
} from "./stores/redis.js";

export interface BootedApi {
  readonly app: ReturnType<typeof createApp>;
  close(): Promise<void>;
}

function peerAddressFromConnInfo(c: Context): string {
  try {
    const address = getConnInfo(c).remote.address;
    if (address !== undefined && address !== "") {
      return address;
    }
  } catch {
    // Fetch-style invocations have no socket (tests call createApp with
    // their own getPeerAddress instead).
  }
  return "0.0.0.0";
}

export async function bootApi(config: ServerConfig): Promise<BootedApi> {
  configureDocumentShareOrigin(config.auth.url);
  configureFilesObjectStore(config.s3);
  try {
    await probeFilesObjectStore();
  } catch (error) {
    closeFilesObjectStore();
    throw error;
  }
  const { logger, telemetry } = createProcessObservability({
    name: "api",
    sentryDsn: config.sentry.dsn,
  });
  const db = createDbClient({
    databaseUrl: config.database.url,
    onPoolError: (error) => {
      logger.error({ err: error }, "idle postgres pool client error");
    },
  });
  const redis = new Redis(config.redis.url);
  await redis.ping();
  const secondary = createRedisSecondaryStorage(redis);
  const otpSenders = otpSendersFromConfig(config.otpDelivery, { logger });

  const authInstance = betterAuth(
    buildAuthOptions({
      database: drizzleAdapter(db.db, { provider: "pg" }),
      baseUrl: config.auth.url,
      webOrigins: config.auth.webOrigins,
      secret: config.auth.secret,
      sendPhoneOtp: otpSenders.sendPhoneOtp,
      sendEmailOtp: otpSenders.sendEmailOtp,
      otpSendStore: createRedisOtpSendStore(redis),
      authRateLimitStore: createRedisAuthRateLimitStore(redis, {
        ipHmacSecret: config.rateLimit.ipHmacSecret,
      }),
      secondaryStorage: secondary,
    }),
  );
  const auth: AuthInstance = {
    handler: (request) => authInstance.handler(request),
    api: {
      async getSession({ headers }) {
        const result = await authInstance.api.getSession({ headers });
        if (result === null) {
          return null;
        }
        return { user: { id: result.user.id } };
      },
    },
  };

  const rateLimitStore = createRedisRateLimitStore(redis);
  const pipeline = createActionPipeline({
    db: db.db,
    logger,
    telemetry,
    rateLimitStore,
    confirmationStore: createRedisConfirmationStore(redis),
    ipHmacSecret: config.rateLimit.ipHmacSecret,
  });

  const registry = createActionRegistry();
  const staffProvider = createStaffAssistantProvider(config.ai);
  const assistantConfig = {
    model: config.ai.model,
    provider: staffProvider,
    ...(config.ai.anthropicApiKey !== undefined
      ? { anthropicApiKey: config.ai.anthropicApiKey }
      : {}),
  };
  // Off unless AI_ASSISTANT_KIT=1, and off with no model configured: the
  // parallel path is for exercising the protocol on real data, and it has
  // nothing to exercise without a provider.
  //
  // Logged either way. A path that can be off for two different reasons and
  // says nothing is a path you cannot tell is running.
  const assistantKitModel = config.ai.assistantKitEnabled
    ? optionalStaffAssistantLanguageModel(assistantConfig)
    : undefined;
  logger.info(
    {
      enabled: config.ai.assistantKitEnabled,
      mounted: assistantKitModel !== undefined,
      paths:
        assistantKitModel === undefined
          ? []
          : [
              "POST /assistant/kit/chat",
              "POST /assistant/kit/choice",
              "GET /assistant/kit/messages",
            ],
      ...(config.ai.assistantKitEnabled && assistantKitModel === undefined
        ? { reason: "no language model configured" }
        : {}),
    },
    "assistant-kit path",
  );

  const app = createApp({
    auth,
    registry,
    contractModules,
    pipeline,
    trustedProxies: config.trustedProxies,
    getPeerAddress: peerAddressFromConnInfo,
    pkiProxy: {
      rateLimitStore,
      ipHmacSecret: config.rateLimit.ipHmacSecret,
    },
    assistant: assistantConfig,
    ...(assistantKitModel === undefined
      ? {}
      : {
          assistantKit: createAssistantKitRuntime({
            auth,
            registry,
            pipeline,
            model: assistantKitModel,
            provider: staffProvider,
            redis,
          }),
        }),
    pendingStore: createRedisPendingStore(redis),
    conversationLock: createRedisConversationLock(redis),
    assistantBudget: {
      rateLimitStore,
      budgetStore: createRedisAiBudgetStore(redis),
      limits: {
        chatTurnsPerMinutePerUser: config.ai.chatTurnsPerMinutePerUser,
        dailyBudgetUsdPerCompany: config.ai.dailyBudgetUsdPerCompany,
        dailyBudgetUsdGlobal: config.ai.dailyBudgetUsdGlobal,
        unknownModelTurnUsd: config.ai.unknownModelTurnUsd,
      },
    },
  });

  return {
    app,
    async close() {
      closeFilesObjectStore();
      await redis.quit();
      await db.pool.end();
    },
  };
}
