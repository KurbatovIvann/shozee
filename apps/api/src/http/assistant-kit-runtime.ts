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
  filterStaffAiTools,
  staffAssistantTools,
  type ActionToolExecute,
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
  createRedisAssistantKitDocumentStore,
  createRedisAssistantKitHistoryStore,
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

/** `channel: "ai"` is what marks these calls as assistant-initiated. */
function aiRequest(context: AssistantToolContext, toolCallId?: string) {
  return {
    requestId: context.requestId,
    correlationId: context.requestId,
    channel: ASSISTANT_INVOCATION_CHANNEL,
    clientIp: context.clientIp,
    aiTraceId: context.requestId,
    ...(toolCallId !== undefined ? { toolCallId } : {}),
  };
}

export function createAssistantKitRuntime(
  options: CreateAssistantKitRuntimeOptions,
): AssistantKitRuntime {
  const kit: AssistantKit<AssistantInteractionTypes> = createAssistantKit({
    pauses: createRedisAssistantKitPauseStore(options.redis),
    documents: createRedisAssistantKitDocumentStore(options.redis),
    clock: { now: () => new Date() },
    ids: { uuid: () => randomUUID() },
    interactions: assistantInteractions,
  });

  const history = createRedisAssistantKitHistoryStore(options.redis);

  return {
    auth: options.auth,
    kit,
    model: options.model,
    history,
    resolveAnswer: createResolveAnswer(),

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

      const execute: ActionToolExecute = (actionName, input, toolOptions) =>
        executeAction(options.pipeline, {
          action: requireImplementation(options.registry, actionName),
          input,
          request: aiRequest(context, toolOptions.toolCallId),
          principal,
        });

      return assistantKitTurnTools(staffAssistantTools(contracts, execute));
    },
  };
}
