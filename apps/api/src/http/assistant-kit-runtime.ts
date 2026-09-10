/**
 * The composition root for the `assistant-kit` path: real Redis, real actions,
 * real permissions.
 *
 * Everything domain-shaped is assembled here so the handlers stay about HTTP
 * and the package stays about the protocol. Three things are worth reading.
 *
 * Tools are built per request, not at boot: domain actions run **as the
 * caller**, and which tools are even offered is decided by that caller's
 * permissions — a read against the actor, not a static list.
 *
 * Every action still goes through `executeAction` with `channel: "ai"`, so
 * audit, permissions, timeouts and idempotency are exactly what they were. This
 * path changes who calls the domain, not what the domain does.
 *
 * Model history lives in Redis for now, which is transient by design: a
 * conversation that outlives the ttl starts over. Acceptable while the point is
 * to exercise the protocol by hand, and one port to replace.
 */
import { randomUUID } from "node:crypto";

import {
  anthropicStaffProvider,
  attemptKey,
  filterStaffAiTools,
  staffAssistantSystemMessages,
  staffAssistantTools,
  staffAssistantTurnContextAddendum,
  type ActionToolExecute,
  type StaffProviderAdapter,
} from "@showzy/ai";
import { getStaffActor } from "@showzy/assistant";
import {
  createAssistantKit,
  type AssistantKit,
  type LanguageModel,
  type ToolSet,
} from "@showzy/assistant-kit";
import {
  executeAction,
  type ActionPipelineDeps,
  type ActionRegistry,
  type ImplementedAction,
} from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";
import type { Redis } from "ioredis";
import type { z } from "zod";

import {
  createPostgresAssistantKitDocumentStore,
  createPostgresAssistantKitHistoryStore,
} from "../stores/assistant-kit-postgres-stores.js";
import {
  createRedisAssistantKitCommands,
  createRedisAssistantKitPauseStore,
} from "../stores/assistant-kit-stores.js";
import {
  assistantInteractions,
  type AssistantInteractionTypes,
} from "./assistant-interactions.js";
import { ASSISTANT_INVOCATION_CHANNEL } from "./assistant-invocation.js";
import type {
  AssistantKitRuntime,
  AssistantToolContext,
} from "./assistant-kit-http.js";
import { createResolveAnswer } from "./assistant-kit-resolve.js";
import { assistantKitTurnTools } from "./assistant-kit-tools.js";

type RedisLike = Pick<Redis, "eval" | "get" | "set" | "del">;

export interface CreateAssistantKitRuntimeOptions {
  readonly auth: {
    readonly api: {
      readonly getSession: (args: {
        headers: Headers;
      }) => Promise<{ user: { id: string } } | null>;
    };
  };
  readonly registry: ActionRegistry;
  readonly pipeline: ActionPipelineDeps;
  readonly model: LanguageModel;
  /** Same adapter the live assistant uses: it owns the caching options. */
  readonly provider?: StaffProviderAdapter;
  readonly redis: RedisLike;
}

function requireImplementation(
  registry: ActionRegistry,
  name: string,
): ImplementedAction<z.ZodType, z.ZodType, unknown> {
  const implementation = registry.getImplementation(name);
  if (implementation === undefined) {
    throw new CoreInvariantError(`assistant tool "${name}" is not registered`);
  }
  // The registry erases callback generics; pipeline validation still runs.
  return implementation as ImplementedAction<z.ZodType, z.ZodType, unknown>;
}

/**
 * `channel: "ai"` is what marks these calls as assistant-initiated.
 *
 * Idempotent writes need a key, and it must identify the **attempt**. The
 * provider's `toolCallId` is not that: the model regenerates it, so a retry of
 * the same tap would look like a new write. The client's `commandId` is stable
 * across a retry, so the key is that plus the action.
 *
 * Known limit, stated rather than hidden: two calls to the *same* action in one
 * command share a key, so the second replays the first. One write of a kind per
 * command is the rule that makes this safe, and it is the rule this product
 * wants anyway.
 */
export function assistantKitIdempotencyKey(
  context: Pick<AssistantToolContext, "conversationId" | "commandId">,
  actionName: string,
): string {
  return attemptKey(
    "tool",
    context.conversationId,
    `${context.commandId}:${actionName}`,
  );
}

function aiRequest(context: AssistantToolContext, actionName?: string) {
  return {
    requestId: context.requestId,
    correlationId: context.requestId,
    channel: ASSISTANT_INVOCATION_CHANNEL,
    clientIp: context.clientIp,
    aiTraceId: context.requestId,
    ...(actionName === undefined
      ? {}
      : { idempotencyKey: assistantKitIdempotencyKey(context, actionName) }),
  };
}

export function createAssistantKitRuntime(
  options: CreateAssistantKitRuntimeOptions,
): AssistantKitRuntime {
  // One pause store for the process: a deadline and an atomic claim are Redis
  // work and need no principal. The durable half is built per caller below.
  const pauses = createRedisAssistantKitPauseStore(options.redis);
  const storeDeps = { pipeline: options.pipeline };

  const provider = options.provider ?? anthropicStaffProvider;

  return {
    logger: options.pipeline.logger,
    commands: createRedisAssistantKitCommands(options.redis),
    auth: options.auth,

    /**
     * A kit per request, sharing one pause store.
     *
     * Cheap — a bundle of closures — and the only shape that lets the document
     * and the history be read and written as the person asking, through the
     * same pipeline as every other action.
     */
    forCaller(caller) {
      const kit: AssistantKit<AssistantInteractionTypes> = createAssistantKit({
        pauses,
        documents: createPostgresAssistantKitDocumentStore(storeDeps, caller),
        clock: { now: () => new Date() },
        ids: { uuid: () => randomUUID() },
        interactions: assistantInteractions,
      });
      return {
        kit,
        history: createPostgresAssistantKitHistoryStore(storeDeps, caller),
      };
    },

    model: options.model,
    resolveAnswer: createResolveAnswer(),

    /**
     * The system prompt is not optional decoration: it is the half of the
     * learned behaviour that does not live in a tool description. Running
     * without it fails silently — the assistant simply answers worse.
     *
     * Two messages, not one joined string. The first is static and the provider
     * caches it; folding the turn context into it would change the prefix every
     * turn and throw that cache away.
     */
    prompt: () => ({
      system: staffAssistantSystemMessages(
        staffAssistantTurnContextAddendum({ now: new Date() }),
        provider,
      ),
      providerOptions: provider.replyProviderOptions(),
    }),

    async tools(context): Promise<ToolSet> {
      const principal = {
        mode: "staff" as const,
        session: { userId: context.userId },
        companySelector: context.companySelector,
      };

      // The verified membership, not the selector. A tool the caller may not
      // use is never offered, and the pipeline would refuse it anyway.
      const actor = await executeAction(options.pipeline, {
        action: getStaffActor,
        input: {},
        request: aiRequest(context),
        principal,
      });

      const contracts = filterStaffAiTools(options.registry.contracts(), {
        role: actor.role,
        permissions: actor.permissions,
      });

      const execute: ActionToolExecute = (actionName, input, toolOptions) => {
        void toolOptions;
        return executeAction(options.pipeline, {
          action: requireImplementation(options.registry, actionName),
          input,
          request: aiRequest(context, actionName),
          principal,
        });
      };

      return assistantKitTurnTools(
        staffAssistantTools(contracts, execute),
        options.pipeline.logger,
      );
    },
  };
}
