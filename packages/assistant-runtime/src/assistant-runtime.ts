/**
 * The runtime composition of the assistant: real Redis, real actions, real
 * permissions.
 *
 * Everything domain-shaped is assembled here so the HTTP handlers stay about
 * HTTP and `@showzy/assistant-kit` stays about the protocol. It lives in a
 * package rather than in `apps/api` because a turn runs in two processes — the
 * API and the worker (ADR-0039) — and the worker may import only the approved
 * `@showzy/api/subscriptions` subpath, never the API's runtime internals. Who is
 * asking and whether a command was already taken are the request's business and
 * stay in the API. Three things are worth reading.
 *
 * Tools are built per request, not at boot: domain actions run **as the
 * caller**, and which tools are even offered is decided by that caller's
 * permissions — a read against the actor, not a static list.
 *
 * Every action still goes through `executeAction` with `channel: "ai"`, so
 * audit, permissions, timeouts, idempotency and confirmation are exactly what
 * they were. This path changes who calls the domain, not what the domain does.
 *
 * The durable half is built per caller: the transcript and the model history
 * are Postgres, read and written as the person asking. Only the pause and the
 * command receipts are Redis, where a deadline and an atomic claim belong.
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
import {
  ConfirmationRequiredError,
  CoreInvariantError,
} from "@showzy/core/errors";
import type { Redis } from "ioredis";
import type { z } from "zod";

import {
  assistantInteractions,
  type AssistantInteractionTypes,
} from "./assistant-interactions.js";
import { ASSISTANT_INVOCATION_CHANNEL } from "./assistant-invocation.js";
import { AssistantConfirmationRequired } from "./assistant-kit-confirmation.js";
import {
  createResolveAnswer,
  type RunConfirmedAction,
} from "./assistant-kit-resolve.js";
import { assistantKitTurnTools } from "./assistant-kit-tools.js";
import {
  ASSISTANT_CHAT_WINDOW_MESSAGES,
  type AssistantRuntime,
  type AssistantToolContext,
} from "./runtime-types.js";
import {
  createPostgresAssistantKitHistoryStore,
  createPostgresAssistantKitMessageLog,
} from "./stores/assistant-kit-postgres-stores.js";
import { createRedisAssistantKitPauseStore } from "./stores/assistant-kit-stores.js";

type RedisLike = Pick<Redis, "eval" | "get" | "set" | "del">;

export interface CreateAssistantRuntimeOptions {
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

function aiRequest(
  context: Pick<AssistantToolContext, "requestId" | "clientIp">,
) {
  return {
    requestId: context.requestId,
    correlationId: context.requestId,
    channel: ASSISTANT_INVOCATION_CHANNEL,
    // A worker-run turn has no request and so no address; nothing stands in.
    ...(context.clientIp === undefined ? {} : { clientIp: context.clientIp }),
    aiTraceId: context.requestId,
  };
}

function staffPrincipal(
  context: Pick<AssistantToolContext, "userId" | "companySelector">,
) {
  return {
    mode: "staff" as const,
    session: { userId: context.userId },
    companySelector: context.companySelector,
  };
}

export function createAssistantRuntime(
  options: CreateAssistantRuntimeOptions,
): AssistantRuntime {
  // One pause store for the process: a deadline and an atomic claim are Redis
  // work and need no principal. The durable half is built per caller below.
  const pauses = createRedisAssistantKitPauseStore(options.redis);
  const storeDeps = { pipeline: options.pipeline };

  const provider = options.provider ?? anthropicStaffProvider;

  /**
   * Every call the assistant makes into the domain: a tool the model chose, and
   * an action a person confirmed. One function, so the two cannot differ in who
   * the call runs as, what it is audited as, or which key it is idempotent
   * under.
   *
   * A `requiresConfirmation` action refuses its first call with a challenge.
   * The refusal is rethrown with the attempt attached, because this is the only
   * frame that has it — and a resume must present exactly that attempt again,
   * its key above all (SHO-553).
   */
  async function runAction(args: {
    readonly context: AssistantToolContext;
    readonly actionName: string;
    readonly input: unknown;
    readonly confirmed?: {
      readonly idempotencyKey: string;
      readonly challengeId: string;
    };
  }): Promise<unknown> {
    const idempotencyKey =
      args.confirmed?.idempotencyKey ??
      assistantKitIdempotencyKey(args.context, args.actionName);
    try {
      return await executeAction(options.pipeline, {
        action: requireImplementation(options.registry, args.actionName),
        input: args.input,
        request: {
          ...aiRequest(args.context),
          idempotencyKey,
          ...(args.confirmed === undefined
            ? {}
            : { confirmationChallengeId: args.confirmed.challengeId }),
        },
        principal: staffPrincipal(args.context),
      });
    } catch (error) {
      if (error instanceof ConfirmationRequiredError) {
        throw new AssistantConfirmationRequired(
          { actionName: args.actionName, input: args.input, idempotencyKey },
          error.challenge,
        );
      }
      throw error;
    }
  }

  const runConfirmed: RunConfirmedAction = ({
    context,
    actionName,
    input,
    idempotencyKey,
    challengeId,
  }) =>
    runAction({
      context,
      actionName,
      input,
      confirmed: { idempotencyKey, challengeId },
    });

  return {
    logger: options.pipeline.logger,

    /**
     * A kit per request, sharing one pause store.
     *
     * Cheap — a bundle of closures — and the only shape that lets the
     * transcript and the history be read and written as the person asking,
     * through the same pipeline as every other action.
     */
    forCaller(caller) {
      const kit: AssistantKit<AssistantInteractionTypes> = createAssistantKit({
        pauses,
        messages: createPostgresAssistantKitMessageLog(storeDeps, caller),
        clock: { now: () => new Date() },
        ids: { uuid: () => randomUUID() },
        interactions: assistantInteractions,
        window: { messages: ASSISTANT_CHAT_WINDOW_MESSAGES },
        onUnreadableMessage: ({ conversationId, seq }) => {
          // Where it is, never what it said: it is a staff member's words.
          options.pipeline.logger.warn(
            {
              request_id: caller.requestId,
              conversation_id: conversationId,
              seq,
            },
            "assistant message could not be read and was skipped",
          );
        },
      });
      return {
        kit,
        history: createPostgresAssistantKitHistoryStore(storeDeps, caller),
      };
    },

    model: options.model,
    resolveAnswer: createResolveAnswer({ runConfirmed }),

    /**
     * Read through the staff context as the caller, so the answer is the
     * company core verified membership in — never the selector as sent.
     */
    async staffCompany(caller) {
      const actor = await executeAction(options.pipeline, {
        action: getStaffActor,
        input: {},
        request: aiRequest(caller),
        principal: staffPrincipal(caller),
      });
      return actor.companyId;
    },

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
      // The verified membership, not the selector. A tool the caller may not
      // use is never offered, and the pipeline would refuse it anyway.
      const actor = await executeAction(options.pipeline, {
        action: getStaffActor,
        input: {},
        request: aiRequest(context),
        principal: staffPrincipal(context),
      });

      const contracts = filterStaffAiTools(options.registry.contracts(), {
        role: actor.role,
        permissions: actor.permissions,
      });

      const execute: ActionToolExecute = (actionName, input, toolOptions) => {
        void toolOptions;
        return runAction({ context, actionName, input });
      };

      return assistantKitTurnTools(
        staffAssistantTools(contracts, execute),
        options.pipeline.logger,
      );
    },
  };
}
