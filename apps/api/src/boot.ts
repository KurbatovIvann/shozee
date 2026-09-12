/**
 * Process boot: load validated config, open Postgres + Redis, compose
 * better-auth and the action pipeline, return the Hono app. OTP senders are
 * composed from validated `otpDelivery` config (stub or live Resend / SMS Fly).
 * Codes never reach logs (security-operations §2).
 */
import { getConnInfo } from "@hono/node-server/conninfo";
import {
  ASSISTANT_QUEUE_NAME,
  ASSISTANT_QUEUE_PREFIX,
  createRedisAiBudgetStore,
  createRedisAssistantEventHub,
  createRedisAssistantPresence,
  createRedisAssistantStreamSlots,
  logStaffAssistantMount,
  staffAssistantMount,
} from "@showzy/assistant-runtime";
import { Queue } from "bullmq";
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
import { createAssistantKitEvents } from "./http/assistant-kit-events.js";
import { createAssistantKitRuntime } from "./http/assistant-kit-runtime.js";
import { createApp, type AuthInstance } from "./http/app.js";
import { authInstanceFrom } from "./http/auth-instance.js";
import { createProcessObservability } from "./observability.js";
import { createActionPipeline } from "./pipeline.js";
import { createActionRegistry } from "./registry.js";
import {
  createRedisAuthRateLimitStore,
  createRedisConfirmationStore,
  createRedisOtpSendStore,
  createRedisRateLimitStore,
  createRedisSecondaryStorage,
} from "./stores/redis.js";

export interface BootedApi {
  readonly app: ReturnType<typeof createApp>;
  /**
   * Ends every open event stream. Called before the HTTP server's close can
   * finish, which otherwise waits on those connections indefinitely.
   */
  closeStreams(): Promise<void>;
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
  // What is forwarded — a session check's `query` included — is
  // `authInstanceFrom`'s job, and tested there.
  const auth: AuthInstance = authInstanceFrom({
    handler: (request) => authInstance.handler(request),
    getSession: (args) => authInstance.api.getSession(args),
  });

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
  // The same rule and the same log line as the worker's assistant queue: off
  // with AI_ASSISTANT_KIT=0, and off with no model configured.
  const assistantMount = staffAssistantMount(config.ai);
  const staffProvider = assistantMount.provider;
  const assistantKitModel = assistantMount.model;
  logStaffAssistantMount(logger, assistantMount, [
    "POST /assistant/kit/chat",
    "POST /assistant/kit/answer",
    "POST /assistant/kit/abandon",
    "GET /assistant/kit/messages",
    "GET /assistant/kit/events",
  ]);

  // The API is the producer and never a consumer (ADR-0039). On the dedicated
  // queue Redis, which persists and never evicts — never `REDIS_URL`, which
  // holds plaintext OTP codes and is deliberately non-persistent (`db.md` §6).
  // `maxRetriesPerRequest: null` is BullMQ's requirement of its connections.
  const queueRedis =
    assistantKitModel === undefined
      ? undefined
      : new Redis(config.queueRedis.url, { maxRetriesPerRequest: null });
  const assistantQueue =
    queueRedis === undefined
      ? undefined
      : new Queue(ASSISTANT_QUEUE_NAME, {
          connection: queueRedis,
          prefix: ASSISTANT_QUEUE_PREFIX,
        });

  // Pub/sub and presence on the shared, non-persistent Redis: neither needs to
  // survive a restart. The hub subscribes on its own connection, because a
  // Redis connection in subscribe mode can run nothing else.
  const assistantKitEvents =
    assistantKitModel === undefined
      ? undefined
      : createAssistantKitEvents({
          hub: createRedisAssistantEventHub(redis, { logger }),
          presence: createRedisAssistantPresence(redis),
          slots: createRedisAssistantStreamSlots(redis),
        });

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
            ...(assistantQueue === undefined ? {} : { queue: assistantQueue }),
          }),
        }),
    ...(assistantKitEvents === undefined ? {} : { assistantKitEvents }),
    assistantBudget: {
      rateLimitStore,
      budgetStore: createRedisAiBudgetStore(redis, {
        logger: pipeline.logger,
      }),
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
    async closeStreams() {
      await assistantKitEvents?.streams.closeAll();
    },
    async close() {
      closeFilesObjectStore();
      await assistantKitEvents?.hub.close();
      // The queue owns nothing in flight — this process only adds jobs — so
      // closing it is just letting go of its connection.
      await assistantQueue?.close();
      await queueRedis?.quit();
      await redis.quit();
      await db.pool.end();
    },
  };
}
